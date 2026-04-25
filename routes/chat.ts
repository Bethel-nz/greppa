import { z } from 'zod'
import { createRoute } from '@bethel-nz/sumi/router'
import { ulid } from 'ulid'
import { redis } from '../lib/redis'
import { loadGreppaConfig } from '../lib/config'
import { triggerChatWorkflow } from '../lib/workflow'

const bodySchema = z.object({
  message: z.string().min(1),
  model: z.string().optional().default('llama-3.3-70b-versatile'),
})

export default createRoute({
  post: {
    schema: { json: bodySchema },
    middleware: ['session-auth', 'rate-limit'],
    handler: async (c) => {
      const { message, model } = c.req.valid('json')
      const sessionId = c.get('sessionId')
      const cfg = loadGreppaConfig()
      const messageId = ulid()
      const now = Date.now()

      const userMsg = { id: ulid(), role: 'user' as const, content: message, at: now }
      await redis.zadd(`history:${sessionId}`, { score: now, member: JSON.stringify(userMsg) })
      await redis.expire(`history:${sessionId}`, Math.floor(cfg.sessionTtlMs / 1000))

      await redis.hset(`msg:${messageId}:meta`, {
        sessionId,
        status: 'queued',
        startedAt: now,
        model,
      })
      await redis.expire(`msg:${messageId}:meta`, Math.floor(cfg.messageTtlMs / 1000))

      await triggerChatWorkflow({ sessionId, messageId, message, model })

      return c.json({ messageId, channel: `msg:${messageId}` }, 202)
    },
    openapi: {
      summary: 'Enqueue a chat generation',
      tags: ['chat'],
      responses: {
        202: { description: 'Generation enqueued; subscribe to /chat/stream?messageId=' },
      },
    },
  },
})