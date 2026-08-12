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
