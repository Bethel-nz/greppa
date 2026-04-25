import { describe, expect, test, mock, beforeEach } from 'bun:test'

const zaddCalls: any[] = []
const expireCalls: any[] = []
const channelEmits: any[] = []

mock.module('../../lib/redis', () => ({
  redis: {
    zadd: (...args: any[]) => { zaddCalls.push(args); return Promise.resolve(1) },
    expire: (...args: any[]) => { expireCalls.push(args); return Promise.resolve(1) },
  },
}))

mock.module('../../lib/realtime', () => ({
  realtime: {
    channel: (id: string) => ({
      emit: (name: string, payload: any) => {
        channelEmits.push({ channelId: id, name, payload })
        return Promise.resolve()
      },
    }),
  },
}))

const { makeEmitter } = await import('../../lib/emit')

describe('makeEmitter', () => {
  beforeEach(() => {
    zaddCalls.length = 0
    expireCalls.length = 0
    channelEmits.length = 0
  })

  test('writes to ZSET and emits on channel with monotonic seq', async () => {
    const emit = makeEmitter({ messageId: 'msg-1' })
    await emit('cue', { status: 'thinking', at: 1 })
    await emit('token', { token: 'hi' })

    expect(zaddCalls.length).toBe(2)
    expect(zaddCalls[0][0]).toBe('msg:msg-1:events')
    expect(zaddCalls[0][1].score).toBe(1)
    expect(zaddCalls[1][1].score).toBe(2)

    expect(channelEmits.length).toBe(2)
    expect(channelEmits[0].channelId).toBe('msg-1')
    expect(channelEmits[0].name).toBe('msg.cue')
    expect(channelEmits[0].payload.type).toBe('cue')
    expect(channelEmits[0].payload.seq).toBe(1)

    expect(channelEmits[1].name).toBe('msg.token')
    expect(channelEmits[1].payload.seq).toBe(2)
  })

  test('refreshes TTL after each write', async () => {
    const emit = makeEmitter({ messageId: 'msg-2' })
    await emit('cue', { status: 'idle', at: 1 })
    expect(expireCalls.length).toBe(1)
    expect(expireCalls[0][0]).toBe('msg:msg-2:events')
    expect(expireCalls[0][1]).toBe(3600)
  })
})