import { eq, and, sql, count } from 'drizzle-orm'
import { drizzle, schema } from '~/lib/db'

export type ProgressUpdateInput = {
  jobId: string
  orgId: string
  documentId: string
  status?: string
  progress?: number
  type: string
  message: string
  payload?: Record<string, unknown>
}

export async function updateJobProgress(input: ProgressUpdateInput) {
  await drizzle.transaction(async (tx) => {
    await tx
      .update(schema.ingestionJobs)
      .set({
        status: input.status ?? sql`status`,
        progress: input.progress ?? sql`progress`,
        progressLabel: input.message,
        updatedAt: new Date(),
      })
      .where(eq(schema.ingestionJobs.id, input.jobId))

    await tx.insert(schema.ingestionJobEvents).values({
      id: crypto.randomUUID(),
      jobId: input.jobId,
      orgId: input.orgId,
      documentId: input.documentId,
      type: input.type,
      message: input.message,
      progress: input.progress,
      payload: input.payload ?? {},
    })
  })
}

export async function listJobEvents(jobId: string, orgId: string) {
  return drizzle
    .select()
    .from(schema.ingestionJobEvents)
    .where(
      and(
        eq(schema.ingestionJobEvents.jobId, jobId),
        eq(schema.ingestionJobEvents.orgId, orgId),
      ),
    )
    .orderBy(schema.ingestionJobEvents.createdAt)
}

export async function getIngestionJob(jobId: string, orgId: string) {
  return drizzle.query.ingestionJobs.findFirst({
    where: (j, { and, eq }) => and(eq(j.id, jobId), eq(j.orgId, orgId)),
  })
}

export async function getPendingJobs(limit: number = 10) {
  return drizzle
    .select()
    .from(schema.ingestionJobs)
    .where(eq(schema.ingestionJobs.status, 'pending'))
    .orderBy(schema.ingestionJobs.createdAt)
    .limit(limit)
}

export async function createIngestionJob(input: {
  orgId: string
  userId: string
  documentId: string
  sourceType: string
  contentType: string
  fileName?: string
  r2Key?: string
  sourceUrl?: string
}) {
  const id = crypto.randomUUID()
  await drizzle.insert(schema.ingestionJobs).values({
    id,
    orgId: input.orgId,
    userId: input.userId,
    documentId: input.documentId,
    sourceType: input.sourceType,
    contentType: input.contentType,
    fileName: input.fileName,
    r2Key: input.r2Key,
    sourceUrl: input.sourceUrl,
    status: 'pending',
    progress: 0,
  })
  return { id }
}
