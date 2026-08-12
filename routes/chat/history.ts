import { z } from 'zod'
import { createRoute } from '@bethel-nz/sumi/router'
import { resolver } from 'hono-openapi/zod'
import { redis } from '~/lib/redis'

import { authErrors } from '../../lib/errors'
const querySchema = z.object({
  sessionId: z.string().min(1).describe('Conversation session ID to fetch history for'),
})

const messageSchema = z.object({
  id: z.string(),
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  at: z.number(),
})

const historyResponseSchema = z.object({
  sessionId: z.string(),
  messages: z.array(messageSchema),
  lastActivityAt: z.number(),
})

const deleteResponseSchema = z.object({
  deleted: z.boolean(),
})

export default createRoute({
  get: {
    schema: { query: querySchema },
    middleware: ['session-auth'],
    handler: async (c) => {
      const { sessionId } = c.req.valid('query')
      const conversationId = c.get('conversationId')
      if (sessionId !== conversationId) {
        throw authErrors.FORBIDDEN()
      }

      const raw = (await redis.zrange(`history:${sessionId}`, 0, -1)) as unknown[]
      const messages = raw
        .map((value) => {
          try {
            const message = typeof value === 'string' ? JSON.parse(value) : value
            return messageSchema.safeParse(message).data ?? null
          } catch {
            return null
          }
        })
        .filter((message): message is z.infer<typeof messageSchema> => message !== null)
      const lastActivityAt = messages.length ? messages[messages.length - 1].at : 0
      return c.json({ sessionId, messages, lastActivityAt })
    },
    openapi: {
      summary: 'Load conversation history',
      description: 'Returns all messages in a conversation, ordered chronologically.',
      tags: ['chat'],
      responses: {
        200: {
          description: 'Conversation history',
          content: { 'application/json': { schema: resolver(historyResponseSchema) } },
        },
        401: { description: 'Session header required' },
        403: { description: 'Session ID mismatch' },
      },
    },
  },
  delete: {
    middleware: ['session-auth'],
    handler: async (c) => {
      const conversationId = c.get('conversationId')
      await redis.del(`history:${conversationId}`)
      return c.json({ deleted: true })
    },
    openapi: {
      summary: 'Wipe conversation history',
      description: 'Permanently deletes all messages for the current conversation.',
      tags: ['chat'],
      responses: {
        200: {
          description: 'History wiped',
          content: { 'application/json': { schema: resolver(deleteResponseSchema) } },
        },
        401: { description: 'Session header required' },
      },
    },
  },
})
