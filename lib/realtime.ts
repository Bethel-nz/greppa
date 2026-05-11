import { Realtime } from '@upstash/realtime'
import { z } from 'zod/v4'
import { redis } from './redis'

const storedEvent = z.object({
  id: z.string(),
  seq: z.number(),
  type: z.enum(['cue', 'sources', 'token', 'done', 'error']),
  data: z.unknown(),
})

export const realtimeSchema = {
  msg: {
    cue: storedEvent,
    sources: storedEvent,
    token: storedEvent,
    done: storedEvent,
    error: storedEvent,
  },
} as const

let _realtime: ReturnType<typeof buildRealtime> | null = null

function buildRealtime() {
  return new Realtime({
    schema: realtimeSchema,
    redis,
    history: { expireAfterSecs: 60 * 60 },
  })
}

export function getRealtime() {
  if (!_realtime) _realtime = buildRealtime()
  return _realtime
}

// Lazy proxy so importers don't trigger Redis client construction at module load.
export const realtime = new Proxy({} as ReturnType<typeof buildRealtime>, {
  get(_t, prop) {
    return (getRealtime() as any)[prop]
  },
})

export type EmitEvent = 'msg.cue' | 'msg.sources' | 'msg.token' | 'msg.done' | 'msg.error'
