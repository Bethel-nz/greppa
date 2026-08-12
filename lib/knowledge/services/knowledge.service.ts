import { eq, and } from 'drizzle-orm'
import { drizzle, schema } from '~/lib/db'
import { deleteOrgMemory, updateOrgMemoryDocument } from '~/lib/memory/service'

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

  // Search cites the scope file's copy of these fields, so a rename that only
  // lands in Postgres keeps quoting the old title back at the user. `metadata`
  // is not carried across: the scope file's meta_json records provenance, not
  // the caller's tags.
  await updateOrgMemoryDocument({
    orgId,
    documentId: docId,
    fields: { title: input.title, sourceUrl: input.sourceUrl },
  })

  await drizzle
    .update(schema.documents)
    .set(updates)
    .where(and(eq(schema.documents.id, docId), eq(schema.documents.orgId, orgId)))

  return getDocumentById(docId, orgId)
}

export async function softDeleteDocument(docId: string, orgId: string) {
  const existing = await getDocumentById(docId, orgId)
  if (!existing) return false

  // Memory first, Postgres second. If the scope write fails the request fails
  // and nothing has changed; the reverse order would mark the document deleted
  // while search kept serving its contents.
  await deleteOrgMemory({ orgId, documentIds: [docId] })

  await drizzle
    .update(schema.documents)
    .set({
      status: 'deleted',
      deletedAt: new Date(),
    })
    .where(and(eq(schema.documents.id, docId), eq(schema.documents.orgId, orgId)))

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
