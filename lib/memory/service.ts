import { eq, count, sql } from 'drizzle-orm'
import { drizzle, schema } from '../db'
import { getCheckpoint, NotFoundError } from '~/utils/checkpoint'
import { getAclContext, type GreppaAclContext } from './acl'
import { generateAnswer } from './answer'
import { embedInBatches, getEmbeddingProvider } from './embedding'
import { enqueueMemoryWrite } from './queue'
import { orgScopeObjectKey } from './scope'
import { chunkText } from './scope-store/chunker'
import { decayConfigFromEnv } from './scope-store/decay'
import { hybridSearch, insertDocument, openScopeStore, type AclContext } from './scope-store/store'

export type AddMemoryInput = {
  userId: string
  orgId: string
  title: string
  text: string
  sourceType: 'note' | 'chat' | 'document' | 'webpage' | 'agent_event'
  sourceUrl?: string
}

export type SearchMemoryInput = { userId: string; orgId: string; query: string; limit?: number }
export type AskMemoryInput = { userId: string; orgId: string; question: string; limit?: number }

export type CommitMemoryCardInput = {
  acl: GreppaAclContext
  userId: string
  documentId: string
  title: string
  text: string
  sourceType: string
  sourceUrl?: string
}

/**
 * Org memory is one scope-store database per organisation, served through
 * Checkpoint. Cross-tenant isolation is therefore structural — orgs do not
 * share a file — and the ACL columns below enforce visibility *within* an org,
 * which physical separation cannot do.
 *
 * This replaced a single global `.mv2` in which every tenant's data shared one
 * file and separation depended entirely on query-time metadata filtering.
 */
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

/**
 * Low-level write into the org's scope database. Does NOT enqueue — callers
 * must already be inside enqueueMemoryWrite() so the single-writer invariant
 * holds. Embeddings are computed before Checkpoint's lock is taken.
 */
export async function commitMemoryCard(input: CommitMemoryCardInput): Promise<void> {
  const provider = getEmbeddingProvider()
  const texts = chunkText(input.text)
  if (texts.length === 0) throw new Error('[memory] refusing to store an empty memory')
  const vectors = await embedInBatches(provider, texts, 'document')

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
        chunks: texts.map((text, i) => ({ text, embedding: vectors[i]!, modality: 'text' as const })),
      })
    } finally {
      store.close()
    }
  })
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
        return hybridSearch(store, input.query, queryVector!, input.limit ?? 8, toReaderContext(acl), decayConfigFromEnv())
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
  })
  if (hits.length === 0) return { answer: null, sources: [], context: '', grounding: null }

  const context = hits.map((h, i) => `### [${i + 1}] ${h.title}\n${h.text}`).join('\n\n')
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

export async function getOrgDocumentTimeline(orgId: string, limit: number = 100) {
  return drizzle
    .select()
    .from(schema.documents)
    .where(eq(schema.documents.orgId, orgId))
    .orderBy(sql`${schema.documents.createdAt} DESC`)
    .limit(limit)
}
