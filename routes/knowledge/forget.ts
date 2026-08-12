import { z } from 'zod'
import { createRoute } from '@bethel-nz/sumi/router'
import { resolver } from 'hono-openapi/zod'
import { deleteScopedMemory } from '~/lib/memory/scoped-service'
import { authErrors } from '../../lib/errors'

const bodySchema = z.object({
  documentIds: z
    .array(z.string().min(1))
    .min(1)
    .max(200)
    .describe('Documents to forget from your personal scope.'),
})

const responseSchema = z.object({
  deleted: z.number().describe('How many documents were still present and have now been forgotten'),
})

export default createRoute({
  post: {
    schema: { json: bodySchema },
    middleware: ['user-auth'],
    handler: async (c) => {
      const userId = c.get('userId')
      if (!userId) {
        throw authErrors.REQUIRED()
      }

      const { documentIds } = c.req.valid('json')
      const { deleted } = await deleteScopedMemory({ userId, documentIds })
      return c.json({ deleted })
    },
    openapi: {
      summary: 'Forget documents from your personal memory',
      description:
        'Tombstones documents in your personal scope so search, stored facts and relationships stop returning them. Already-forgotten or unknown ids are counted as zero rather than treated as an error.',
      tags: ['knowledge'],
      responses: {
        200: {
          description: 'Documents forgotten',
          content: { 'application/json': { schema: resolver(responseSchema) } },
        },
        401: { description: 'Authentication required' },
      },
    },
  },
})
