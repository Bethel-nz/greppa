import type { Database } from 'bun:sqlite'
import { type EmbeddingProvider, EmbeddingIdentityError } from '../embedding/provider'

export const SCHEMA_VERSION = 3

export type ScopeIdentity = { model: string; dimension: number; schemaVersion: number }

/**
 * Create every table. The vector table's dimension comes from the provider and
 * is fixed for the life of the file: vec0 cannot be altered in place, so
 * changing providers means reembedScope() drops and recreates it.
 */
export function createSchema(db: Database, provider: EmbeddingProvider): void {
  db.run(`create table if not exists meta(
    key   text primary key,
    value text not null
  )`)

  // ACL columns carry the model Memvid used to enforce at query time. One file
  // per scope already makes cross-tenant leakage structurally impossible; these
  // preserve *within*-scope visibility, which physical separation cannot.
  // Arrays are stored as JSON text and matched with json_each() at query time.
  db.run(`create table if not exists documents(
    id                   text primary key,
    title                text not null,
    source_type          text not null,
    source_url           text,
    created_by           text not null,
    created_at           integer not null,
    meta_json            text,
    acl_tenant_id        text,
    acl_visibility       text not null default 'public',
    acl_read_roles       text,
    acl_read_groups      text,
    acl_read_principals  text
  )`)

  migrateDocumentsAcl(db)

  // created_at / last_accessed / access_count drive temporal weighting. They
  // live on chunks rather than documents because retrieval and reinforcement
  // both happen at chunk granularity — one paragraph of a document can stay
  // hot while the rest of it goes cold.
  db.run(`create table if not exists chunks(
    id            integer primary key,
    document_id   text not null references documents(id) on delete cascade,
    ordinal       integer not null,
    text          text not null,
    modality      text not null,
    asset_sha256  text,
    asset_mime    text,
    created_at    integer not null default 0,
    last_accessed integer,
    access_count  integer not null default 0
  )`)
  db.run('create index if not exists chunks_by_document on chunks(document_id)')
  db.run('create index if not exists chunks_by_recency on chunks(last_accessed, created_at)')

  migrateChunksTemporal(db)

  // External-content FTS5: the text lives in `chunks`, not duplicated here.
  // Rows must be inserted explicitly, and deletes need the 'delete' command.
  db.run(`create virtual table if not exists chunks_fts using fts5(
    text, content=chunks, content_rowid=id
  )`)

  db.run(`create virtual table if not exists chunks_vec using vec0(
    embedding float[${provider.dimension}]
  )`)

  writeIdentity(db, provider)
}

/**
 * Add the v3 temporal columns to a v2 `chunks` table. Existing rows get
 * created_at = 0, which reads as "maximally old" — deliberately conservative,
 * since backfilling a plausible timestamp would be inventing data. With decay
 * disabled (the default) it changes nothing.
 */
function migrateChunksTemporal(db: Database): void {
  const existing = new Set(
    (db.prepare('pragma table_info(chunks)').all() as Array<{ name: string }>).map((c) => c.name),
  )
  const columns: Array<[string, string]> = [
    ['created_at', 'integer not null default 0'],
    ['last_accessed', 'integer'],
    ['access_count', 'integer not null default 0'],
  ]
  for (const [name, type] of columns) {
    if (!existing.has(name)) db.run(`alter table chunks add column ${name} ${type}`)
  }
}

/**
 * Add the v2 ACL columns to a v1 `documents` table. Files written before the
 * ACL port default to `public` visibility, which preserves their existing
 * behaviour: nothing was filtering them before either.
 */
function migrateDocumentsAcl(db: Database): void {
  const existing = new Set(
    (db.prepare('pragma table_info(documents)').all() as Array<{ name: string }>).map((c) => c.name),
  )
  const columns: Array<[string, string]> = [
    ['acl_tenant_id', 'text'],
    ['acl_visibility', "text not null default 'public'"],
    ['acl_read_roles', 'text'],
    ['acl_read_groups', 'text'],
    ['acl_read_principals', 'text'],
  ]
  for (const [name, type] of columns) {
    if (!existing.has(name)) db.run(`alter table documents add column ${name} ${type}`)
  }
}

export function writeIdentity(db: Database, provider: EmbeddingProvider): void {
  const put = db.prepare(
    'insert into meta(key, value) values (?, ?) on conflict(key) do update set value = excluded.value',
  )
  put.run('schema_version', String(SCHEMA_VERSION))
  put.run('embedding_model', provider.id)
  put.run('embedding_dim', String(provider.dimension))
  if (!db.prepare("select 1 from meta where key = 'created_at'").get()) {
    put.run('created_at', String(Date.now()))
  }
}

export function readIdentity(db: Database): ScopeIdentity | null {
  const has = db.prepare("select name from sqlite_master where type='table' and name='meta'").get()
  if (!has) return null
  const rows = db.prepare('select key, value from meta').all() as Array<{ key: string; value: string }>
  const m = new Map(rows.map((r) => [r.key, r.value]))
  const model = m.get('embedding_model')
  const dim = m.get('embedding_dim')
  if (!model || !dim) return null
  return { model, dimension: Number(dim), schemaVersion: Number(m.get('schema_version') ?? '0') }
}

/**
 * Refuse to query across embedding models. Comparing a query vector from model
 * A against document vectors from model B returns plausible-looking nonsense
 * rather than an error, so this check is the only thing standing between a
 * misconfiguration and silently wrong memories.
 */
export function assertIdentity(db: Database, provider: EmbeddingProvider): void {
  const identity = readIdentity(db)
  if (!identity) return
  if (identity.model !== provider.id || identity.dimension !== provider.dimension) {
    throw new EmbeddingIdentityError(
      `${identity.model}@${identity.dimension}`,
      `${provider.id}@${provider.dimension}`,
    )
  }
}
