import { z } from 'zod'
import { createRoute } from '@bethel-nz/sumi/router'
import { auth } from '~/lib/auth'

const createSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  expiresInDays: z.number().int().min(1).max(365).optional(),
})

export default createRoute({
  get: {
    middleware: ['user-auth'],
    handler: async (c) => {
      const apiKeys = await auth.api.listApiKeys({ headers: c.req.raw.headers })
      return c.json({ apiKeys })
    },
    openapi: {
      summary: 'List the current user API keys',
      tags: ['auth'],
      responses: {
        200: { description: 'API keys (no secret values)' },
        401: { description: 'Authentication required' },
      },
    },
  },

  post: {
    schema: { json: createSchema },
    middleware: ['user-auth'],
    handler: async (c) => {
      const { name, expiresInDays } = c.req.valid('json')
      const created = await auth.api.createApiKey({
        body: {
          name,
          expiresIn: expiresInDays ? expiresInDays * 86_400 : undefined,
        },
        headers: c.req.raw.headers,
      })
      return c.json(created, 201)
    },
    openapi: {
      summary: 'Create an API key (plaintext key returned once)',
      tags: ['auth'],
      responses: {
        201: { description: 'Created API key, including the one-time plaintext key' },
        401: { description: 'Authentication required' },
      },
    },
  },
})
