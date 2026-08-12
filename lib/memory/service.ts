import { and, count, eq, isNull, sql } from 'drizzle-orm'
import { drizzle, schema } from '../db'
import { getCheckpoint, NotFoundError } from '~/utils/checkpoint'
import { getAclContext, type GreppaAclContext } from './acl'
import { generateAnswer } from './answer'
import { formatPassages } from './context'
import { embedInBatches, getEmbeddingProvider } from './embedding'
import { enqueueMemoryWrite } from './queue'
import { clampPageLimit, decodeCursor, paginate } from './cursor'
import { orgScopeObjectKey } from './scope'
import { chunkText } from './scope-store/chunker'
import { decayConfigFromEnv } from './scope-store/decay'
import {
  deleteDocuments,
  distinctEdgeNodes,
  hybridSearch,
  insertDocument,
  openScopeStore,
  updateDocumentFields,
  type AclContext,
  type DocumentFields,
  type MemoryEdgeInput,
  type MemoryScope,
  type NodeVectors,
} from './scope-store/store'
import type { EmbeddingProvider } from './embedding/provider'

/**
 * Label vectors for an edge set's nodes, keyed by node id, so entity resolution
 * can match on meaning rather than only spelling. Undefined when there are no
 * edges; otherwise a single batched embed of the distinct labels.
 */
export async function embedEdgeNodes(
  provider: EmbeddingProvider,
  edges: MemoryEdgeInput[] | undefined,
): Promise<NodeVectors | undefined> {
  if (!edges?.length) return undefined
  const nodes = distinctEdgeNodes(edges)
  if (nodes.length === 0) return undefined
  const vectors = await embedInBatches(provider, nodes.map((n) => n.label), 'document')
  return new Map(nodes.map((n, i) => [n.id, vectors[i]!]))
}

export type AddMemoryInput = MemoryScope & {
  userId: string
  orgId: string
  title: string
  text: string
  sourceType: 'note' | 'chat' | 'document' | 'webpage' | 'agent_event'
  sourceUrl?: string
  tags?: string[]
}

export type SearchMemoryInput = MemoryScope & {
  userId: string
  orgId: string
  query: string
  limit?: number
}
export type AskMemoryInput = MemoryScope & {
  userId: string
  orgId: string
  question: string
  limit?: number
}

export type CommitMemoryCardInput = MemoryScope & {
  acl: GreppaAclContext
  userId: string
  documentId: string
  title: string
  text: string
  sourceType: string
  sourceUrl?: string
  edges?: MemoryEdgeInput[]
}

const scopeOf = (input: MemoryScope): MemoryScope => ({
  workspaceId: input.workspaceId,
  folderId: input.folderId,
})

function toDocumentAcl(input: CommitMemoryCardInput) {
  return {
    tenantId: input.acl.tenantId,
    visibility: 'restricted' as const,
    readRoles: input.acl.roles,
    readGroups: input.acl.groupIds,
    readPrincipals: [input.userId],
  }
}

const toReaderContext = (acl: GreppaAclContext): AclContext => ({
  tenantId: acl.tenantId,
  subjectId: acl.subjectId,
  roles: acl.roles,
  groupIds: acl.groupIds,
})

export async function commitMemoryCard(input: CommitMemoryCardInput): Promise<void> {
  const provider = getEmbeddingProvider()
  const texts = chunkText(input.text)
  if (texts.length === 0) throw new Error('[memory] refusing to store an empty memory')
  const vectors = await embedInBatches(provider, texts, 'document')
  const nodeVectors = await embedEdgeNodes(provider, input.edges)

  await getCheckpoint().write(orgScopeObjectKey(input.acl.tenantId), async (localPath, exists) => {
    const store = openScopeStore(localPath, { provider, create: !exists })
    try {
      insertDocument(store, {
        id: input.documentId,
        title: input.title,
        text: input.text,
        sourceType: input.sourceType,
        sourceUrl: input.sourceUrl,
        createdBy: input.userId,
        meta: { app: 'greppa', source_document_id: input.documentId },
        acl: toDocumentAcl(input),
        workspaceId: input.workspaceId,
        folderId: input.folderId,
        edges: input.edges,
        nodeVectors,
        chunks: texts.map((text, i) => ({ text, embedding: vectors[i]!, modality: 'text' as const })),
      })
    } finally {
      store.close()
    }
  })
}

