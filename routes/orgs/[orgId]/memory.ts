import { z } from 'zod'
import { createRoute } from '@bethel-nz/sumi/router'
import { addMemory, getOrgDocumentTimeline } from '~/lib/memory/service'
import { getAclContext, MembershipError } from '~/lib/memory/acl'

const bodySchema = z.object({
  title: z.string().min(1),
  text: z.string().min(1),
  sourceType: z.enum(['note', 'chat', 'document', 'webpage', 'agent_event']),
  sourceUrl: z.string().optional(),
})

export default createRoute({
  get: {
    middleware: ['user-auth'],
    handler: async (c) => {
      const orgId = c.req.param('orgId')
      const userId = c.get('userId')
      if (!userId || !orgId) {
        return c.json({ error: 'missing org or user context' }, 400)
      }

      // Authorize: caller must be a member of this org before seeing its documents.
      try {
        await getAclContext({ userId, orgId })
      } catch (err) {
        if (err instanceof MembershipError) {
          return c.json({ error: 'forbidden' }, 403)
        }
        throw err
      }

      const docs = await getOrgDocumentTimeline(orgId, 100)
      return c.json({
        orgId,
        documents: docs.map((d) => ({
          id: d.id,
          title: d.title,
          sourceType: d.sourceType,
          createdAt: d.createdAt,
        })),
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
        return c.json({ error: 'missing org or user context' }, 400)
      }

      const { title, text, sourceType, sourceUrl } = c.req.valid('json')
      try {
        const result = await addMemory({
          userId,
          orgId,
          title,
          text,
          sourceType,
          sourceUrl,
        })
        return c.json(result, 201)
      } catch (err) {
        if (err instanceof MembershipError) {
          return c.json({ error: 'forbidden' }, 403)
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
