import { serve } from '@upstash/workflow/hono'
import { createRoute } from '@bethel-nz/sumi/router'
import { getStorage } from '~/lib/storage'
import { extractEdges } from '~/lib/memory/extract-edges'
import { parseText } from '~/lib/knowledge/parsers/text.parser'
import { parseHtml } from '~/lib/knowledge/parsers/html.parser'
import { parseAnyDoc } from '~/lib/knowledge/parsers/anydoc.parser'
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

      const object = await getStorage().get(r2Key)
      if (!object) {
        throw new Error(`Upload ${r2Key} is missing from storage`)
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

      return Buffer.from(object.body)
    })

    const strategy = resolveIngestionStrategy(contentType, fileName)

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
    } else if (strategy === 'anydoc') {
      const parsed = await parseAnyDoc({ buffer: fileBuffer, contentType, fileName })
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
      throw new Error(`No parser configured for strategy: ${strategy}`)
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

    // Its own step so a retried commit does not pay for extraction twice.
    commitPayload.edges = await workflow.run('extract-edges', async () => {
      const edges = await extractEdges({
        title: String(commitPayload.title ?? title),
        text: String(commitPayload.text ?? ''),
      })

      await updateJobProgress({
        jobId,
        orgId,
        documentId,
        status: 'processing',
        progress: 45,
        type: 'graph.extract.completed',
        message: edges.length
          ? `Found ${edges.length} relationship${edges.length === 1 ? '' : 's'}`
          : 'No relationships found',
      })

      return edges
    })

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
