import { z } from 'zod'
import { createRoute } from '@bethel-nz/sumi/router'
import { addMemory, pageOrgDocuments } from '~/lib/memory/service'
import { getAclContext, MembershipError } from '~/lib/memory/acl'

import { placementBody, placementFromQuery, placementQuery } from '~/lib/memory/placement'
import { authErrors, requestErrors } from '../../../lib/errors'

const listQuery = placementQuery.extend({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().min(1).optional(),
})

const bodySchema = z.object({
  title: z.string().min(1),
  text: z.string().min(1),
  sourceType: z.enum(['note', 'chat', 'document', 'webpage', 'agent_event']),
  sourceUrl: z.string().optional(),
  ...placementBody,
})

export default createRoute({
  get: {
    schema: { query: listQuery },
    middleware: ['user-auth'],
    handler: async (c) => {
      const orgId = c.req.param('orgId')
      const userId = c.get('userId')
      if (!userId || !orgId) {
        throw requestErrors.SCOPE_CONTEXT_MISSING()
      }

      try {
        await getAclContext({ userId, orgId })
      } catch (err) {
        if (err instanceof MembershipError) {
          throw authErrors.FORBIDDEN()
        }
        throw err
      }

      const { limit, cursor } = c.req.valid('query')
      const { items: docs, nextCursor } = await pageOrgDocuments(orgId, {
        limit,
        cursor,
        scope: placementFromQuery(c),
      })
      return c.json({
        orgId,
        documents: docs.map((d) => ({
          id: d.id,
          title: d.title,
          sourceType: d.sourceType,
          workspaceId: d.workspaceId,
          folderId: d.folderId,
          createdAt: d.createdAt,
        })),
        nextCursor,
      })
    },
    openapi: {
      summary: 'List documents in org memory',
      tags: ['memory'],
      responses: {
        200: { description: 'Document list' },
        401: { description: 'Authentication required' },
        403: { description: 'Not a member of this org' },
      },
    },
  },

  post: {
    schema: { json: bodySchema },
    middleware: ['user-auth'],
    handler: async (c) => {
      const orgId = c.req.param('orgId')
      const userId = c.get('userId')
      if (!userId || !orgId) {
        throw requestErrors.SCOPE_CONTEXT_MISSING()
      }

      const { title, text, sourceType, sourceUrl, workspaceId, folderId } = c.req.valid('json')
      try {
        const result = await addMemory({
          userId,
          orgId,
          title,
          text,
          sourceType,
          sourceUrl,
          workspaceId,
          folderId,
        })
        return c.json(result, 201)
      } catch (err) {
        if (err instanceof MembershipError) {
          throw authErrors.FORBIDDEN()
        }
        throw err
      }
    },
    openapi: {
      summary: 'Add memory to org knowledge base',
      tags: ['memory'],
      responses: {
        201: { description: 'Memory indexed' },
        401: { description: 'Authentication required' },
        403: { description: 'Not a member of this org' },
      },
    },
  },
})
