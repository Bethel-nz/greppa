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

      // One signal for expired / unknown / cross-conversation. Distinguishing them
      // would turn the endpoint into an existence oracle. The client falls back to the
      // conversation history load on not_found.
      if (!meta || meta.conversationId !== conversationId) {
        await stream.writeSSE({ event: 'error', data: JSON.stringify({ code: 'not_found', reason: 'unknown message' }) })
        return
      }

      const eventsKey = `msg:${messageId}:events`
      const cursor = Number.parseInt(c.req.header('last-event-id') ?? '', 10)

      let lastSeq = 0
      let terminated = false

      const forward = async (ev: StoredEvent) => {
        if (terminated || ev.seq <= lastSeq) return
        lastSeq = ev.seq
        await stream.writeSSE({ id: String(ev.seq), event: ev.type, data: JSON.stringify(ev.data) })
        if (TERMINAL.has(ev.type)) terminated = true
      }

      // Subscribe first (buffering) so nothing emitted between snapshot and tail is lost.
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
        // Snapshot the durable log (bounded to one message; a full read is fine).
        const rawLog = (await redis.zrange(eventsKey, 0, -1)) as string[]
        const log: StoredEvent[] = rawLog.map((m) => JSON.parse(m) as StoredEvent)
        const maxSeq = log.length ? log[log.length - 1].seq : 0

        // Unparseable (legacy ULID) or stale (log reset by a retry) cursor -> full replay.
        const effectiveCursor = Number.isFinite(cursor) && cursor <= maxSeq ? cursor : 0

        for (const ev of log) {
          if (ev.seq > effectiveCursor) await forward(ev)
          if (terminated) break
        }

        snapshotDone = true
        for (const ev of buffer) {
          if (terminated) break
          await forward(ev)
        }
        if (terminated) return

        // Tail live events. Close on a terminal event, or on a stalled stream: if no
        // new event arrives within the resume window the workflow died without a
        // terminal frame (QStash retries exhausted), so stop rather than hang.
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
