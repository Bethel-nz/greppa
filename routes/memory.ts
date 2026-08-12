import { z } from 'zod'
import { createRoute } from '@bethel-nz/sumi/router'
import { resolver } from 'hono-openapi/zod'
import { addScopedMemory } from '~/lib/memory/scoped-service'
import { placementBody } from '~/lib/memory/placement'
import { authErrors } from '../lib/errors'

const edgeSchema = z.object({
  source: z.string().min(1).describe('The entity the relationship starts from.'),
  target: z.string().min(1).describe('The entity the relationship points to.'),
  relation: z.string().min(1).describe('A compact verb or relationship, such as "works on".'),
  weight: z.number().positive().optional().describe('Optional strength or confidence. Defaults to 1.'),
})

const bodySchema = z.object({
  title: z.string().min(1).describe('A short title for this memory.'),
  text: z.string().min(1).describe('The memory itself, stated clearly and self-contained.'),
  sourceType: z
    .enum(['note', 'chat', 'fact', 'document', 'webpage', 'agent_event'])
    .optional()
    .default('note')
    .describe('What kind of memory this is.'),
  sourceUrl: z.string().optional().describe('Where this came from, if anywhere.'),
  id: z
    .string()
    .min(1)
    .optional()
    .describe('Your own id for this memory. Re-sending one returns the existing record instead of storing it twice.'),
  edges: z
    .array(edgeSchema)
    .max(50)
    .optional()
    .default([])
    .describe(
      'Relationships this memory states. A memory stored with edges is retrievable later from either entity, not only by its wording.',
    ),
  ...placementBody,
})

const responseSchema = z.object({
  documentId: z.string(),
  status: z.enum(['indexed', 'duplicate']),
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

      const body = c.req.valid('json')
      const result = await addScopedMemory({
        userId,
        id: body.id,
        title: body.title,
        text: body.text,
        sourceType: body.sourceType,
        sourceUrl: body.sourceUrl,
        edges: body.edges,
        workspaceId: body.workspaceId,
        folderId: body.folderId,
      })

      return c.json(
        { documentId: result.documentId, status: result.status },
        result.status === 'duplicate' ? 200 : 201,
      )
    },
    openapi: {
      summary: 'Store a memory',
      description:
        "Writes into the caller's personal memory. Unlike POST /knowledge, which stores a document, this accepts relationship edges: a memory stored with edges is reachable later from either entity named in it, even by a question that shares no wording with the text.",
      tags: ['memory'],
      responses: {
        200: {
          description: 'A memory with this id already existed; it was returned unchanged',
          content: { 'application/json': { schema: resolver(responseSchema) } },
        },
        201: {
          description: 'Memory stored',
          content: { 'application/json': { schema: resolver(responseSchema) } },
        },
        400: { description: 'Invalid request body' },
        401: { description: 'Authentication required' },
        429: { description: 'Rate limit exceeded' },
      },
    },
  },
})
