import { Realtime, type InferRealtimeEvents } from '@upstash/realtime'
import { z } from 'zod'
import { redis } from './redis'

const storedEvent = z.object({
  id: z.string(),
  seq: z.number(),
  type: z.enum(['cue', 'source', 'token', 'done', 'error']),
  data: z.any(),
})

export const realtimeSchema = {
  msg: {
    cue: storedEvent,
    source: storedEvent,
    token: storedEvent,
    done: storedEvent,
    error: storedEvent,
  },
}

let _realtime: Realtime<typeof realtimeSchema> | null = null

export function getRealtime(): Realtime<typeof realtimeSchema> {
  if (!_realtime) {
    _realtime = new Realtime({ schema: realtimeSchema, redis })
  }
  return _realtime
}

export const realtime: Realtime<typeof realtimeSchema> = new Proxy({} as Realtime<typeof realtimeSchema>, {
  get(_t, prop) {
    return (getRealtime() as any)[prop]
  },
})

export type RealtimeEvents = InferRealtimeEvents<Realtime<typeof realtimeSchema>>