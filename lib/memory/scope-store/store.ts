import type { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { type EmbeddingProvider, l2normalize } from '../embedding/provider'
import { openSqlite } from '../sqlite'
import { entityAliasKeys, legacyEntityKey } from './entity'
import { reciprocalRankFusion } from './fusion'
import { assertIdentity, createSchema, readIdentity } from './schema'
import { DECAY_OFF, applyDecay, type DecayConfig } from './decay'

export const CANDIDATE_DEPTH = 50
/** Ceiling for the widen-and-retry loop when a filter thins the candidate pool. */
export const MAX_CANDIDATE_DEPTH = CANDIDATE_DEPTH * 32
export const GRAPH_HOPS = 2
export const GRAPH_ENTITY_WINDOW = 3
export const GRAPH_WEIGHT = 2
/**
 * How far a node label vector may sit from the query before it stops counting as
 * a semantic entity candidate. Node vectors and query vectors are l2-normalized,
 * so this is L2 distance: 0.9 keeps neighbours with cosine similarity above ~0.6.
 */
export const NODE_SEMANTIC_MAX_DISTANCE = 0.9

export type ScopeStore = { db: Database; provider: EmbeddingProvider; close(): void }

export type ChunkInput = {
  text: string
  embedding: Float32Array
  modality?: 'text' | 'image' | 'text_image'
  assetSha256?: string
  assetMime?: string
}

export type MemoryEdgeInput = {
  source: string
  target: string
  relation: string
  weight?: number
}

export type MemoryEdge = MemoryEdgeInput & {
  documentId: string
  documentTitle: string
  createdAt: number
}

export type DocumentAcl = {
  tenantId?: string
  visibility?: 'public' | 'restricted'
  readRoles?: string[]
  readGroups?: string[]
  readPrincipals?: string[]
}

export type AclContext = {
  tenantId?: string
  subjectId: string
  roles?: string[]
  groupIds?: string[]
}

export type InsertDocumentInput = {
  id?: string
  title: string
  text: string
  sourceType: string
  sourceUrl?: string
  createdBy: string
  meta?: Record<string, unknown>
  acl?: DocumentAcl
  workspaceId?: string | null
  folderId?: string | null
  edges?: MemoryEdgeInput[]
  /** Label vectors for the edges' nodes, keyed by node id (see distinctEdgeNodes). */
  nodeVectors?: NodeVectors
  chunks: ChunkInput[]
}

/** Label embeddings for graph nodes, keyed by the node id nodeIdFor() derives. */
export type NodeVectors = Map<string, Float32Array>

export type SearchHit = {
  chunkId: number
  documentId: string
  title: string
  text: string
  sourceType: string
  sourceUrl: string | null
  modality: string
  assetSha256: string | null
  score: number
}

export function openScopeStore(
  path: string,
  opts: { provider: EmbeddingProvider; create: boolean; readonly?: boolean },
): ScopeStore {
  const db = openSqlite(path, { create: opts.create, readonly: opts.readonly })
  try {
    const existing = readIdentity(db)
    if (existing) {
      assertIdentity(db, opts.provider)
      if (!opts.readonly) createSchema(db, opts.provider)
    } else if (!opts.readonly) {
      createSchema(db, opts.provider)
    }
  } catch (err) {
    db.close()
    throw err
  }
  return { db, provider: opts.provider, close: () => db.close() }
}

const toBlob = (v: Float32Array): Buffer => Buffer.from(v.buffer, v.byteOffset, v.byteLength)

const normalizeAcl = (values: string[]): string[] =>
  values.map((v) => v.trim().toLowerCase()).filter(Boolean)

export type MemoryScope = {
  workspaceId?: string | null
  folderId?: string | null
}

function placementClauses(scope: MemoryScope = {}): { clauses: string[]; params: string[] } {
  const clauses: string[] = []
  const params: string[] = []

  for (const [column, value] of [
    ['workspace_id', scope.workspaceId],
    ['folder_id', scope.folderId],
  ] as const) {
    if (value === undefined) continue
    if (value === null) clauses.push(`d.${column} is null`)
    else {
      clauses.push(`d.${column} = ?`)
      params.push(value)
    }
  }

  return { clauses, params }
}

function aclPredicate(acl: AclContext): { sql: string; params: string[] } {
  const params: string[] = []
  const clauses: string[] = ["d.acl_visibility = 'public'"]

  clauses.push('exists (select 1 from json_each(coalesce(d.acl_read_principals, \'[]\')) where value = ?)')
  params.push(normalizeAcl([acl.subjectId])[0] ?? '')

  for (const [column, values] of [
    ['acl_read_roles', acl.roles ?? []],
    ['acl_read_groups', acl.groupIds ?? []],
  ] as const) {
    const normalized = normalizeAcl([...values])
    if (normalized.length === 0) continue
    const placeholders = normalized.map(() => '?').join(',')
    clauses.push(
      `exists (select 1 from json_each(coalesce(d.${column}, '[]')) where value in (${placeholders}))`,
    )
    params.push(...normalized)
  }

  let sql = `(${clauses.join(' or ')})`
  if (acl.tenantId) {
    sql = `(d.acl_tenant_id is null or d.acl_tenant_id = ?) and ${sql}`
    params.unshift(acl.tenantId)
  }
  return { sql, params }
}

export function documentExists(store: ScopeStore, id: string): boolean {
  return store.db.prepare('select 1 from documents where id = ?').get(id) != null
}

export function insertDocument(store: ScopeStore, input: InsertDocumentInput): string {
  const { db } = store
  const documentId = input.id ?? crypto.randomUUID()

  if (input.id && db.prepare('select id from documents where id = ?').get(documentId)) {
    return documentId
  }

  const insertDoc = db.prepare(
    `insert into documents(
       id,title,source_type,source_url,created_by,created_at,meta_json,
       acl_tenant_id,acl_visibility,acl_read_roles,acl_read_groups,acl_read_principals,
       workspace_id,folder_id
     ) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  )
  const insertChunk = db.prepare(
    `insert into chunks(document_id,ordinal,text,modality,asset_sha256,asset_mime,created_at,access_count)
     values (?,?,?,?,?,?,?,0)`,
  )
  const insertFts = db.prepare('insert into chunks_fts(rowid, text) values (?, ?)')
  const insertVec = db.prepare('insert into chunks_vec(rowid, embedding) values (?, ?)')

  const now = Date.now()
  const run = db.transaction(() => {
    const acl = input.acl
    insertDoc.run(
      documentId,
      input.title,
      input.sourceType,
      input.sourceUrl ?? null,
      input.createdBy,
      now,
      input.meta ? JSON.stringify(input.meta) : null,
      acl?.tenantId ?? null,
      acl?.visibility ?? 'public',
      acl?.readRoles ? JSON.stringify(normalizeAcl(acl.readRoles)) : null,
      acl?.readGroups ? JSON.stringify(normalizeAcl(acl.readGroups)) : null,
      acl?.readPrincipals ? JSON.stringify(normalizeAcl(acl.readPrincipals)) : null,
      input.workspaceId ?? null,
      input.folderId ?? null,
    )
    for (let i = 0; i < input.chunks.length; i++) {
      const c = input.chunks[i]!
      if (c.embedding.length !== store.provider.dimension) {
        throw new Error(
          `[scope-store] chunk ${i} has dimension ${c.embedding.length}, expected ${store.provider.dimension}`,
        )
      }
      const res = insertChunk.run(
        documentId,
        i,
        c.text,
        c.modality ?? 'text',
        c.assetSha256 ?? null,
        c.assetMime ?? null,
        now,
      )
      const chunkId = Number(res.lastInsertRowid)
      if (c.text.trim()) insertFts.run(chunkId, c.text)
      insertVec.run(chunkId, toBlob(c.embedding))
    }

    insertMemoryEdges(db, documentId, input.edges ?? [], input.nodeVectors, store.provider.dimension)
  })

  run()
  return documentId
}

/**
 * The distinct nodes an edge set touches, one entry per node id with the label
 * to embed. Callers embed these labels (async, outside the write transaction)
 * and hand the vectors back through InsertDocumentInput.nodeVectors.
 */
export function distinctEdgeNodes(edges: MemoryEdgeInput[]): Array<{ id: string; label: string }> {
  const seen = new Map<string, string>()
  for (const edge of edges) {
    const source = edge.source.trim()
    const target = edge.target.trim()
    if (source) seen.set(nodeIdFor(source), source)
    if (target) seen.set(nodeIdFor(target), target)
  }
  return [...seen].map(([id, label]) => ({ id, label }))
}

function stableId(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/** Node ids are derived from the legacy key so ids already on disk stay valid. */
function nodeIdFor(label: string): string {
  return `node:${stableId(legacyEntityKey(label))}`
}

function hasEntityIndex(db: Database): boolean {
  return Boolean(
    db
      .prepare("select 1 from sqlite_master where type = 'table' and name = 'memory_node_aliases'")
      .get(),
  )
}

function hasNodeVectors(db: Database): boolean {
  return Boolean(
    db
      .prepare("select 1 from sqlite_master where type = 'table' and name = 'memory_nodes_vec'")
      .get(),
  )
}

/**
 * A readonly open never migrates, so a scope file written before tombstones
 * existed has no deleted_at to filter on. Nothing in it was ever deleted.
 */
function hasDeletedAt(db: Database): boolean {
  return (db.prepare('pragma table_info(documents)').all() as Array<{ name: string }>).some(
    (c) => c.name === 'deleted_at',
  )
}

const LIVE_ONLY = 'd.deleted_at is null'

function insertMemoryEdges(
  db: Database,
  documentId: string,
  edges: MemoryEdgeInput[],
  nodeVectors?: NodeVectors,
  dimension?: number,
): void {
  if (edges.length === 0) return

  const insertNode = db.prepare(
    'insert into memory_nodes(id,label,created_at) values (?,?,?) on conflict(id) do update set label = excluded.label',
  )
  const insertAlias = db.prepare(
    `insert into memory_node_aliases(alias_key,node_id,created_at) values (?,?,?)
     on conflict(alias_key,node_id) do nothing`,
  )
  const clearFts = db.prepare('delete from memory_nodes_fts where node_id = ?')
  const insertFts = db.prepare('insert into memory_nodes_fts(node_id,label) values (?,?)')

  // The vector tier is optional: absent on older scope files, and only worth
  // touching when the caller actually supplied label vectors.
  const vecEnabled = Boolean(nodeVectors?.size) && hasNodeVectors(db)
  const rowidOf = db.prepare('select rowid as rowid from memory_nodes where id = ?')
  const hasVec = db.prepare('select 1 from memory_nodes_vec where rowid = ?')
  const insertVec = db.prepare('insert into memory_nodes_vec(rowid, embedding) values (?, ?)')

  const upsertNode = (id: string, label: string, at: number): void => {
    insertNode.run(id, label, at)
    for (const key of entityAliasKeys(label)) insertAlias.run(key, id, at)
    clearFts.run(id)
    insertFts.run(id, label)

    if (!vecEnabled) return
    const vector = nodeVectors!.get(id)
    if (!vector) return
    if (dimension !== undefined && vector.length !== dimension) {
      throw new Error(
        `[scope-store] node vector for ${label} has dimension ${vector.length}, expected ${dimension}`,
      )
    }
    const rowid = Number((rowidOf.get(id) as { rowid: number }).rowid)
    // A node keeps its first vector; a later mention of the same entity is not
    // worth re-embedding, and re-inserting would violate the vec table's rowid.
    if (hasVec.get(rowid)) return
    insertVec.run(rowid, toBlob(l2normalize(vector)))
  }

  const insertEdge = db.prepare(
    `insert into memory_edges(
       id,source_node_id,target_node_id,relation,weight,document_id,created_at
     ) values (?,?,?,?,?,?,?) on conflict(source_node_id,target_node_id,relation,document_id) do nothing`,
  )
  const now = Date.now()

  for (const edge of edges) {
    const source = edge.source.trim()
    const target = edge.target.trim()
    const relation = edge.relation.trim()
    if (!source || !target || !relation) {
      throw new Error('[scope-store] graph edges need a source, target, and relation')
    }
    if (edge.weight !== undefined && (!Number.isFinite(edge.weight) || edge.weight <= 0)) {
      throw new Error('[scope-store] edge weight must be a positive finite number')
    }

    const sourceId = nodeIdFor(source)
    const targetId = nodeIdFor(target)
    upsertNode(sourceId, source, now)
    upsertNode(targetId, target, now)
    insertEdge.run(
      `edge:${stableId(`${documentId}\n${sourceId}\n${relation.toLocaleLowerCase()}\n${targetId}`)}`,
      sourceId,
      targetId,
      relation,
      edge.weight ?? 1,
      documentId,
      now,
    )
  }
}

function hasGraph(db: Database): boolean {
  return Boolean(
    db.prepare("select 1 from sqlite_master where type = 'table' and name = 'memory_edges'").get(),
  )
}

export function listMemoryEdges(
  store: ScopeStore,
  options: {
    entity?: string
    relation?: string
    documentIds?: string[]
    scope?: MemoryScope
    limit?: number
  } = {},
): MemoryEdge[] {
  if (!hasGraph(store.db)) return []

  const clauses: string[] = []
  const params: string[] = []

  if (hasDeletedAt(store.db)) clauses.push(LIVE_ONLY)

  if (options.entity?.trim()) {
    const nodeIds = nodeIdsForPhrases(store.db, [options.entity.trim()])
    if (nodeIds.length === 0) return []
    const placeholders = nodeIds.map(() => '?').join(',')
    clauses.push(`(e.source_node_id in (${placeholders}) or e.target_node_id in (${placeholders}))`)
    params.push(...nodeIds, ...nodeIds)
  }
  if (options.relation?.trim()) {
    clauses.push('lower(e.relation) = lower(?)')
    params.push(options.relation.trim())
  }
  const placement = placementClauses(options.scope)
  clauses.push(...placement.clauses)
  params.push(...placement.params)
  if (options.documentIds?.length) {
    clauses.push(`e.document_id in (${options.documentIds.map(() => '?').join(',')})`)
    params.push(...options.documentIds)
  }

  const where = clauses.length ? `where ${clauses.join(' and ')}` : ''
  const limit = Math.min(Math.max(options.limit ?? 25, 1), 100)
  return store.db
    .prepare(
      `select source.label as source, target.label as target, e.relation as relation,
              e.weight as weight, e.document_id as documentId, d.title as documentTitle,
              e.created_at as createdAt
         from memory_edges e
         join memory_nodes source on source.id = e.source_node_id
         join memory_nodes target on target.id = e.target_node_id
         join documents d on d.id = e.document_id
         ${where}
         order by e.created_at desc
         limit ?`,
    )
    .all(...params, limit) as MemoryEdge[]
}

export type StoredFact = { documentId: string; title: string; text: string; createdAt: number }

export function listFacts(
  store: ScopeStore,
  options: {
    sourceType?: string
    limit?: number
    scope?: MemoryScope
    acl?: AclContext
  } = {},
): StoredFact[] {
  const { db } = store
  const clauses = ['d.source_type = ?']
  const params: Array<string | number> = [options.sourceType ?? 'fact']

  if (hasDeletedAt(db)) clauses.push(LIVE_ONLY)

  const placement = placementClauses(options.scope)
  clauses.push(...placement.clauses)
  params.push(...placement.params)

  if (options.acl) {
    const p = aclPredicate(options.acl)
    clauses.push(p.sql)
    params.push(...p.params)
  }

  const rows = db
    .prepare(
      `select d.id as documentId, d.title as title, d.created_at as createdAt,
              c.ordinal as ordinal, c.text as text
         from documents d join chunks c on c.document_id = d.id
        where d.id in (
          select id from documents d where ${clauses.join(' and ')}
          order by created_at desc limit ?
        )
        order by d.created_at desc, c.ordinal asc`,
    )
    .all(...params, options.limit ?? 40) as Array<StoredFact & { ordinal: number }>

  const byDocument = new Map<string, StoredFact>()
  for (const row of rows) {
    const existing = byDocument.get(row.documentId)
    if (existing) existing.text += ` ${row.text}`
    else byDocument.set(row.documentId, {
      documentId: row.documentId,
      title: row.title,
      text: row.text,
      createdAt: row.createdAt,
    })
  }
  return [...byDocument.values()]
}

export function moveToPlacement(
  store: ScopeStore,
  documentIds: string[],
  placement: MemoryScope,
  acl?: DocumentAcl,
): number {
  if (documentIds.length === 0) return 0
  const { db } = store
  const placeholders = documentIds.map(() => '?').join(',')

  const assignments: string[] = []
  const params: Array<string | null> = []
  for (const [column, value] of [
    ['workspace_id', placement.workspaceId],
    ['folder_id', placement.folderId],
  ] as const) {
    if (value === undefined) continue
    assignments.push(`${column} = ?`)
    params.push(value)
  }
  if (assignments.length === 0 && !acl) return 0

  if (acl) {
    assignments.push(
      'acl_tenant_id = ?',
      'acl_visibility = ?',
      'acl_read_roles = ?',
      'acl_read_groups = ?',
      'acl_read_principals = ?',
    )
    params.push(
      acl.tenantId ?? null,
      acl.visibility ?? 'public',
      acl.readRoles ? JSON.stringify(normalizeAcl(acl.readRoles)) : null,
      acl.readGroups ? JSON.stringify(normalizeAcl(acl.readGroups)) : null,
      acl.readPrincipals ? JSON.stringify(normalizeAcl(acl.readPrincipals)) : null,
    )
  }

  const result = db
    .prepare(`update documents set ${assignments.join(', ')} where id in (${placeholders})`)
    .run(...params, ...documentIds)

  return result.changes
}

export type DocumentFields = { title?: string; sourceUrl?: string | null }

/**
 * Rewrite a document's descriptive fields. Deliberately does not touch the text
 * of text chunks: those carry embeddings computed from what they say, and
 * editing them here would leave the vectors describing the old wording. Image
 * chunks are the exception — see retitleImageChunks.
 */
export function updateDocumentFields(
  store: ScopeStore,
  documentId: string,
  fields: DocumentFields,
): number {
  const assignments: string[] = []
  const params: Array<string | null> = []

  if (fields.title !== undefined) {
    assignments.push('title = ?')
    params.push(fields.title)
  }
  if (fields.sourceUrl !== undefined) {
    assignments.push('source_url = ?')
    params.push(fields.sourceUrl)
  }
  if (assignments.length === 0) return 0

  const db = store.db
  const apply = db.transaction(() => {
    const before =
      fields.title === undefined
        ? undefined
        : (db
            .prepare('select title from documents where id = ? and deleted_at is null')
            .get(documentId) as { title: string } | undefined)

    const changes = db
      .prepare(
        `update documents set ${assignments.join(', ')}
          where id = ? and deleted_at is null`,
      )
      .run(...params, documentId).changes

    if (changes > 0 && before !== undefined && fields.title !== before.title) {
      retitleImageChunks(db, documentId, before.title, fields.title!)
    }
    return changes
  })

  return apply()
}

/**
 * An image chunk has no words of its own, so it carries the document title as
 * its searchable text and a rename has to move with it. Its embedding came from
 * the image and stays put. chunks_fts is external-content, which has no update
 * path — the old row must be deleted with its old text before the new one goes
 * in, or the index keeps answering to the old title.
 */
function retitleImageChunks(db: Database, documentId: string, from: string, to: string): void {
  const rows = db
    .prepare(
      `select id from chunks
        where document_id = ? and text = ? and modality in ('image','text_image')`,
    )
    .all(documentId, from) as Array<{ id: number }>
  if (rows.length === 0) return

  const dropFts = db.prepare("insert into chunks_fts(chunks_fts, rowid, text) values('delete', ?, ?)")
  const addFts = db.prepare('insert into chunks_fts(rowid, text) values (?, ?)')
  const setText = db.prepare('update chunks set text = ? where id = ?')

  for (const { id } of rows) {
    dropFts.run(id, from)
    setText.run(to, id)
    addFts.run(id, to)
  }
}

/**
 * Tombstone documents so retrieval stops returning them. Deliberately not a
 * row delete: chunks_fts is external-content and chunks_vec is a virtual table,
 * so neither is reached by the foreign key cascade, and removing the rows would
 * strand entries in both indexes. Reclaiming the space is compaction's job.
 */
export function deleteDocuments(
  store: ScopeStore,
  documentIds: string[],
  at = Date.now(),
): number {
  if (documentIds.length === 0) return 0
  const placeholders = documentIds.map(() => '?').join(',')
  return store.db
    .prepare(
      `update documents set deleted_at = ?
        where id in (${placeholders}) and deleted_at is null`,
    )
    .run(at, ...documentIds).changes
}

const STOPWORDS = new Set([
  'a', 'about', 'after', 'all', 'also', 'am', 'an', 'and', 'any', 'are', 'as', 'at',
  'be', 'been', 'but', 'by', 'can', 'did', 'do', 'does', 'for', 'from', 'had', 'has',
  'have', 'he', 'her', 'his', 'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its', 'me',
  'my', 'no', 'not', 'of', 'on', 'or', 'our', 'out', 'over', 'she', 'so', 'some',
  'such', 'than', 'that', 'the', 'their', 'them', 'then', 'there', 'these', 'they',
  'this', 'to', 'up', 'us', 'was', 'we', 'were', 'what', 'when', 'where', 'which',
  'who', 'why', 'will', 'with', 'would', 'you', 'your',
])

function toFtsQuery(raw: string): string | null {
  const terms = (raw.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(
    (t) => t.length > 2 && !STOPWORDS.has(t),
  )
  if (terms.length === 0) return null
  return terms.map((t) => `"${t}"`).join(' OR ')
}

/**
 * Node ids every spelling in `phrases` resolves to.
 *
 * Goes through the alias table when it exists. A scope file written before the
 * alias table was added is still readable (a readonly open never migrates), so
 * fall back to the exact-id lookup rather than failing the query; it upgrades
 * on its next write.
 */
function nodeIdsForPhrases(db: Database, phrases: string[]): string[] {
  if (phrases.length === 0) return []

  if (!hasEntityIndex(db)) {
    const ids = [...new Set(phrases.map(nodeIdFor))]
    return (
      db
        .prepare(`select id from memory_nodes where id in (${ids.map(() => '?').join(',')})`)
        .all(...ids) as Array<{ id: string }>
    ).map((r) => r.id)
  }

  const keys = [...new Set(phrases.flatMap(entityAliasKeys))]
  if (keys.length === 0) return []
  return (
    db
      .prepare(
        `select distinct node_id from memory_node_aliases
          where alias_key in (${keys.map(() => '?').join(',')})`,
      )
      .all(...keys) as Array<{ node_id: string }>
  ).map((r) => r.node_id)
}

function entityPhrases(queryText: string): string[] {
  const tokens = queryText.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
  if (tokens.length === 0) return []

  const phrases = new Set<string>()
  for (let start = 0; start < tokens.length; start++) {
    for (let width = 1; width <= GRAPH_ENTITY_WINDOW && start + width <= tokens.length; width++) {
      const phrase = tokens.slice(start, start + width).join(' ')
      if (width === 1 && (phrase.length < 3 || STOPWORDS.has(phrase))) continue
      phrases.add(phrase)
    }
  }
  return [...phrases]
}

function graphSeedNodeIds(db: Database, queryText: string): string[] {
  return nodeIdsForPhrases(db, entityPhrases(queryText))
}

export type ResolvedEntities = { matched: string[]; suggested: string[] }

/**
 * Names a query mentions (`matched`, exact via aliases) and near-misses worth
 * retrying with (`suggested`). Suggestions come from two tiers unioned in order:
 * trigram spelling-similarity first, then — when a query vector is supplied and
 * the scope has node vectors — semantic neighbours, which catch synonyms and
 * paraphrases that share no trigrams.
 */
export function resolveEntities(
  store: ScopeStore,
  text: string,
  limit = 6,
  queryVector?: Float32Array,
): ResolvedEntities {
  const { db } = store
  if (!hasGraph(db)) return { matched: [], suggested: [] }

  const seeds = graphSeedNodeIds(db, text)
  const matched = seeds.length
    ? (
        db
          .prepare(`select label from memory_nodes where id in (${seeds.map(() => '?').join(',')})`)
          .all(...seeds) as Array<{ label: string }>
      ).map((r) => r.label)
    : []

  const terms = (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((t) => t.length > 2 && !STOPWORDS.has(t))
    .slice(0, 8)

  const pool =
    terms.length > 0 ? nearbyLabels(db, terms, limit + matched.length) : []
  if (queryVector) {
    pool.push(...semanticNodeLabels(db, queryVector, limit + matched.length))
  }

  const taken = new Set(matched.map(legacyEntityKey))
  const suggested: string[] = []
  for (const label of pool) {
    const key = legacyEntityKey(label)
    if (taken.has(key)) continue
    taken.add(key)
    suggested.push(label)
    if (suggested.length >= limit) break
  }

  return { matched, suggested }
}

/**
 * Labels whose vectors are nearest the query, closest first, kept only within
 * NODE_SEMANTIC_MAX_DISTANCE so an empty graph corner doesn't return noise.
 */
function semanticNodeLabels(db: Database, queryVector: Float32Array, limit: number): string[] {
  if (limit <= 0 || !hasNodeVectors(db)) return []
  try {
    const rows = db
      .prepare(
        'select rowid as rowid, distance from memory_nodes_vec where embedding match ? and k = ? order by distance',
      )
      .all(toBlob(l2normalize(queryVector)), limit) as Array<{ rowid: number; distance: number }>
    const within = rows.filter((r) => r.distance <= NODE_SEMANTIC_MAX_DISTANCE)
    if (within.length === 0) return []

    const ids = within.map((r) => r.rowid)
    const labels = db
      .prepare(
        `select rowid as rowid, label from memory_nodes where rowid in (${ids.map(() => '?').join(',')})`,
      )
      .all(...ids) as Array<{ rowid: number; label: string }>
    const byRow = new Map(labels.map((l) => [l.rowid, l.label]))
    return within.map((r) => byRow.get(r.rowid)).filter((l): l is string => l !== undefined)
  } catch {
    return []
  }
}

/**
 * Labels that look like one of `terms`. Uses the trigram index when present;
 * older scope files fall back to the LIKE scan this replaced.
 */
function nearbyLabels(db: Database, terms: string[], limit: number): string[] {
  if (hasEntityIndex(db)) {
    try {
      return (
        db
          .prepare(
            `select distinct label from memory_nodes_fts
              where memory_nodes_fts match ?
              order by bm25(memory_nodes_fts)
              limit ?`,
          )
          .all(terms.map((t) => `"${t}"`).join(' OR '), limit) as Array<{ label: string }>
      ).map((r) => r.label)
    } catch {
      return []
    }
  }

  return (
    db
      .prepare(
        `select distinct label from memory_nodes
          where ${terms.map(() => 'lower(label) like ?').join(' or ')}
          limit ?`,
      )
      .all(...terms.map((t) => `%${t}%`), limit) as Array<{ label: string }>
  ).map((r) => r.label)
}

function graphChunkIds(db: Database, queryText: string, depth: number): number[] {
  if (!hasGraph(db)) return []

  let frontier = graphSeedNodeIds(db, queryText)
  if (frontier.length === 0) return []

  const seen = new Set(frontier)
  const walked = new Set<string>()
  const documentScores = new Map<string, number>()

  for (let hop = 1; hop <= GRAPH_HOPS && frontier.length > 0; hop++) {
    const placeholders = frontier.map(() => '?').join(',')
    const edges = db
      .prepare(
        `select id as id, source_node_id as source, target_node_id as target, weight as weight,
                document_id as documentId
           from memory_edges
          where source_node_id in (${placeholders}) or target_node_id in (${placeholders})`,
      )
      .all(...frontier, ...frontier) as Array<{
      id: string
      source: string
      target: string
      weight: number
      documentId: string
    }>

    const next: string[] = []
    for (const edge of edges) {
      if (walked.has(edge.id)) continue
      walked.add(edge.id)
      const reached = (documentScores.get(edge.documentId) ?? 0) + edge.weight / hop
      documentScores.set(edge.documentId, reached)
      for (const node of [edge.source, edge.target]) {
        if (seen.has(node)) continue
        seen.add(node)
        next.push(node)
      }
    }
    frontier = next
  }
  if (documentScores.size === 0) return []

  const ranked = [...documentScores.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id)
  const rank = new Map(ranked.map((id, i) => [id, i]))
  return (
    db
      .prepare(
        `select id, document_id as documentId from chunks
          where document_id in (${ranked.map(() => '?').join(',')})
          order by ordinal asc`,
      )
      .all(...ranked) as Array<{ id: number; documentId: string }>
  )
    .sort((a, b) => rank.get(a.documentId)! - rank.get(b.documentId)!)
    .slice(0, depth)
    .map((r) => r.id)
}

export function hybridSearch(
  store: ScopeStore,
  queryText: string,
  queryVector: Float32Array,
  limit: number,
  acl?: AclContext,
  decay: DecayConfig = DECAY_OFF,
  scope?: MemoryScope,
): SearchHit[] {
  const { db } = store
  if (queryVector.length !== store.provider.dimension) {
    throw new Error(
      `[scope-store] query vector has dimension ${queryVector.length}, expected ${store.provider.dimension}`,
    )
  }

  const placement = placementClauses(scope)
  const tombstoned =
    hasDeletedAt(db) &&
    db.prepare('select 1 from documents where deleted_at is not null limit 1').get() != null
  const filtered = acl !== undefined || placement.clauses.length > 0 || tombstoned

  const clauses: string[] = [...placement.clauses]
  const params: Array<string | number> = [...placement.params]
  if (tombstoned) clauses.push(LIVE_ONLY)
  if (acl) {
    const p = aclPredicate(acl)
    clauses.push(p.sql)
    params.push(...p.params)
  }
  const where = clauses.length ? clauses.join(' and ') : null
  const now = Date.now()

  const ftsQuery = toFtsQuery(queryText)

  /**
   * One pass at a given candidate depth. `exhausted` reports that every channel
   * returned less than it was offered, so going deeper cannot find more.
   */
  const pass = (depth: number): { hits: SearchHit[]; exhausted: boolean } => {
    const vecIds = (
      db
        .prepare('select rowid as id from chunks_vec where embedding match ? and k = ? order by distance')
        .all(toBlob(queryVector), depth) as Array<{ id: number }>
    ).map((r) => r.id)

    let ftsIds: number[] = []
    if (ftsQuery) {
      try {
        ftsIds = (
          db
            .prepare(
              'select rowid as id from chunks_fts where chunks_fts match ? order by bm25(chunks_fts) limit ?',
            )
            .all(ftsQuery, depth) as Array<{ id: number }>
        ).map((r) => r.id)
      } catch {
        ftsIds = []
      }
    }

    const graphIds = graphChunkIds(db, queryText, depth)
    const exhausted =
      vecIds.length < depth && ftsIds.length < depth && graphIds.length < depth

    const fused = reciprocalRankFusion([vecIds, ftsIds, graphIds], {
      weights: [1, 1, GRAPH_WEIGHT],
      ...(filtered || decay.enabled ? {} : { limit }),
    })
    if (fused.length === 0) return { hits: [], exhausted: true }

    const placeholders = fused.map(() => '?').join(',')
    const rows = db
      .prepare(
        `select c.id as chunkId, c.document_id as documentId, c.text as text, c.modality as modality,
                c.asset_sha256 as assetSha256, c.created_at as createdAt,
                c.last_accessed as lastAccessed, d.title as title,
                d.source_type as sourceType, d.source_url as sourceUrl
           from chunks c join documents d on d.id = c.document_id
          where c.id in (${placeholders})${where ? ` and ${where}` : ''}`,
      )
      .all(...fused.map((f) => f.id), ...params) as Array<
      Omit<SearchHit, 'score'> & { createdAt: number; lastAccessed: number | null }
    >

    const byId = new Map(rows.map((r) => [r.chunkId, r]))
    const hits = fused.flatMap((f) => {
      const row = byId.get(f.id)
      if (!row) return []
      const { createdAt, lastAccessed, ...hit } = row
      const lastTouched = Math.max(createdAt, lastAccessed ?? 0)
      return [{ ...hit, score: applyDecay(f.score, lastTouched, now, decay) }]
    })
    return { hits, exhausted }
  }

  /**
   * Placement, ACL and tombstones are applied after the channels have already
   * chosen their candidates, so a heavily filtered scope can come back short of
   * `limit` while matching rows sit just past the cutoff. Widen and retry
   * instead of reporting that thin result as the whole answer.
   */
  let depth = CANDIDATE_DEPTH
  let { hits: visible, exhausted } = pass(depth)
  while (filtered && visible.length < limit && !exhausted && depth < MAX_CANDIDATE_DEPTH) {
    depth = Math.min(depth * 4, MAX_CANDIDATE_DEPTH)
    ;({ hits: visible, exhausted } = pass(depth))
  }

  if (decay.enabled) visible.sort((a, b) => b.score - a.score)
  return visible.slice(0, limit)
}

export function recordAccess(store: ScopeStore, chunkIds: number[], at = Date.now()): void {
  if (chunkIds.length === 0) return
  const stmt = store.db.prepare(
    'update chunks set last_accessed = ?, access_count = access_count + 1 where id = ?',
  )
  store.db.transaction(() => {
    for (const id of chunkIds) stmt.run(at, id)
  })()
}
