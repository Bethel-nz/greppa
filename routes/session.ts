import { z } from 'zod'
import { createRoute } from '@bethel-nz/sumi/router'
import { ulid } from 'ulid'
import { resolver } from 'hono-openapi/zod'
import { loadGreppaConfig } from '../lib/config'
import { redis } from '../lib/redis'

const postResponseSchema = z.object({
  sessionId: z.string(),
  ttlMs: z.number(),
})

const deleteResponseSchema = z.object({
  deleted: z.boolean(),
})

export default createRoute({
  post: {
    handler: async (c) => {
      const cfg = loadGreppaConfig()
      const sessionId = ulid()
      const ttlS = Math.floor(cfg.sessionTtlMs / 1000)
      try {
        await redis.set(
          `session:${sessionId}`,
          JSON.stringify({ mintedAt: Date.now(), lastSeenAt: Date.now() }),
          { ex: ttlS },
        )
      } catch {
      }
      return c.json({ sessionId, ttlMs: cfg.sessionTtlMs })
    },
    openapi: {
      summary: 'Mint a new conversation session',
      description: 'Creates a new anonymous conversation session. Returns a sessionId to use in x-greppa-session header.',
      tags: ['session'],
      responses: {
        200: {
          description: 'Session created',
          content: { 'application/json': { schema: resolver(postResponseSchema) } },
        },
      },
    },
  },
  delete: {
    middleware: ['session-auth'],
    handler: async (c) => {
      const conversationId = c.get('conversationId')
      await Promise.all([
        redis.del(`session:${conversationId}`),
        redis.del(`history:${conversationId}`),
      ])
      return c.json({ deleted: true })
    },
    openapi: {
      summary: 'Revoke the current session conversation',
      description: 'Deletes the session and all associated conversation history from Redis.',
      tags: ['session'],
      responses: {
        200: {
          description: 'Session deleted',
          content: { 'application/json': { schema: resolver(deleteResponseSchema) } },
        },
        401: { description: 'Session header required' },
      },
    },
  },
})
