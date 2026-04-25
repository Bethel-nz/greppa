import { z } from 'zod'
import { createRoute } from '@bethel-nz/sumi/router'
import { redis } from '../../lib/redis'

const querySchema = z.object({ sessionId: z.string().min(1) })

export default createRoute({
  get: {
    schema: { query: querySchema },
    middleware: ['session-auth'],
    handler: async (c) => {
      const { sessionId } = c.req.valid('query')
      const ctxSid = c.get('sessionId')
      const isDeployer = c.get('isDeployer')
      if (sessionId !== ctxSid && !isDeployer) {
        return c.json({ error: 'forbidden' }, 403)
      }

      const raw = (await redis.zrange(`history:${sessionId}`, 0, -1)) as string[]
      const messages = raw
        .map((r) => { try { return JSON.parse(r) } catch { return null } })
        .filter(Boolean)
      const lastActivityAt = messages.length ? messages[messages.length - 1].at : 0
      return c.json({ sessionId, messages, lastActivityAt })
    },
    openapi: {
      summary: 'Load conversation history for a session',
      tags: ['chat'],
      responses: { 200: { description: 'History payload' } },
    },
  },
  delete: {
    middleware: ['session-auth'],
    handler: async (c) => {
      const sid = c.get('sessionId')
      if (sid === 'deployer') return c.json({ error: 'pass real sessionId' }, 400)
      await redis.del(`history:${sid}`)
      return c.json({ deleted: true })
    },
    openapi: {
      summary: 'Wipe the current session conversation',
      tags: ['chat'],
      responses: { 200: { description: 'Wiped' } },
    },
  },
})