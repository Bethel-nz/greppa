import type { Database } from 'bun:sqlite'
import type { EmbeddingProvider } from '../embedding/provider'
import { openSqlite } from '../sqlite'
import { reciprocalRankFusion } from './fusion'
import { assertIdentity, createSchema, readIdentity } from './schema'
import { DECAY_OFF, applyDecay, type DecayConfig } from './decay'

/** How many candidates each retriever contributes before fusion. */
export const CANDIDATE_DEPTH = 50

export type ScopeStore = { db: Database; provider: EmbeddingProvider; close(): void }

export type ChunkInput = {
  text: string
  embedding: Float32Array
  modality?: 'text' | 'image' | 'text_image'
  assetSha256?: string
  assetMime?: string
}

/**
 * Within-scope visibility. Omit for a memory every reader of the scope may see
 * (the personal-scope case, where the scope owner is the only reader).
 */
export type DocumentAcl = {
  tenantId?: string
  visibility?: 'public' | 'restricted'
  readRoles?: string[]
  readGroups?: string[]
  readPrincipals?: string[]
}

/** Identity a reader presents. Omit to read without ACL enforcement. */
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
  chunks: ChunkInput[]
}

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
    // Order matters. createSchema() writes the identity, so calling it before
    // the check would overwrite the stored model with the current one and make
    // assertIdentity vacuously pass — silently querying across embedding
    // models, the exact failure this guard exists to prevent.
    const existing = readIdentity(db)
    if (existing) {
      assertIdentity(db, opts.provider)
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

/** Trim and lowercase so membership checks are not defeated by casing. */
const normalizeAcl = (values: string[]): string[] =>
  values.map((v) => v.trim().toLowerCase()).filter(Boolean)

/**
 * SQL predicate for a reader. A document is visible when its tenant matches and
 * either it is public, or the reader is named directly, or the reader holds one
 * of its roles or groups.
 *
 * Written as a predicate rather than a post-filter so a document a reader may
 * not see can never reach the result set, even transiently.
 */
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

export function insertDocument(store: ScopeStore, input: InsertDocumentInput): string {
  const { db } = store
  const documentId = input.id ?? crypto.randomUUID()

  const insertDoc = db.prepare(
    `insert into documents(
       id,title,source_type,source_url,created_by,created_at,meta_json,
       acl_tenant_id,acl_visibility,acl_read_roles,acl_read_groups,acl_read_principals
     ) values (?,?,?,?,?,?,?,?,?,?,?,?)`,
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
      // An empty-text chunk contributes nothing to BM25 and would only pollute
      // the index, so image-only chunks are vector-retrievable exclusively.
      if (c.text.trim()) insertFts.run(chunkId, c.text)
      insertVec.run(chunkId, toBlob(c.embedding))
    }
  })

  run()
  return documentId
}

/**
 * Terms too common to carry retrieval signal. Without this filter a query like
 * "instructions for cooking dinner" matches any document containing "for",
 * which hands that document a BM25 rank-1 and — because RRF weights both
 * retrievers equally — lets it outrank a correct semantic hit.
 */
const STOPWORDS = new Set([
  'a', 'about', 'after', 'all', 'also', 'am', 'an', 'and', 'any', 'are', 'as', 'at',
  'be', 'been', 'but', 'by', 'can', 'did', 'do', 'does', 'for', 'from', 'had', 'has',
  'have', 'he', 'her', 'his', 'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its', 'me',
  'my', 'no', 'not', 'of', 'on', 'or', 'our', 'out', 'over', 'she', 'so', 'some',
  'such', 'than', 'that', 'the', 'their', 'them', 'then', 'there', 'these', 'they',
  'this', 'to', 'up', 'us', 'was', 'we', 'were', 'what', 'when', 'where', 'which',
  'who', 'why', 'will', 'with', 'would', 'you', 'your',
])

/**
 * FTS5 MATCH parses its argument as a query language, so raw user input can be
 * a syntax error. Reduce to bare terms, drop noise, and quote each one.
 *
 * Returns null when nothing useful survives, in which case the caller skips
 * BM25 entirely and the search is vector-only. That is the correct outcome for
 * a purely conceptual query with no distinctive keywords.
 */
