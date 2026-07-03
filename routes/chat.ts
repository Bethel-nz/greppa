import { z } from 'zod'
import { createRoute } from '@bethel-nz/sumi/router'
import { ulid } from 'ulid'
import { resolver } from 'hono-openapi/zod'
import { redis } from '../lib/redis'
import { loadGreppaConfig } from '../lib/config'
import { triggerChatWorkflow } from '../lib/workflow'

const bodySchema = z.object({
  message: z.string().min(1).describe('The message to send to the AI'),
  model: z.string().optional().default('llama-3.3-70b-versatile').describe('Groq model to use'),
  context: z.object({
    selection: z.string().optional().describe('Selected text from a document'),
    source: z.string().optional().describe('Source URL or identifier'),
    title: z.string().optional().describe('Document title'),
    surrounding: z.string().optional().describe('Surrounding text context'),
  }).optional().describe('Optional context for RAG grounding'),
  orgId: z.string().optional().describe('Organization ID for multi-tenant knowledge access'),
})

const responseSchema = z.object({
  messageId: z.string(),
  channel: z.string(),
})

const ANON_MSG_LIMIT = 5

export default createRoute({
  post: {
    schema: { json: bodySchema },
    middleware: ['session-auth', 'rate-limit'],
    handler: async (c) => {
      const { message, model, context, orgId } = c.req.valid('json')
      const conversationId = c.get('conversationId')
      const isAnonymous = c.get('isAnonymous')
      const userId = c.get('userId')
      const cfg = loadGreppaConfig()
      const messageId = ulid()
      const now = Date.now()

      // Anonymous rate limit: 5 messages per conversation
      if (isAnonymous) {
        const count = await redis.incr(`anon:msg_count:${conversationId}`)
        if (count > ANON_MSG_LIMIT) {
          return c.json({ error: 'anonymous message limit reached. sign in to continue.' }, 429)
        }
        await redis.expire(`anon:msg_count:${conversationId}`, Math.floor(cfg.sessionTtlMs / 1000))
      }

      const userMsg = { id: ulid(), role: 'user' as const, content: message, context, at: now }
      await redis.zadd(`history:${conversationId}`, { score: now, member: JSON.stringify(userMsg) })
      await redis.expire(`history:${conversationId}`, Math.floor(cfg.sessionTtlMs / 1000))

      await redis.hset(`msg:${messageId}:meta`, {
        conversationId,
        status: 'queued',
        startedAt: now,
        model,
      })
      await redis.expire(`msg:${messageId}:meta`, Math.floor(cfg.messageTtlMs / 1000))

      await triggerChatWorkflow({
        conversationId,
        messageId,
        message,
        model,
        context,
        userId,
        orgId,
      })

      return c.json({ messageId, channel: `msg:${messageId}` }, 202)
    },
    openapi: {
      summary: 'Enqueue a chat generation',
      description: 'Queues a message for AI processing. Subscribe to /chat/stream?messageId={messageId} for SSE responses.',
      tags: ['chat'],
      responses: {
        202: {
          description: 'Generation enqueued',
          content: { 'application/json': { schema: resolver(responseSchema) } },
        },
        400: { description: 'Invalid request body' },
        401: { description: 'Session header required' },
        429: { description: 'Rate limit exceeded or anonymous message limit reached' },
      },
    },
  },
})
