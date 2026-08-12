import { z } from 'zod'
import { createRoute } from '@bethel-nz/sumi/router'
import { resolver } from 'hono-openapi/zod'
import { searchScopedMemory } from '~/lib/memory/scoped-service'
import { placementBody } from '~/lib/memory/placement'
import { authErrors } from '../../lib/errors'

const bodySchema = z.object({
  query: z.string().min(1).describe('What to look for. Name entities exactly as they are stored.'),
  limit: z.number().int().min(1).max(50).optional().default(8),
  ...placementBody,
})

const hitSchema = z.object({
  documentId: z.string(),
  chunkId: z.number(),
  title: z.string(),
  snippet: z.string(),
  text: z.string(),
  score: z.number(),
  sourceType: z.string(),
  sourceUrl: z.string().nullable(),
  modality: z.string(),
  assetSha256: z.string().nullable(),
})

const edgeSchema = z.object({
  source: z.string(),
  target: z.string(),
  relation: z.string(),
  weight: z.number(),
  documentId: z.string(),
  documentTitle: z.string(),
  createdAt: z.number(),
})

const responseSchema = z.object({
  query: z.string(),
  hits: z.array(hitSchema),
  total_hits: z.number(),
  edges: z.array(edgeSchema).describe('Relationships backing the returned hits, if any.'),
})

export default createRoute({
  post: {
    schema: { json: bodySchema },
    middleware: ['user-auth', 'rate-limit'],
    handler: async (c) => {
      const userId = c.get('userId')
      if (!userId) {
        throw authErrors.REQUIRED()
      }

      const { query, limit, workspaceId, folderId } = c.req.valid('json')
      const result = await searchScopedMemory({ userId, query, limit, workspaceId, folderId })
      return c.json({ query, ...result })
    },
    openapi: {
      summary: 'Search personal memory',
      description:
        'Searches wording, meaning, and the stored relationship graph in a single pass, and returns the relationships behind the hits alongside them. Naming an entity exactly as it is stored reaches memories linked to it that share no wording with the query.',
      tags: ['memory'],
      responses: {
        200: {
          description: 'Search results',
          content: { 'application/json': { schema: resolver(responseSchema) } },
        },
        400: { description: 'Invalid request body' },
        401: { description: 'Authentication required' },
        429: { description: 'Rate limit exceeded' },
      },
    },
  },
})
