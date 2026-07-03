import { z } from 'zod'
import { createRoute } from '@bethel-nz/sumi/router'
import { resolver } from 'hono-openapi/zod'
import { createIngestionJob } from '~/lib/knowledge/services/progress.service'
import { drizzle, schema } from '~/lib/db'
import { triggerIngestWorkflow } from '../../lib/workflow'

const bodySchema = z.object({
  key: z.string().min(1).describe('R2 object key returned from /knowledge/presign'),
  title: z.string().min(1).describe('Document title'),
  orgId: z.string().min(1).describe('Organization ID'),
  mimeType: z.string().optional().default('application/octet-stream').describe('MIME type of the file'),
})

const responseSchema = z.object({
  jobId: z.string(),
  documentId: z.string(),
  status: z.string(),
})

export default createRoute({
  post: {
    schema: { json: bodySchema },
    middleware: ['user-auth'],
    handler: async (c) => {
      const userId = c.get('userId')
      if (!userId) {
        return c.json({ error: 'authentication required' }, 401)
      }

      const { key, title, orgId, mimeType } = c.req.valid('json')
      const fileName = key.split('/').pop() ?? 'unknown'

      // Create document record
      const documentId = crypto.randomUUID()
      await drizzle.insert(schema.documents).values({
        id: documentId,
        orgId,
        ownerUserId: userId,
        title,
        sourceType: 'document',
        contentType: mimeType,
        r2Key: key,
        fileName,
        status: 'pending',
      })

      // Create ingestion job
      const { id: jobId } = await createIngestionJob({
        orgId,
        userId,
        documentId,
        sourceType: 'document',
        contentType: mimeType,
        fileName,
        r2Key: key,
      })

      // Trigger async workflow
      await triggerIngestWorkflow({
        jobId,
        orgId,
        userId,
        documentId,
        r2Key: key,
        contentType: mimeType,
        fileName,
        title,
      })

      return c.json({
        jobId,
        documentId,
        status: 'queued',
      }, 202)
    },
    openapi: {
      summary: 'Ingest an uploaded document',
      description:
        'Creates a document record and ingestion job, then triggers the async ingestion workflow. Subscribe to GET /orgs/:orgId/knowledge/jobs/stream?jobId=:jobId for SSE progress updates.',
      tags: ['knowledge'],
      responses: {
        202: {
          description: 'Ingestion queued',
          content: { 'application/json': { schema: resolver(responseSchema) } },
        },
        401: { description: 'Authentication required' },
      },
    },
  },
})
