import { describe, expect, test, mock, beforeEach } from 'bun:test'

const channelEmits: any[] = []

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
    channelEmits.length = 0
  })

  test('emits on the realtime channel with monotonic seq and a ulid id', async () => {
    const emit = makeEmitter({ messageId: 'msg-1' })
    await emit('cue', { status: 'thinking', at: 1 })
    await emit('token', { token: 'hi' })

    expect(channelEmits.length).toBe(2)
    expect(channelEmits[0].channelId).toBe('msg-1')
    expect(channelEmits[0].name).toBe('msg.cue')
    expect(channelEmits[0].payload.type).toBe('cue')
    expect(channelEmits[0].payload.seq).toBe(1)
    expect(channelEmits[0].payload.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)

    expect(channelEmits[1].name).toBe('msg.token')
    expect(channelEmits[1].payload.seq).toBe(2)
  })

  test('emits sources batch', async () => {
    const emit = makeEmitter({ messageId: 'msg-sources' })
    await emit('sources', [{ title: 't', snippet: 's', score: 0.9 }])
    expect(channelEmits[0].name).toBe('msg.sources')
    expect(channelEmits[0].payload.type).toBe('sources')
    expect(Array.isArray(channelEmits[0].payload.data)).toBe(true)
  })

  test('returns the stored event so callers can persist it elsewhere', async () => {
    const emit = makeEmitter({ messageId: 'msg-3' })
    const ev = await emit('done', { messageId: 'msg-3', message: 'ok', model: 'm', at: 1 })
    expect(ev.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(ev.seq).toBe(1)
    expect(ev.type).toBe('done')
  })
})
