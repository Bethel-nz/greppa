import type { Database } from 'bun:sqlite'
import { type EmbeddingProvider, EmbeddingIdentityError } from '../embedding/provider'
import { entityAliasKeys } from './entity'

export const SCHEMA_VERSION = 8

export type ScopeIdentity = { model: string; dimension: number; schemaVersion: number }

export function createSchema(db: Database, provider: EmbeddingProvider): void {
  const priorVersion = readIdentity(db)?.schemaVersion ?? 0

  db.run(`create table if not exists meta(
    key   text primary key,
    value text not null
  )`)

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
    acl_read_principals  text,
    workspace_id         text,
    folder_id            text,
    deleted_at           integer
  )`)

  migrateDocumentsAcl(db)
  if (priorVersion < 6) {
    db.run('update documents set workspace_id = folder_id, folder_id = null where workspace_id is null')
  }
  db.run('create index if not exists documents_by_deleted on documents(deleted_at)')
  createGraphSchema(db, priorVersion, provider)

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
  db.run('create index if not exists documents_by_placement on documents(workspace_id, folder_id)')
  db.run('create index if not exists chunks_by_recency on chunks(last_accessed, created_at)')

  migrateChunksTemporal(db)

  db.run(`create virtual table if not exists chunks_fts using fts5(
    text, content=chunks, content_rowid=id
  )`)

  db.run(`create virtual table if not exists chunks_vec using vec0(
    embedding float[${provider.dimension}]
  )`)

  writeIdentity(db, provider)
}

function createGraphSchema(db: Database, priorVersion: number, provider: EmbeddingProvider): void {
  db.run(`create table if not exists memory_nodes(
    id          text primary key,
    label       text not null,
    created_at  integer not null
  )`)
  db.run(`create table if not exists memory_edges(
    id             text primary key,
    source_node_id text not null references memory_nodes(id) on delete cascade,
    target_node_id text not null references memory_nodes(id) on delete cascade,
    relation       text not null,
    weight         real not null default 1,
    document_id    text not null references documents(id) on delete cascade,
    created_at     integer not null,
    unique(source_node_id, target_node_id, relation, document_id)
  )`)
  db.run('create index if not exists memory_edges_by_source on memory_edges(source_node_id)')
  db.run('create index if not exists memory_edges_by_target on memory_edges(target_node_id)')
  db.run('create index if not exists memory_edges_by_document on memory_edges(document_id)')

  createEntityIndex(db)
  if (priorVersion < 7) backfillEntityIndex(db)

  // Semantic tier for entity resolution: a label vector per node, keyed by the
  // node's rowid. Backfilling existing labels would need embedding calls, which
  // are async and can't run inside this synchronous migration — so the table is
  // created empty and populated as nodes are written. Older nodes keep exact +
  // trigram matching until they're touched again or the scope is re-embedded.
  db.run(`create virtual table if not exists memory_nodes_vec using vec0(
    embedding float[${provider.dimension}]
  )`)
}

/**
 * Lookup surfaces for entity names. A node keeps the id it was created with;
 * every other spelling reaches it through an alias row, and near-misses are
 * found by trigram search over labels rather than a full-table LIKE scan.
 *
 * alias_key is not unique on its own: two labels that fold to the same key
 * ("Acme" and "Acme Corp") both keep their own node and both answer to it,
 * which unions them at query time without rewriting anyone's edges.
 */
function createEntityIndex(db: Database): void {
  db.run(`create table if not exists memory_node_aliases(
    alias_key   text not null,
    node_id     text not null references memory_nodes(id) on delete cascade,
    created_at  integer not null,
    primary key(alias_key, node_id)
  )`)
  db.run('create index if not exists memory_node_aliases_by_node on memory_node_aliases(node_id)')
  db.run(`create virtual table if not exists memory_nodes_fts using fts5(
    node_id unindexed, label, tokenize='trigram'
  )`)
}

function backfillEntityIndex(db: Database): void {
  const nodes = db.prepare('select id, label, created_at from memory_nodes').all() as Array<{
    id: string
    label: string
    created_at: number
  }>
  if (nodes.length === 0) return

  const insertAlias = db.prepare(
    `insert into memory_node_aliases(alias_key, node_id, created_at) values (?,?,?)
     on conflict(alias_key, node_id) do nothing`,
  )
  const clearFts = db.prepare('delete from memory_nodes_fts where node_id = ?')
  const insertFts = db.prepare('insert into memory_nodes_fts(node_id, label) values (?,?)')

  db.transaction(() => {
    for (const node of nodes) {
      for (const key of entityAliasKeys(node.label)) insertAlias.run(key, node.id, node.created_at)
      clearFts.run(node.id)
      insertFts.run(node.id, node.label)
    }
  })()
}

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
    ['workspace_id', 'text'],
    ['folder_id', 'text'],
    ['deleted_at', 'integer'],
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
