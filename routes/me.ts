import { z } from 'zod'
import { createRoute } from '@bethel-nz/sumi/router'
import { resolver } from 'hono-openapi/zod'

const responseSchema = z.object({
  user: z.object({
    id: z.string(),
    email: z.string(),
    name: z.string().nullable(),
    emailVerified: z.boolean(),
    image: z.string().nullable(),
  }),
  session: z.object({
    id: z.string(),
    userId: z.string(),
    expiresAt: z.string().datetime(),
  }),
})

export default createRoute({
  get: {
    middleware: ['user-auth'],
    handler: async (c) => {
      const user = c.get('authUser')!
      const session = c.get('authSession')!

      return c.json({
        user: {
          id: user.id,
          email: user.email,
          name: user.name ?? null,
          emailVerified: user.emailVerified,
          image: user.image ?? null,
        },
        session: {
          id: session.id,
          userId: session.userId,
          expiresAt: session.expiresAt.toISOString(),
        },
      })
    },
    openapi: {
      summary: 'Get the current authenticated user',
      tags: ['auth'],
      responses: {
        200: {
          description: 'Authenticated user session',
          content: { 'application/json': { schema: resolver(responseSchema) } },
        },
        401: { description: 'Authentication required' },
      },
    },
  },
})