/**
 * Mutate an org's scope file, skipping cleanly when it does not exist yet.
 * `checkpoint.write` expects its callback to leave a file behind, so a mutation
 * that would no-op on a missing scope has to be skipped before it starts.
 */
async function writeExistingOrgScope<T>(
  orgId: string,
  mutate: (store: ReturnType<typeof openScopeStore>) => T,
  whenMissing: T,
): Promise<T> {
  const key = orgScopeObjectKey(orgId)
  const checkpoint = getCheckpoint()
  if (!(await checkpoint.stat(key))) return whenMissing

  const provider = getEmbeddingProvider()
  return enqueueMemoryWrite(() =>
    checkpoint.write(key, async (localPath, exists) => {
      if (!exists) return whenMissing
      const store = openScopeStore(localPath, { provider, create: false })
      try {
        return mutate(store)
      } finally {
        store.close()
      }
    }),
  )
}

/**
 * Tombstone documents inside an org's scope file so search stops returning
 * them. Postgres tracks a document's lifecycle but retrieval reads the scope
 * file, so a status change there alone leaves deleted content retrievable.
 */
export async function deleteOrgMemory(input: {
  orgId: string
  documentIds: string[]
}): Promise<number> {
  if (input.documentIds.length === 0) return 0
  return writeExistingOrgScope(
    input.orgId,
    (store) => deleteDocuments(store, input.documentIds),
    0,
  )
}

/**
 * Carry a metadata edit into the scope file. Search results quote the scope
 * file's title, so renaming in Postgres alone leaves the old name being cited
 * back to the user indefinitely.
 */
export async function updateOrgMemoryDocument(input: {
  orgId: string
  documentId: string
  fields: DocumentFields
}): Promise<number> {
  if (input.fields.title === undefined && input.fields.sourceUrl === undefined) return 0
  return writeExistingOrgScope(
    input.orgId,
    (store) => updateDocumentFields(store, input.documentId, input.fields),
    0,
  )
}

export async function addMemory(input: AddMemoryInput) {
  return enqueueMemoryWrite(async () => {
    const acl = await getAclContext({ userId: input.userId, orgId: input.orgId })
    const documentId = crypto.randomUUID()

    await drizzle.insert(schema.documents).values({
      id: documentId,
      orgId: input.orgId,
      ownerUserId: input.userId,
      title: input.title,
      sourceType: input.sourceType,
      sourceUrl: input.sourceUrl,
      workspaceId: input.workspaceId ?? null,
      folderId: input.folderId ?? null,
      metadata: input.tags?.length ? { tags: input.tags } : {},
      status: 'processing',
    })

    await drizzle.insert(schema.memoryEvents).values({
      id: crypto.randomUUID(),
      orgId: input.orgId,
      userId: input.userId,
      documentId,
      kind: 'memory.ingest.started',
      status: 'pending',
    })

    await commitMemoryCard({
      acl,
      userId: input.userId,
      documentId,
      title: input.title,
      text: input.text,
      sourceType: input.sourceType,
      sourceUrl: input.sourceUrl,
      ...scopeOf(input),
    })

    await drizzle
      .update(schema.documents)
      .set({ status: 'indexed', indexedAt: new Date() })
      .where(eq(schema.documents.id, documentId))

    await drizzle.insert(schema.memoryEvents).values({
      id: crypto.randomUUID(),
      orgId: input.orgId,
      userId: input.userId,
      documentId,
      kind: 'memory.ingest.completed',
      status: 'indexed',
    })

    return { documentId, status: 'indexed' }
  })
}

