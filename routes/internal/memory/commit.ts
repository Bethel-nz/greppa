import { z } from 'zod'
import { createRoute } from '@bethel-nz/sumi/router'
import { resolver } from 'hono-openapi/zod'
import { commitMemoryCard } from '~/lib/memory/service'
import { enqueueMemoryWrite } from '~/lib/memory/queue'
import { getAclContext } from '~/lib/memory/acl'
import { updateJobProgress } from '~/lib/knowledge/services/progress.service'
import { drizzle, schema } from '~/lib/db'
import { eq, and } from 'drizzle-orm'

const commitSchema = z.object({
  jobId: z.string().min(1),
  orgId: z.string().min(1),
  userId: z.string().min(1),
  documentId: z.string().min(1),
  title: z.string().min(1),
  sourceType: z.enum(['note', 'chat', 'document', 'webpage', 'agent_event']),
  mode: z.enum(['text', 'memvid-native-file']).default('text'),
  text: z.string().optional(),
  r2Key: z.string().optional(),
  sourceUrl: z.string().optional(),
})

const responseSchema = z.object({
  documentId: z.string(),
  status: z.string(),
})

export default createRoute({
  post: {
    schema: { json: commitSchema },
    handler: async (c) => {
      const internalKey = c.req.header('x-internal-api-key')
      if (internalKey !== process.env.INTERNAL_API_KEY) {
        return c.json({ error: 'unauthorized' }, 401)
      }

      const body = c.req.valid('json')

      // Re-verify membership before any write.
      let acl
      try {
        acl = await getAclContext({ userId: body.userId, orgId: body.orgId })
      } catch {
        return c.json({ error: 'membership verification failed' }, 403)
      }

      if (body.mode === 'text' && !body.text) {
        return c.json({ error: 'text is required for mode "text"' }, 400)
      }

      // Native-file ingestion (download from R2 + parse) is not implemented yet.
      // Fail loudly rather than indexing placeholder text into ACL-scoped memory.
      if (body.mode === 'memvid-native-file') {
        return c.json({ error: 'memvid-native-file ingestion not implemented' }, 501)
      }

      const result = await enqueueMemoryWrite(async () => {
        await updateJobProgress({
          jobId: body.jobId,
          orgId: body.orgId,
          documentId: body.documentId,
          status: 'committing',
          progress: 60,
          type: 'memvid.commit.started',
          message: 'Writing document into memory',
        })

        await commitMemoryCard({
          acl,
          userId: body.userId,
          documentId: body.documentId,
          title: body.title,
          text: body.text!,
          sourceType: body.sourceType,
          sourceUrl: body.sourceUrl,
        })

        await updateJobProgress({
          jobId: body.jobId,
          orgId: body.orgId,
          documentId: body.documentId,
          status: 'indexed',
          progress: 100,
          type: 'r2.sync.completed',
          message: 'Memory sealed and synced to R2',
        })

        // Update document status
        await drizzle
          .update(schema.documents)
          .set({ status: 'indexed', indexedAt: new Date() })
          .where(
            and(eq(schema.documents.id, body.documentId), eq(schema.documents.orgId, body.orgId)),
          )

        return { documentId: body.documentId, status: 'indexed' }
      })

      return c.json(result)
    },
    openapi: {
      summary: 'Internal: Commit memory write',
      description: 'Internal endpoint for Trigger.dev or workers to commit writes to the active Memvid file. Requires x-internal-api-key.',
      tags: ['internal'],
      responses: {
        200: {
          description: 'Memory committed',
          content: { 'application/json': { schema: resolver(responseSchema) } },
        },
        400: { description: 'Invalid request body' },
        401: { description: 'Invalid internal key' },
        403: { description: 'Membership verification failed' },
        501: { description: 'Mode not implemented' },
      },
    },
  },
})
