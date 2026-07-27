import { serve } from '@upstash/workflow/hono'
import { createRoute } from '@bethel-nz/sumi/router'
import { GetObjectCommand } from '@aws-sdk/client-s3'
import { r2, R2_BUCKET } from '~/lib/memory/r2'
import { parseText } from '~/lib/knowledge/parsers/text.parser'
import { parseHtml } from '~/lib/knowledge/parsers/html.parser'
import { resolveIngestionStrategy } from '~/lib/knowledge/ingestion/ingestion-router'
import { updateJobProgress, getIngestionJob } from '~/lib/knowledge/services/progress.service'
import { drizzle, schema } from '~/lib/db'
import { eq, and } from 'drizzle-orm'

const workflowHandler = serve(async (workflow) => {
  const payload = workflow.requestPayload as {
    jobId: string
    orgId: string
    userId: string
    documentId: string
    r2Key: string
    contentType: string
    fileName: string
    title: string
  }

  const { jobId, orgId, userId, documentId, r2Key, contentType, fileName, title } = payload

  try {
    // Step 1: Verify job exists
    await workflow.run('verify', async () => {
      const job = await getIngestionJob(jobId, orgId)
      if (!job) throw new Error(`Job ${jobId} not found`)
      if (job.documentId !== documentId) throw new Error('Document ID mismatch')

      await updateJobProgress({
        jobId,
        orgId,
        documentId,
        status: 'processing',
        progress: 10,
        type: 'ingest.started',
        message: 'Ingestion workflow started',
      })
      return { ok: true }
    })

    // Step 2: Download from R2
    const fileBuffer = await workflow.run('download', async () => {
      await updateJobProgress({
        jobId,
        orgId,
        documentId,
        status: 'processing',
        progress: 20,
        type: 'r2.download.started',
        message: 'Downloading file from storage',
      })

      const result = await r2.send(
        new GetObjectCommand({
          Bucket: R2_BUCKET,
          Key: r2Key,
        }),
      )

      if (!result.Body) {
        throw new Error('R2 object has no body')
      }

      const chunks: Buffer[] = []
      for await (const chunk of result.Body as any) {
        chunks.push(Buffer.from(chunk))
      }

      await updateJobProgress({
        jobId,
        orgId,
        documentId,
        status: 'processing',
        progress: 30,
        type: 'r2.download.completed',
        message: 'File downloaded from storage',
      })

      return Buffer.concat(chunks)
    })

    // Step 3: Route and parse
    const strategy = resolveIngestionStrategy(contentType)

    if (strategy === 'unsupported') {
      await updateJobProgress({
        jobId,
        orgId,
        documentId,
        status: 'failed',
        progress: 0,
        type: 'ingest.failed',
        message: `Unsupported content type: ${contentType}`,
      })
      return { status: 'failed', reason: 'unsupported content type' }
    }

    let commitPayload: Record<string, unknown>

    if (strategy === 'custom-text') {
      const parsed = await parseText({ buffer: fileBuffer, contentType, fileName })
      commitPayload = {
        jobId,
        orgId,
        userId,
        documentId,
        title: parsed.title ?? title,
        sourceType: 'document',
        mode: 'text',
        text: parsed.text,
        sourceUrl: r2Key,
      }
    } else if (strategy === 'custom-html') {
      const parsed = await parseHtml({ buffer: fileBuffer, contentType, fileName })
      commitPayload = {
        jobId,
        orgId,
        userId,
        documentId,
        title: parsed.title ?? title,
        sourceType: 'document',
        mode: 'text',
        text: parsed.text,
        sourceUrl: r2Key,
      }
    } else {
      // native-file (PDF, DOCX, image, audio, video)
      commitPayload = {
        jobId,
        orgId,
        userId,
        documentId,
        title,
        sourceType: 'document',
        mode: 'native-file',
        r2Key,
        sourceUrl: r2Key,
      }
    }

    await updateJobProgress({
      jobId,
      orgId,
      documentId,
      status: 'processing',
      progress: 40,
      type: 'parse.completed',
      message: `Content parsed (${strategy})`,
    })

    // Step 4: Call internal commit endpoint (Railway owns the .mv2 file)
    const commitResult = await workflow.run('commit', async () => {
      await updateJobProgress({
        jobId,
        orgId,
        documentId,
        status: 'processing',
        progress: 50,
        type: 'memory.commit.started',
        message: 'Sending to memory commit endpoint',
      })

      const internalKey = process.env.INTERNAL_API_KEY
      const baseUrl = process.env.GREPPA_PUBLIC_URL ?? 'http://localhost:3000'

      const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/v1/internal/memory/commit`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-internal-api-key': internalKey ?? '',
        },
        body: JSON.stringify(commitPayload),
      })

      if (!res.ok) {
        const errorText = await res.text()
        throw new Error(`Commit failed: ${res.status} ${errorText}`)
      }

      const data = await res.json()

      await updateJobProgress({
        jobId,
        orgId,
        documentId,
        status: 'processing',
        progress: 80,
        type: 'memory.commit.completed',
        message: 'Memory commit completed',
      })

      return data as { documentId: string; status: string }
    })

    // Step 5: Finalize
    await workflow.run('finalize', async () => {
      await updateJobProgress({
        jobId,
        orgId,
        documentId,
        status: 'indexed',
        progress: 100,
        type: 'ingest.completed',
        message: 'Document ingested successfully',
      })
      return { status: 'indexed', documentId }
    })

    return commitResult
  } catch (err: any) {
    // Final failure handler — mark job and document as failed
    await updateJobProgress({
      jobId,
      orgId,
      documentId,
      status: 'failed',
      progress: 0,
      type: 'ingest.failed',
      message: err?.message ?? 'Unknown error during ingestion',
      payload: { error: err?.message, stack: err?.stack },
    })

    await drizzle
      .update(schema.documents)
      .set({ status: 'failed', failedAt: new Date(), failureReason: err?.message })
      .where(and(eq(schema.documents.id, documentId), eq(schema.documents.orgId, orgId)))

    return { status: 'failed', reason: err?.message }
  }
})

export default createRoute({
  post: {
    handler: workflowHandler as any,
    openapi: {
      summary: 'Internal: Document ingestion workflow',
      description:
        'Upstash Workflow handler for document ingestion. Downloads from R2, parses content, and commits through the internal memory commit endpoint. Never writes a scope database directly.',
      tags: ['internal'],
    },
  },
})
