import { z } from 'zod'
import { createRoute } from '@bethel-nz/sumi/router'
import { ulid } from 'ulid'
import { redis } from '../../lib/redis'
import { realtime } from '../../lib/realtime'

const querySchema = z.object({
  messageId: z.string().min(1),
})

export default createRoute({
  get: {
    schema: { query: querySchema },
    middleware: ['session-auth'],
    stream: async (stream, c) => {
      const { messageId } = c.req.valid('query')
      const lastEventId = c.req.header('last-event-id')
      const sessionId = c.get('sessionId')
      const isDeployer = c.get('isDeployer')

      const meta = (await redis.hgetall(`msg:${messageId}:meta`)) as
        | { sessionId?: string; status?: string }
        | null

      if (!meta || (meta.sessionId !== sessionId && !isDeployer)) {
        await stream.writeSSE({
          event: 'error',
          data: JSON.stringify({ code: 'not_found', reason: 'unknown message' }),
          id: ulid(),
        })
        return
      }

      const raw = (await redis.zrange(`msg:${messageId}:events`, 0, -1)) as string[]
      let resumeIndex = 0
      if (lastEventId) {
        const idx = raw.findIndex((r) => {
          try { return JSON.parse(r).id === lastEventId } catch { return false }
        })
        if (idx >= 0) resumeIndex = idx + 1
      }
      for (const r of raw.slice(resumeIndex)) {
        let ev: any
        try { ev = JSON.parse(r) } catch { continue }
        await stream.writeSSE({ id: ev.id, event: ev.type, data: JSON.stringify(ev.data) })
      }

      if (meta.status === 'done' || meta.status === 'error') return

      const channel = realtime.channel(messageId)
      await new Promise<void>((resolve) => {
        const forward = async (ev: any) => {
          await stream.writeSSE({ id: ev.id, event: ev.type, data: JSON.stringify(ev.data) })
        }
        channel.on('msg.cue' as any, forward)
        channel.on('msg.source' as any, forward)
        channel.on('msg.token' as any, forward)
        channel.on('msg.done' as any, async (ev: any) => { await forward(ev); resolve() })
        channel.on('msg.error' as any, async (ev: any) => { await forward(ev); resolve() })
      })
    },
    openapi: {
      summary: 'Subscribe to a chat message stream (replay-then-tail SSE)',
      tags: ['chat'],
      responses: {
        200: { description: 'SSE stream' },
      },
    },
  },
})