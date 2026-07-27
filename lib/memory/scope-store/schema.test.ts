import { describe, expect, test } from 'bun:test'
import { openSqlite } from '../sqlite'
import { createDeterministicProvider } from '../embedding/deterministic'
import { EmbeddingIdentityError } from '../embedding/provider'
import { SCHEMA_VERSION, assertIdentity, createSchema, readIdentity } from './schema'

const fresh = (dim = 64) => {
  const provider = createDeterministicProvider(dim)
  const db = openSqlite(':memory:', { create: true })
  createSchema(db, provider)
  return { db, provider }
}

describe('schema', () => {
  test('creates every table', () => {
    const { db } = fresh()
    const names = db
      .prepare("select name from sqlite_master where type in ('table','view') order by name")
      .all()
      .map((r: unknown) => (r as { name: string }).name)
    for (const t of ['meta', 'documents', 'chunks', 'chunks_fts', 'chunks_vec']) {
      expect(names).toContain(t)
    }
    db.close()
  })

  test('writes the provider identity into meta', () => {
    const { db, provider } = fresh(64)
    expect(readIdentity(db)).toEqual({
      model: provider.id,
      dimension: 64,
      schemaVersion: SCHEMA_VERSION,
    })
    db.close()
  })

  test('creates the vector table at the provider dimension, not a constant', () => {
    const { db } = fresh(37)
    const v = new Float32Array(37).fill(1)
    db.prepare('insert into chunks_vec(rowid, embedding) values (?, ?)').run(1, Buffer.from(v.buffer))
    expect(db.prepare('select count(*) as n from chunks_vec').get()).toEqual({ n: 1 })
    db.close()
  })

  test('rejects a vector of the wrong dimension', () => {
    const { db } = fresh(37)
    const wrong = new Float32Array(64).fill(1)
    expect(() =>
      db.prepare('insert into chunks_vec(rowid, embedding) values (?, ?)').run(1, Buffer.from(wrong.buffer)),
    ).toThrow()
    db.close()
  })

  test('assertIdentity passes for the same provider', () => {
    const { db, provider } = fresh(64)
    expect(() => assertIdentity(db, provider)).not.toThrow()
    db.close()
  })

  test('assertIdentity throws when the dimension differs', () => {
    const { db } = fresh(64)
    expect(() => assertIdentity(db, createDeterministicProvider(128))).toThrow(EmbeddingIdentityError)
    db.close()
  })

  test('readIdentity returns null on an empty database', () => {
    const db = openSqlite(':memory:', { create: true })
    expect(readIdentity(db)).toBeNull()
    db.close()
  })

  test('foreign keys cascade from documents to chunks', () => {
    const { db } = fresh()
    db.run("insert into documents(id,title,source_type,created_by,created_at) values ('d1','t','note','u',1)")
    db.run("insert into chunks(id,document_id,ordinal,text,modality) values (1,'d1',0,'hello','text')")
    db.run("delete from documents where id='d1'")
    expect(db.prepare('select count(*) as n from chunks').get()).toEqual({ n: 0 })
    db.close()
  })
})
