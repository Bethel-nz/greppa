import { z } from 'zod'
import { createRoute } from '@bethel-nz/sumi/router'
import { ulid } from 'ulid'
import { signSessionId } from '../lib/hmac'
import { loadGreppaConfig } from '../lib/config'
import { redis } from '../lib/redis'

const responseSchema = z.object({
  sessionId: z.string(),
  sig: z.string(),
  ttlMs: z.number(),
})

export default createRoute({
  post: {
    handler: async (c) => {
      const cfg = loadGreppaConfig()
      const sessionId = ulid()
      const sig = signSessionId(sessionId, cfg.sessionSecret)
      const ttlS = Math.floor(cfg.sessionTtlMs / 1000)
      try {
        await redis.set(
          `session:${sessionId}`,
          JSON.stringify({ mintedAt: Date.now(), lastSeenAt: Date.now() }),
          { ex: ttlS },
        )
      } catch {
        // redis-down case: still issue the session; verification will fail later if needed.
      }
      return c.json({ sessionId, sig, ttlMs: cfg.sessionTtlMs })
    },
    openapi: {
      summary: 'Mint a new session',
      tags: ['session'],
      responses: {
        200: { description: 'Session created' },
      },
    },
  },
  delete: {
    middleware: ['session-auth'],
    handler: async (c) => {
      const sid = c.get('sessionId')
      if (sid && sid !== 'deployer') {
        await Promise.all([
          redis.del(`session:${sid}`),
          redis.del(`history:${sid}`),
        ])
      }
      return c.json({ deleted: true })
    },
    openapi: {
      summary: 'Revoke the current session',
      tags: ['session'],
      responses: {
        200: { description: 'Session deleted' },
      },
    },
  },
})