import { eq, and, sql, count } from 'drizzle-orm'
import { drizzle, schema } from '~/lib/db'

export type DocumentUpdateInput = {
  title?: string
  metadata?: Record<string, unknown>
  sourceUrl?: string
}

export async function getDocumentById(docId: string, orgId: string) {
  const doc = await drizzle.query.documents.findFirst({
    where: (d, { and, eq }) => and(eq(d.id, docId), eq(d.orgId, orgId)),
  })
  return doc ?? null
}

export async function getDocumentByFrameId(frameId: string, orgId: string) {
  // frameId maps to document.id for now
  return getDocumentById(frameId, orgId)
}

export async function updateDocument(
  docId: string,
  orgId: string,
  input: DocumentUpdateInput,
) {
  const existing = await getDocumentById(docId, orgId)
  if (!existing) return null

  const updates: any = {}
  if (input.title !== undefined) updates.title = input.title
  if (input.sourceUrl !== undefined) updates.sourceUrl = input.sourceUrl
  if (input.metadata !== undefined) {
    updates.metadata = { ...(existing.metadata as Record<string, unknown>), ...input.metadata }
  }

  await drizzle
    .update(schema.documents)
    .set(updates)
    .where(and(eq(schema.documents.id, docId), eq(schema.documents.orgId, orgId)))

  return getDocumentById(docId, orgId)
}

export async function softDeleteDocument(docId: string, orgId: string) {
  const existing = await getDocumentById(docId, orgId)
  if (!existing) return false

  await drizzle
    .update(schema.documents)
    .set({
      status: 'deleted',
      deletedAt: new Date(),
    })
    .where(and(eq(schema.documents.id, docId), eq(schema.documents.orgId, orgId)))

  // Record deletion event
  await drizzle.insert(schema.memoryEvents).values({
    id: crypto.randomUUID(),
    orgId,
    userId: existing.ownerUserId,
    documentId: docId,
    kind: 'knowledge.deleted',
    status: 'completed',
  })

  return true
}

export async function getDocumentStats(orgId: string) {
  const [total, indexed, pending, failed] = await Promise.all([
    drizzle
      .select({ count: count() })
      .from(schema.documents)
      .where(and(eq(schema.documents.orgId, orgId), sql`${schema.documents.status} != 'deleted'`))
      .then((r) => r[0]?.count ?? 0),

    drizzle
      .select({ count: count() })
      .from(schema.documents)
      .where(and(eq(schema.documents.orgId, orgId), eq(schema.documents.status, 'indexed')))
      .then((r) => r[0]?.count ?? 0),

    drizzle
      .select({ count: count() })
      .from(schema.documents)
      .where(
        and(
          eq(schema.documents.orgId, orgId),
          sql`${schema.documents.status} IN ('pending', 'processing')`,
        ),
      )
      .then((r) => r[0]?.count ?? 0),

    drizzle
      .select({ count: count() })
      .from(schema.documents)
      .where(and(eq(schema.documents.orgId, orgId), eq(schema.documents.status, 'failed')))
      .then((r) => r[0]?.count ?? 0),
  ])

  return { total, indexed, pending, failed }
}