export async function searchMemory(input: SearchMemoryInput) {
  const acl = await getAclContext({ userId: input.userId, orgId: input.orgId })
  const provider = getEmbeddingProvider()
  const [queryVector] = await provider.embed([input.query], 'query')

  try {
    const hits = await getCheckpoint().read(orgScopeObjectKey(acl.tenantId), async (localPath) => {
      const store = openScopeStore(localPath, { provider, create: false, readonly: true })
      try {
        return hybridSearch(
          store,
          input.query,
          queryVector!,
          input.limit ?? 8,
          toReaderContext(acl),
          decayConfigFromEnv(),
          scopeOf(input),
        )
      } finally {
        store.close()
      }
    })
    return { hits: hits.map((h) => ({ ...h, snippet: h.text })), total_hits: hits.length }
  } catch (err) {
    if (err instanceof NotFoundError) return { hits: [], total_hits: 0 }
    throw err
  }
}

export async function askMemory(input: AskMemoryInput) {
  const { hits } = await searchMemory({
    userId: input.userId,
    orgId: input.orgId,
    query: input.question,
    limit: input.limit ?? 10,
    ...scopeOf(input),
  })
  if (hits.length === 0) return { answer: null, sources: [], context: '', grounding: null }

  const context = formatPassages(hits)
  const answer = await generateAnswer({ question: input.question, context })
  return { answer, sources: hits, context, grounding: null }
}

export async function getOrgStats(orgId: string) {
  const [docCount, eventCounts] = await Promise.all([
    drizzle
      .select({ count: count() })
      .from(schema.documents)
      .where(eq(schema.documents.orgId, orgId))
      .then((r) => r[0]?.count ?? 0),

    drizzle
      .select({ kind: schema.memoryEvents.kind, count: count() })
      .from(schema.memoryEvents)
      .where(eq(schema.memoryEvents.orgId, orgId))
      .groupBy(schema.memoryEvents.kind)
      .then((rows) => Object.fromEntries(rows.map((r) => [r.kind, r.count]))),
  ])

  return { orgId, documents: docCount, events: eventCounts }
}

/**
 * One page of an org's documents, newest first, with a cursor for the next.
 * Keyset paginated on `(createdAt, id)` — see lib/memory/cursor. A malformed or
 * absent cursor starts from the top.
 */
export async function pageOrgDocuments(
  orgId: string,
  opts: { limit?: number; cursor?: string | null; scope?: MemoryScope } = {},
) {
  const limit = clampPageLimit(opts.limit)
  const scope = opts.scope ?? {}
  const filters = [eq(schema.documents.orgId, orgId)]
  for (const [column, value] of [
    [schema.documents.workspaceId, scope.workspaceId],
    [schema.documents.folderId, scope.folderId],
  ] as const) {
    if (value === undefined) continue
    filters.push(value === null ? isNull(column) : eq(column, value))
  }

  const cursor = decodeCursor(opts.cursor)
  if (cursor) {
    // Row-value comparison in the DESC ordering: "strictly older than the cursor".
    filters.push(
      sql`(${schema.documents.createdAt}, ${schema.documents.id}) < (${new Date(cursor.createdAt)}, ${cursor.id})`,
    )
  }

  const rows = await drizzle
    .select()
    .from(schema.documents)
    .where(and(...filters))
    .orderBy(sql`${schema.documents.createdAt} desc, ${schema.documents.id} desc`)
    .limit(limit + 1)

  return paginate(rows, limit, (row) => ({ createdAt: row.createdAt.getTime(), id: row.id }))
}

/** The most recent documents for an org. Thin wrapper over pageOrgDocuments for callers that only want a recent window. */
export async function getOrgDocumentTimeline(
  orgId: string,
  limit: number = 100,
  scope: MemoryScope = {},
) {
  const { items } = await pageOrgDocuments(orgId, { limit, scope })
  return items
}
