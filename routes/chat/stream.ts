import { z } from 'zod'
import { createRoute } from '@bethel-nz/sumi/router'
import { ulid } from 'ulid'
import { redis } from '../../lib/redis'
import { realtime } from '../../lib/realtime'

const querySchema = z.object({
  messageId: z.string().min(1),
})

type StoredEvent = {
  id: string
  seq: number
  type: 'cue' | 'sources' | 'token' | 'done' | 'error'
  data: unknown
}

export default createRoute({
  get: {
    schema: { query: querySchema },
    middleware: ['session-auth'],
    stream: async (stream, c) => {
      const messageId = c.req.query('messageId')
      if (!messageId) {
        await stream.writeSSE({
          event: 'error',
          data: JSON.stringify({ code: 'bad_request', reason: 'messageId required' }),
          id: ulid(),
        })
        return
      }
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

      const channel = realtime.channel(messageId)
      let terminated = false

      const forward = async (envelope: { event: string; data: unknown }) => {
        if (terminated) return
        const inner = envelope.data as StoredEvent
        if (lastEventId && inner.id <= lastEventId) return
        const sseEvent = envelope.event.startsWith('msg.') ? envelope.event.slice(4) : envelope.event
        await stream.writeSSE({
          id: inner.id,
          event: sseEvent,
          data: JSON.stringify(inner.data),
        })
        if (sseEvent === 'done' || sseEvent === 'error') {
          terminated = true
        }
      }

      const unsubscribe = await channel.subscribe({
        events: ['msg.cue', 'msg.sources', 'msg.token', 'msg.done', 'msg.error'],
        history: true,
        onData: (envelope) => { void forward(envelope as any) },
      })

      try {
        // Resolve once a terminal event has been forwarded.
        while (!terminated) await new Promise((r) => setTimeout(r, 50))
      } finally {
        unsubscribe()
      }
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
