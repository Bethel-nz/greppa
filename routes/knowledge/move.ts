import { z } from 'zod'
import { createRoute } from '@bethel-nz/sumi/router'
import { resolver } from 'hono-openapi/zod'
import { moveScopedMemory } from '~/lib/memory/scoped-service'
import { authErrors, requestErrors } from '../../lib/errors'

const placement = z
  .string()
  .min(1)
  .nullable()
  .optional()

const bodySchema = z.object({
  documentIds: z
    .array(z.string().min(1))
    .min(1)
    .max(200)
    .describe('Documents to reposition inside your personal scope.'),
  workspaceId: placement.describe(
    'Workspace to move the documents into. Send null to unplace them, omit to leave the workspace unchanged.',
  ),
  folderId: placement.describe(
    'Folder to move the documents into. Send null to unplace them, omit to leave the folder unchanged.',
  ),
})

const responseSchema = z.object({
  moved: z.number().describe('How many documents actually changed placement'),
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

      const { documentIds, workspaceId, folderId } = c.req.valid('json')
      if (workspaceId === undefined && folderId === undefined) {
        throw requestErrors.PLACEMENT_REQUIRED()
      }

      const { moved } = await moveScopedMemory({ userId, documentIds, workspaceId, folderId })
      return c.json({ moved })
    },
    openapi: {
      summary: 'Move documents between workspaces and folders',
      description:
        'Repositions documents already stored in your personal scope. Omitted placements are left alone, null clears them.',
      tags: ['knowledge'],
      responses: {
        200: {
          description: 'Documents repositioned',
          content: { 'application/json': { schema: resolver(responseSchema) } },
        },
        400: { description: 'No placement supplied' },
        401: { description: 'Authentication required' },
      },
    },
  },
})
