import { mock } from 'bun:test'

// Shared in-memory mocks for redis and realtime so test files do not race
// each other through Bun's process-wide mock.module registry. Tests must
// import this file BEFORE importing any module that depends on lib/redis,
// lib/realtime, or lib/workflow.

export const fakeRedis: Record<string, any> = {}
export const zsets: Record<string, Array<{ score: number; member: string }>> = {}

export function clearRedisState() {
  for (const k of Object.keys(fakeRedis)) delete fakeRedis[k]
  for (const k of Object.keys(zsets)) delete zsets[k]
}

export const redisMock = {
  zadd: async (key: string, entry: { score: number; member: string }) => {
    zsets[key] = zsets[key] ?? []
    zsets[key].push(entry)
    zsets[key].sort((a, b) => a.score - b.score)
    return 1
  },
  zrange: async (key: string, start: number = 0, end: number = -1) => {
    const arr = (zsets[key] ?? []).slice()
    const lo = start < 0 ? Math.max(0, arr.length + start) : start
    const hi = end < 0 ? arr.length + end + 1 : end + 1
    return arr.slice(lo, hi).map((e) => e.member)
  },
  hset: async (key: string, fields: Record<string, any>) => {
    fakeRedis[key] = { ...(fakeRedis[key] ?? {}), ...fields }
    return Object.keys(fields).length
  },
  hgetall: async (key: string) => fakeRedis[key] ?? null,
  get: async (k: string) => fakeRedis[k] ?? null,
  set: async (k: string, v: any) => { fakeRedis[k] = v; return 'OK' },
  del: async (k: string) => { delete fakeRedis[k]; delete zsets[k]; return 1 },
  expire: async () => 1,
  pexpire: async () => 1,
  incr: async (k: string) => { fakeRedis[k] = (Number(fakeRedis[k]) || 0) + 1; return fakeRedis[k] },
}

type ChannelEvent = { event: string; data: unknown }
export const realtimeHistory: Record<string, ChannelEvent[]> = {}
const realtimeListeners: Record<string, Array<(ev: ChannelEvent) => void>> = {}

export function clearRealtimeState() {
  for (const k of Object.keys(realtimeHistory)) delete realtimeHistory[k]
  for (const k of Object.keys(realtimeListeners)) delete realtimeListeners[k]
}

export function seedRealtimeChannel(channel: string, events: ChannelEvent[]) {
  realtimeHistory[channel] = [...events]
}

function makeChannel(name: string) {
  realtimeHistory[name] = realtimeHistory[name] ?? []
  realtimeListeners[name] = realtimeListeners[name] ?? []
  return {
    async emit(event: string, data: unknown) {
      const ev = { event, data }
      realtimeHistory[name].push(ev)
      for (const l of realtimeListeners[name]) l(ev)
    },
    async subscribe(args: {
      events: readonly string[]
      onData: (arg: { event: string; data: unknown; channel: string }) => void
      history?: boolean
    }) {
      if (args.history) {
        for (const past of realtimeHistory[name]) {
          if (args.events.includes(past.event)) args.onData({ ...past, channel: name })
        }
      }
      const listener = (ev: ChannelEvent) => {
        if (args.events.includes(ev.event)) args.onData({ ...ev, channel: name })
      }
      realtimeListeners[name].push(listener)
      return () => {
        const arr = realtimeListeners[name] ?? []
        const idx = arr.indexOf(listener)
        if (idx >= 0) arr.splice(idx, 1)
      }
    },
    async history() {
      return realtimeHistory[name].map((e, i) => ({ id: String(i), event: e.event, channel: name, data: e.data }))
    },
    unsubscribe() { realtimeListeners[name] = [] },
  }
}

mock.module('../../lib/redis', () => ({ redis: redisMock, getRedis: () => redisMock }))
mock.module('../../lib/realtime', () => ({
  realtime: { channel: (name: string) => makeChannel(name) },
  getRealtime: () => ({ channel: (name: string) => makeChannel(name) }),
  realtimeSchema: {},
}))
mock.module('../../lib/workflow', () => ({
  triggerChatWorkflow: async () => {},
  triggerIngestWorkflow: async () => {},
  getWorkflowClient: () => ({}),
}))
