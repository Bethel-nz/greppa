import { redis } from './redis'
import { realtime } from './realtime'
import type { EmitEvent } from './realtime'

export type EmitType = 'cue' | 'sources' | 'token' | 'done' | 'error'

export type StoredEvent = {
  id: string
  seq: number
  type: EmitType
  data: unknown
}

// Each event is durable-before-live: the ZSET write (authoritative replay source)
// happens before the Realtime emit (live transport). If the Realtime emit fails,
// live subscribers miss a frame but every resume replays it from the log. The event
// `id` is the monotonic `seq` rendered as a string, so resumption never depends on
// sub-millisecond ULID ordering. The log TTL is re-anchored on every write so it
// expires `ttlMs` after the last event, not the first.
export function makeEmitter({ messageId, ttlMs }: { messageId: string; ttlMs: number }) {
  const channel = realtime.channel(messageId)
  const eventsKey = `msg:${messageId}:events`
  const ttlSecs = Math.floor(ttlMs / 1000)
  let seq = 0

  return async function emit(type: EmitType, data: unknown): Promise<StoredEvent> {
    seq += 1
    const event: StoredEvent = { id: String(seq), seq, type, data }

    await redis
      .pipeline()
      .zadd(eventsKey, { score: seq, member: JSON.stringify(event) })
      .expire(eventsKey, ttlSecs)
      .exec()

    await channel.emit(`msg.${type}` as EmitEvent, event as any)
    return event
  }
}
