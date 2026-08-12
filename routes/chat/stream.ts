import { z } from 'zod'
import { createRoute } from '@bethel-nz/sumi/router'
import { redis } from '~/lib/redis'
import { realtime } from '~/lib/realtime'
import { loadGreppaConfig } from '~/lib/config'

const querySchema = z.object({
  messageId: z.string().min(1).describe('The message ID to stream responses for'),
})

type StoredEvent = {
  id: string
  seq: number
  type: 'cue' | 'sources' | 'token' | 'done' | 'error'
  data: unknown
}

const TERMINAL = new Set(['done', 'error'])

export default createRoute({
  get: {
    schema: { query: querySchema },
    middleware: ['session-auth'],
    stream: async (stream, c) => {
      const messageId = c.req.query('messageId')
      if (!messageId) {
        await stream.writeSSE({ event: 'error', data: JSON.stringify({ code: 'bad_request', reason: 'messageId required' }) })
        return
      }

      const conversationId = c.get('conversationId')
      const cfg = loadGreppaConfig()

      const meta = (await redis.hgetall(`msg:${messageId}:meta`)) as
        | { conversationId?: string; status?: string }
        | null

      if (!meta || meta.conversationId !== conversationId) {
        await stream.writeSSE({ event: 'error', data: JSON.stringify({ code: 'not_found', reason: 'unknown message' }) })
        return
      }

      const eventsKey = `msg:${messageId}:events`
      const rawCursor = c.req.header('last-event-id') ?? ''
      const cursor = /^\d+$/.test(rawCursor) ? Number(rawCursor) : NaN

      let lastSeq = 0
      let terminated = false

      const forward = async (ev: StoredEvent) => {
        if (terminated || ev.seq <= lastSeq) return
        lastSeq = ev.seq
        await stream.writeSSE({ id: String(ev.seq), event: ev.type, data: JSON.stringify(ev.data) })
        if (TERMINAL.has(ev.type)) terminated = true
      }

      const buffer: StoredEvent[] = []
      let snapshotDone = false
      const channel = realtime.channel(messageId)
      const unsubscribe = await channel.subscribe({
        events: ['msg.cue', 'msg.sources', 'msg.token', 'msg.done', 'msg.error'],
        history: false,
        onData: (envelope: any) => {
          const ev = envelope.data as StoredEvent
          if (!snapshotDone) buffer.push(ev)
          else void forward(ev)
        },
      })

      try {
        const rawLog = (await redis.zrange(eventsKey, 0, -1)) as unknown[]
        const log: StoredEvent[] = rawLog.map((m) =>
          typeof m === 'string' ? (JSON.parse(m) as StoredEvent) : (m as StoredEvent),
        )
        const maxSeq = log.length ? log[log.length - 1].seq : 0

        const effectiveCursor = Number.isFinite(cursor) && cursor <= maxSeq ? cursor : 0

        for (const ev of log) {
          if (ev.seq > effectiveCursor) await forward(ev)
          if (terminated) break
        }

        while (buffer.length && !terminated) await forward(buffer.shift()!)
        snapshotDone = true
        if (terminated) return

        if (meta.status && TERMINAL.has(meta.status)) {
          await stream.writeSSE({ event: 'error', data: JSON.stringify({ code: 'incomplete', reason: 'stream ended without a completion frame' }) })
          return
        }

        let seen = lastSeq
        let lastActivity = Date.now()
        while (!terminated) {
          await new Promise((r) => setTimeout(r, 50))
          if (lastSeq !== seen) {
            seen = lastSeq
            lastActivity = Date.now()
          } else if (Date.now() - lastActivity > cfg.resumeWindowMs) {
            await stream.writeSSE({ event: 'error', data: JSON.stringify({ code: 'stalled', reason: 'stream stalled' }) })
            terminated = true
          }
        }
      } finally {
        unsubscribe()
      }
    },
    openapi: {
      summary: 'Subscribe to a chat message stream',
      description: 'Server-Sent Events stream. Replays the durable event log from the last-event-id seq cursor, then tails new events. Events: cue, sources, token, done, error.',
      tags: ['chat'],
      responses: {
        200: { description: 'SSE stream (text/event-stream)' },
        401: { description: 'Session header required' },
      },
    },
  },
})
