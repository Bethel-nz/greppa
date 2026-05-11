import { ulid } from 'ulid'
import { realtime } from './realtime'
import type { EmitEvent } from './realtime'

export type EmitType = 'cue' | 'sources' | 'token' | 'done' | 'error'

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
    seq += 1
    const event: StoredEvent = { id: ulid(), seq, type, data }
    await channel.emit(`msg.${type}` as EmitEvent, event as any)
    return event
  }
}
