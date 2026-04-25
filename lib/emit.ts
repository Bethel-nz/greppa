import { ulid } from 'ulid'
import { redis } from './redis'
import { realtime } from './realtime'

export type EmitType = 'cue' | 'source' | 'token' | 'done' | 'error'

export type StoredEvent = {
  id: string
  seq: number
  type: EmitType
  data: unknown
}

export function makeEmitter({ messageId }: { messageId: string }) {
  const channel = realtime.channel(messageId)
  let seq = 0
  return async function emit(type: EmitType, data: unknown): Promise<StoredEvent> {
    const id = ulid()
    seq += 1
    const event: StoredEvent = { id, seq, type, data }
    const member = JSON.stringify(event)
    await Promise.all([
      redis.zadd(`msg:${messageId}:events`, { score: seq, member }),
      channel.emit(`msg.${type}` as any, event as any),
    ])
    await redis.expire(`msg:${messageId}:events`, 3600)
    return event
  }
}