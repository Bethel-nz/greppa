import { eq, count, sql } from 'drizzle-orm'
import { drizzle, schema } from '../db'
import { openGreppaMemory, invalidateGreppaMemory, LOCAL_MEMORY_PATH } from './memvid'
import { getAclContext, type GreppaAclContext } from './acl'
import { enqueueMemoryWrite } from './queue'
import { uploadMemoryToR2 } from './r2'
import { markMemoryDirty } from './sync'

export type AddMemoryInput = {
  userId: string
  orgId: string
  title: string
  text: string
  sourceType: 'note' | 'chat' | 'document' | 'webpage' | 'agent_event'
  sourceUrl?: string
}

export type SearchMemoryInput = {
  userId: string
  orgId: string
  query: string
  limit?: number
}

export type AskMemoryInput = {
  userId: string
  orgId: string
  question: string
  limit?: number
}

function normalizeAclStrings(values: string[]): string[] {
  return values.map((v) => v.trim().toLowerCase()).filter(Boolean)
}

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
 * The single source of truth for the Memvid ACL metadata shape. Every write path
 * must build metadata here so the schema can never drift between callers.
 */
function buildAclMetadata(input: CommitMemoryCardInput) {
  return {
    acl_tenant_id: input.acl.tenantId,
    acl_visibility: 'restricted' as const,
    acl_read_roles: input.acl.roles,
    acl_read_groups: input.acl.groupIds,
    acl_read_principals: normalizeAclStrings([input.userId]),
    acl_policy_version: 'v1',
    source_document_id: input.documentId,
    source_type: input.sourceType,
    source_url: input.sourceUrl,
    created_by: input.userId,
    app: 'greppa',
  }
}

/**
 * Low-level write into the active .mv2: put + seal + upload + invalidate cache.
 * Does NOT enqueue — callers must already be inside enqueueMemoryWrite() so the
 * single-writer invariant holds. This is the only place routes/services touch
 * the Memvid handle for writes (plan security rule #6).
 */
export async function commitMemoryCard(input: CommitMemoryCardInput): Promise<void> {
  const mem = await openGreppaMemory()

  await mem.put({
    title: input.title,
    label: input.sourceType,
    text: input.text,
    metadata: buildAclMetadata(input),
  })

  await mem.seal()
  await uploadMemoryToR2(LOCAL_MEMORY_PATH)
  invalidateGreppaMemory()
  markMemoryDirty()
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

    // Update document status
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
  const mem = await openGreppaMemory()

  return await mem.find(input.query, {
    k: input.limit ?? 8,
    aclContext: {
      tenantId: acl.tenantId,
      subjectId: acl.subjectId,
      roles: acl.roles,
      groupIds: acl.groupIds,
    },
    aclEnforcementMode: 'enforce',
  })
}

export async function askMemory(input: AskMemoryInput) {
  const acl = await getAclContext({ userId: input.userId, orgId: input.orgId })
  const mem = await openGreppaMemory()

  return await mem.ask(input.question, {
    k: input.limit ?? 10,
    aclContext: {
      tenantId: acl.tenantId,
      subjectId: acl.subjectId,
      roles: acl.roles,
      groupIds: acl.groupIds,
    },
    aclEnforcementMode: 'enforce',
  })
}

export async function syncMemoryToR2() {
  await uploadMemoryToR2(LOCAL_MEMORY_PATH)
}

export async function getOrgStats(orgId: string) {
  const [docCount, eventCounts] = await Promise.all([
    drizzle
      .select({ count: count() })
      .from(schema.documents)
      .where(eq(schema.documents.orgId, orgId))
      .then((r) => r[0]?.count ?? 0),

    drizzle
      .select({
        kind: schema.memoryEvents.kind,
        count: count(),
      })
      .from(schema.memoryEvents)
      .where(eq(schema.memoryEvents.orgId, orgId))
      .groupBy(schema.memoryEvents.kind)
      .then((rows) =>
        Object.fromEntries(rows.map((r) => [r.kind, r.count])),
      ),
  ])

  return {
    orgId,
    documents: docCount,
    events: eventCounts,
  }
}

export async function getOrgDocumentTimeline(orgId: string, limit: number = 100) {
  return drizzle
    .select()
    .from(schema.documents)
    .where(eq(schema.documents.orgId, orgId))
    .orderBy(sql`${schema.documents.createdAt} DESC`)
    .limit(limit)
}
