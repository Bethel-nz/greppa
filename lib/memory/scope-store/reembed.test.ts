import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDeterministicProvider } from '../embedding/deterministic'
import { EmbeddingIdentityError } from '../embedding/provider'
import { openSqlite } from '../sqlite'
import { SCHEMA_VERSION, readIdentity } from './schema'
import { hybridSearch, insertDocument, openScopeStore } from './store'
import { reembedScope } from './reembed'

const dirs: string[] = []
const tmpPath = () => {
  const d = mkdtempSync(join(tmpdir(), 'reembed-'))
  dirs.push(d)
  return join(d, 'm.sqlite')
}
const cleanup = () => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }) }

describe('reembedScope', () => {
  test('migrates to a new provider at a different dimension, preserving content', async () => {
    const path = tmpPath()
    const oldProvider = createDeterministicProvider(64)
    const store = openScopeStore(path, { provider: oldProvider, create: true })
    for (const t of ['alpha beta gamma', 'delta epsilon zeta']) {
      const [embedding] = await oldProvider.embed([t], 'document')
      insertDocument(store, { title: t, text: t, sourceType: 'note', createdBy: 'u1', chunks: [{ text: t, embedding: embedding! }] })
    }
    store.close()

    const newProvider = createDeterministicProvider(256)
    const db = openSqlite(path, { create: false })
    const migrated = await reembedScope(db, newProvider)
    expect(migrated).toBe(2)
    expect(readIdentity(db)).toEqual({ model: newProvider.id, dimension: 256, schemaVersion: SCHEMA_VERSION })
    db.close()

    const reopened = openScopeStore(path, { provider: newProvider, create: false })
    expect(reopened.db.prepare('select count(*) as n from documents').get()).toEqual({ n: 2 })
    const [qv] = await newProvider.embed(['alpha beta gamma'], 'query')
    expect(hybridSearch(reopened, 'alpha beta gamma', qv!, 2)[0]!.title).toBe('alpha beta gamma')
    reopened.close()
    cleanup()
  })

  test('the old provider can no longer open the migrated file', async () => {
    const path = tmpPath()
    const oldProvider = createDeterministicProvider(64)
    const store = openScopeStore(path, { provider: oldProvider, create: true })
    const [embedding] = await oldProvider.embed(['x'], 'document')
    insertDocument(store, { title: 'x', text: 'x', sourceType: 'note', createdBy: 'u1', chunks: [{ text: 'x', embedding: embedding! }] })
    store.close()

    const db = openSqlite(path, { create: false })
    await reembedScope(db, createDeterministicProvider(256))
    db.close()

    expect(() => openScopeStore(path, { provider: oldProvider, create: false, readonly: true })).toThrow(EmbeddingIdentityError)
    cleanup()
  })

  test('preserves lexical search across the migration', async () => {
    const path = tmpPath()
    const oldProvider = createDeterministicProvider(64)
    const store = openScopeStore(path, { provider: oldProvider, create: true })
    const text = 'incident GRP4821 traced to hydration'
    const [embedding] = await oldProvider.embed([text], 'document')
    insertDocument(store, { title: 'ticket', text, sourceType: 'note', createdBy: 'u1', chunks: [{ text, embedding: embedding! }] })
    store.close()

    const newProvider = createDeterministicProvider(128)
    const db = openSqlite(path, { create: false })
    await reembedScope(db, newProvider)
    db.close()

    const reopened = openScopeStore(path, { provider: newProvider, create: false, readonly: true })
    const [qv] = await newProvider.embed(['grp4821'], 'query')
    expect(hybridSearch(reopened, 'grp4821', qv!, 3)[0]!.title).toBe('ticket')
    reopened.close()
    cleanup()
  })

  test('is a no-op returning 0 on an empty scope', async () => {
    const path = tmpPath()
    const store = openScopeStore(path, { provider: createDeterministicProvider(64), create: true })
    store.close()
    const db = openSqlite(path, { create: false })
    expect(await reembedScope(db, createDeterministicProvider(128))).toBe(0)
    db.close()
    cleanup()
  })

  test('refuses to silently drop an image chunk it cannot re-embed', async () => {
    const path = tmpPath()
    const provider = createDeterministicProvider(64)
    const store = openScopeStore(path, { provider, create: true })
    const [embedding] = await provider.embed(['img'], 'document')
    insertDocument(store, {
      title: 'shot', text: '', sourceType: 'document', createdBy: 'u1',
      chunks: [{ text: '', embedding: embedding!, modality: 'image', assetSha256: 'abc', assetMime: 'image/png' }],
    })
    store.close()

    const db = openSqlite(path, { create: false })
    await expect(reembedScope(db, createDeterministicProvider(128))).rejects.toThrow(/cannot re-embed/)
    db.close()
    cleanup()
  })
})