function toFtsQuery(raw: string): string | null {
  const terms = (raw.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(
    (t) => t.length > 2 && !STOPWORDS.has(t),
  )
  if (terms.length === 0) return null
  return terms.map((t) => `"${t}"`).join(' OR ')
}

export function hybridSearch(
  store: ScopeStore,
  queryText: string,
  queryVector: Float32Array,
  limit: number,
  acl?: AclContext,
  decay: DecayConfig = DECAY_OFF,
): SearchHit[] {
  const { db } = store
  if (queryVector.length !== store.provider.dimension) {
    throw new Error(
      `[scope-store] query vector has dimension ${queryVector.length}, expected ${store.provider.dimension}`,
    )
  }

  // ACL filtering happens after candidate retrieval, so over-fetch when it is
  // active or an enforced query could under-fill its limit.
  const depth = acl ? CANDIDATE_DEPTH * 4 : CANDIDATE_DEPTH

  const vecIds = (
    db
      .prepare('select rowid as id from chunks_vec where embedding match ? and k = ? order by distance')
      .all(toBlob(queryVector), depth) as Array<{ id: number }>
  ).map((r) => r.id)

  let ftsIds: number[] = []
  const ftsQuery = toFtsQuery(queryText)
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
      // A malformed FTS expression must degrade to vector-only, never fail the search.
      ftsIds = []
    }
  }

  // Fuse without the limit when ACL is active: entries the reader cannot see
  // are removed below, and truncating first would silently shorten the result.
  // With decay on, fusion must not truncate first: an older-but-stronger hit
  // can legitimately fall below a fresher one only after weighting.
  const fused = reciprocalRankFusion([vecIds, ftsIds], acl || decay.enabled ? {} : { limit })
  if (fused.length === 0) return []

  const placeholders = fused.map(() => '?').join(',')
  const where = acl ? aclPredicate(acl) : null
  const rows = db
    .prepare(
      `select c.id as chunkId, c.document_id as documentId, c.text as text, c.modality as modality,
              c.asset_sha256 as assetSha256, c.created_at as createdAt,
              c.last_accessed as lastAccessed, d.title as title,
              d.source_type as sourceType, d.source_url as sourceUrl
         from chunks c join documents d on d.id = c.document_id
        where c.id in (${placeholders})${where ? ` and ${where.sql}` : ''}`,
    )
    .all(...fused.map((f) => f.id), ...(where?.params ?? [])) as Array<
    Omit<SearchHit, 'score'> & { createdAt: number; lastAccessed: number | null }
  >

  const byId = new Map(rows.map((r) => [r.chunkId, r]))
  const now = Date.now()
  const visible = fused.flatMap((f) => {
    const row = byId.get(f.id)
    if (!row) return []
    const { createdAt, lastAccessed, ...hit } = row
    // Decay runs from the last TOUCH. A memory that keeps being recalled stays
    // strong; one that never surfaces fades. Decaying from createdAt alone
    // would be recency bias, not forgetting.
    const lastTouched = Math.max(createdAt, lastAccessed ?? 0)
    return [{ ...hit, score: applyDecay(f.score, lastTouched, now, decay) }]
  })
  if (decay.enabled) visible.sort((a, b) => b.score - a.score)
  return visible.slice(0, limit)
}

/**
 * Reinforce chunks that were actually useful: bump last_accessed and
 * access_count so temporal decay treats them as fresh.
 *
 * NOT called during hybridSearch, deliberately. Reads open the database
 * readonly against an immutable Checkpoint generation, and turning a search
 * into a write would mean re-uploading the whole scope file for a query. Call
 * this from inside an existing `Checkpoint.write` — piggy-backing on a real
 * mutation — or leave it uncalled and let decay run from created_at.
 */
export function recordAccess(store: ScopeStore, chunkIds: number[], at = Date.now()): void {
  if (chunkIds.length === 0) return
  const stmt = store.db.prepare(
    'update chunks set last_accessed = ?, access_count = access_count + 1 where id = ?',
  )
  store.db.transaction(() => {
    for (const id of chunkIds) stmt.run(at, id)
  })()
}
