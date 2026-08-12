import { z } from 'zod'
import { createRoute } from '@bethel-nz/sumi/router'
import { searchMemory } from '~/lib/memory/service'
import { MembershipError } from '~/lib/memory/acl'

import { placementBody } from '~/lib/memory/placement'
import { authErrors, requestErrors } from '../../../../lib/errors'

const bodySchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(50).optional().default(8),
  ...placementBody,
})

export default createRoute({
  post: {
    schema: { json: bodySchema },
    middleware: ['user-auth'],
    handler: async (c) => {
      const orgId = c.req.param('orgId')
      const userId = c.get('userId')
      if (!userId || !orgId) {
        throw requestErrors.SCOPE_CONTEXT_MISSING()
      }

      const { query, limit, workspaceId, folderId } = c.req.valid('json')
      try {
        const results = await searchMemory({ userId, orgId, query, limit, workspaceId, folderId })
        return c.json({ orgId, query, results })
      } catch (err) {
        if (err instanceof MembershipError) {
          throw authErrors.FORBIDDEN()
        }
        throw err
      }
    },
    openapi: {
      summary: 'Search org memory with ACL enforcement',
      tags: ['memory'],
      responses: {
        200: { description: 'Search results' },
        401: { description: 'Authentication required' },
        403: { description: 'Not a member of this org' },
      },
    },
  },
})
