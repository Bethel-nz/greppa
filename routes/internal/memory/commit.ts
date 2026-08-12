import { z } from 'zod'
import { createRoute } from '@bethel-nz/sumi/router'
import { resolver } from 'hono-openapi/zod'
import { commitMemoryCard } from '~/lib/memory/service'
import { MAX_EXTRACTED_EDGES } from '~/lib/memory/extract-edges'
import { enqueueMemoryWrite } from '~/lib/memory/queue'
import { getAclContext } from '~/lib/memory/acl'
import { updateJobProgress } from '~/lib/knowledge/services/progress.service'
import { drizzle, schema } from '~/lib/db'
import { eq, and } from 'drizzle-orm'

import { authErrors, requestErrors } from '../../../lib/errors'
const commitSchema = z.object({
  jobId: z.string().min(1),
  orgId: z.string().min(1),
  userId: z.string().min(1),
  documentId: z.string().min(1),
  title: z.string().min(1),
  sourceType: z.enum(['note', 'chat', 'document', 'webpage', 'agent_event']),
  mode: z.literal('text').default('text'),
  text: z.string().optional(),
  r2Key: z.string().optional(),
  sourceUrl: z.string().optional(),
  edges: z
    .array(
      z.object({
        source: z.string().min(1).max(120),
        target: z.string().min(1).max(120),
        relation: z.string().min(1).max(60),
        weight: z.number().positive().max(100).optional(),
      }),
    )
    .max(MAX_EXTRACTED_EDGES)
    .optional()
    .describe('Relationships extracted from the document during ingestion.'),
})

const responseSchema = z.object({
  documentId: z.string(),
  status: z.string(),
})

export default createRoute({
  post: {
    schema: { json: commitSchema },
    handler: async (c) => {
      // Both sides being undefined must not read as a match: with
      // INTERNAL_API_KEY unset, a request carrying no header would otherwise
      // authenticate itself against nothing.
      const expected = process.env.INTERNAL_API_KEY
      if (!expected) {
        console.error('[internal] INTERNAL_API_KEY is not configured; refusing every commit')
        throw authErrors.REQUIRED()
      }
      const internalKey = c.req.header('x-internal-api-key')
      if (!internalKey || internalKey !== expected) {
        throw authErrors.REQUIRED()
      }

      const body = c.req.valid('json')

      const acl = await getAclContext({ userId: body.userId, orgId: body.orgId }).catch(() => {
        throw authErrors.MEMBERSHIP_UNVERIFIABLE()
      })

      if (body.mode === 'text' && !body.text) {
        throw requestErrors.FIELD_REQUIRED({ field: 'text, for mode "text"' })
      }

      const result = await enqueueMemoryWrite(async () => {
        await updateJobProgress({
          jobId: body.jobId,
          orgId: body.orgId,
          documentId: body.documentId,
          status: 'committing',
          progress: 60,
          type: 'memory.commit.started',
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
          edges: body.edges,
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
      description: "Internal endpoint for workers to commit writes into an organisation's scope database. Requires x-internal-api-key.",
      tags: ['internal'],
      responses: {
        200: {
          description: 'Memory committed',
          content: { 'application/json': { schema: resolver(responseSchema) } },
        },
        400: { description: 'Invalid request body' },
        401: { description: 'Invalid internal key' },
        403: { description: 'Membership verification failed' },
      },
    },
  },
})
