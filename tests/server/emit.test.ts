import './_mocks'
import { describe, expect, test, beforeEach } from 'bun:test'
import { zsets, clearRedisState, clearRealtimeState, realtimeHistory } from './_mocks'
import { makeEmitter } from '~/lib/emit'

describe('emit durable log', () => {
  beforeEach(() => { clearRedisState(); clearRealtimeState() })

  test('writes events to the ZSET scored by seq with id = String(seq)', async () => {
    const emit = makeEmitter({ messageId: 'm1', ttlMs: 300000 })
    const a = await emit('cue', { status: 'thinking' })
    const b = await emit('token', { token: 'hi' })

    expect(a.seq).toBe(1)
    expect(a.id).toBe('1')
    expect(b.seq).toBe(2)
    expect(b.id).toBe('2')

    const log = (zsets['msg:m1:events'] ?? []).map((e) => JSON.parse(e.member))
    expect(log.map((e) => e.seq)).toEqual([1, 2])
    expect(log.map((e) => e.type)).toEqual(['cue', 'token'])
    expect(zsets['msg:m1:events'].map((e) => e.score)).toEqual([1, 2])
  })

  test('also emits to realtime for live tailing', async () => {
    const emit = makeEmitter({ messageId: 'm2', ttlMs: 300000 })
    await emit('token', { token: 'x' })
    expect(realtimeHistory['m2']?.map((e) => e.event)).toEqual(['msg.token'])
  })
})
