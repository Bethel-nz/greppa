import { z } from 'zod'
import { createRoute } from '@bethel-nz/sumi/router'
import { resolver } from 'hono-openapi/zod'
import { listScopedMemoryEdges, resolveScopedEntities } from '~/lib/memory/scoped-service'
import { placementFromQuery, placementQuery } from '~/lib/memory/placement'
import { authErrors } from '../../lib/errors'

const querySchema = z.object({
  entity: z.string().min(1).optional().describe('Focus the graph around one entity.'),
  relation: z.string().min(1).optional().describe('Only return relationships of this type.'),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  ...placementQuery.shape,
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
  edges: z.array(edgeSchema),
  matched: z
    .array(z.string())
    .describe('Stored entity names the `entity` argument resolved to. Empty when it resolved to nothing.'),
  suggested: z
    .array(z.string())
    .describe('Stored entity names resembling an `entity` that resolved to nothing. Retry with one of these.'),
})

export default createRoute({
  get: {
    schema: { query: querySchema },
    middleware: ['user-auth', 'rate-limit'],
    handler: async (c) => {
      const userId = c.get('userId')
      if (!userId) {
        throw authErrors.REQUIRED()
      }

      const { entity, relation, limit } = c.req.valid('query')
      const placement = placementFromQuery(c)

      const edges = await listScopedMemoryEdges({
        userId,
        entity,
        relation,
        limit,
        workspaceId: placement.workspaceId,
        folderId: placement.folderId,
      })

      // An entity that matched nothing is the common failure here, and the
      // caller cannot fix it without knowing how the name is actually spelled.
      if (edges.length === 0 && entity) {
        const resolved = await resolveScopedEntities({ userId, text: entity })
        return c.json({ edges, ...resolved })
      }

      return c.json({ edges, matched: [], suggested: [] })
    },
    openapi: {
      summary: 'List stored relationships',
      description:
        'Returns relationships, never document text. Use it when the relationships are the answer: who owns or decided something, how two entities connect. When `entity` resolves to nothing, the response carries the stored names that resemble it so the call can be retried with one of them.',
      tags: ['memory'],
      responses: {
        200: {
          description: 'Relationships, plus entity resolution when nothing matched',
          content: { 'application/json': { schema: resolver(responseSchema) } },
        },
        400: { description: 'Invalid query parameters' },
        401: { description: 'Authentication required' },
        429: { description: 'Rate limit exceeded' },
      },
    },
  },
})
