import './_mocks'
import { describe, expect, test, beforeAll, beforeEach } from 'bun:test'
import { fakeRedis, zsets, clearRedisState, clearRealtimeState } from './_mocks'
import { _resetGreppaConfigForTests } from '~/lib/config'

const SECRET = 'e'.repeat(48)
const { createMockApp } = await import('@bethel-nz/sumi/testing')

function setEnv() {
  process.env.GREPPA_SESSION_SECRET = SECRET
  process.env.GREPPA_PUBLIC_URL = 'http://localhost:3000'
  process.env.DATABASE_URL = 'postgres://postgres:postgres@localhost:5432/greppa'
  process.env.BETTER_AUTH_SECRET = 'test-secret-1234567890123456789012345678'
  process.env.UPSTASH_REDIS_REST_URL = 'http://localhost:1'
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fake'
  delete process.env.GREPPA_RESUME_WINDOW_MS
}

let request: Awaited<ReturnType<typeof createMockApp>>['request']

beforeAll(async () => {
  setEnv()
  ;({ request } = await createMockApp({ routesDir: 'routes', middlewareDir: 'middleware', basePath: '/api/v1' }))
})

beforeEach(() => {
  _resetGreppaConfigForTests()
  setEnv()
  clearRedisState()
  clearRealtimeState()
})

// Seed a durable log; unique token letters let us assert which events replayed.
function seedLog(sid: string, messageId: string, includeDone = true) {
  fakeRedis[`msg:${messageId}:meta`] = { conversationId: sid, status: includeDone ? 'done' : 'generating' }
  const events = [
    { id: '1', seq: 1, type: 'cue', data: { status: 'thinking' } },
    { id: '2', seq: 2, type: 'token', data: { token: 'AAA' } },
    { id: '3', seq: 3, type: 'token', data: { token: 'BBB' } },
    { id: '4', seq: 4, type: 'token', data: { token: 'CCC' } },
  ]
  if (includeDone) events.push({ id: '5', seq: 5, type: 'done', data: { messageId } } as any)
  zsets[`msg:${messageId}:events`] = events.map((e) => ({ score: e.seq, member: JSON.stringify(e) }))
}

async function stream(sid: string, messageId: string, lastEventId?: string) {
  const headers: Record<string, string> = { 'x-greppa-session': sid }
  if (lastEventId !== undefined) headers['last-event-id'] = lastEventId
  const res = await request(`/chat/stream?messageId=${messageId}`, { method: 'GET', headers })
  return { status: res.status, text: await res.text() }
}

describe('chat stream resume', () => {
  const sid = '01HXXXRESUMEXXXXXXXXXXXXXX1'
  const mid = '01HXXXRMSGXXXXXXXXXXXXXXXX1'

  test('resumes from cursor: replays only events after last-event-id', async () => {
    seedLog(sid, mid)
    const { text } = await stream(sid, mid, '3')
    expect(text).not.toContain('AAA')
    expect(text).not.toContain('BBB')
    expect(text).toContain('CCC')
    expect(text).toContain('id: 4')
    expect(text).toContain('event: done')
  })

  test('no cursor replays the full log and closes on done', async () => {
    seedLog(sid, mid)
    const { text } = await stream(sid, mid)
    expect(text).toContain('AAA')
    expect(text).toContain('CCC')
    expect(text).toContain('event: done')
  })

  test('unparseable (legacy ULID) cursor triggers a full replay', async () => {
    seedLog(sid, mid)
    const { text } = await stream(sid, mid, '01HXXXOLDULIDXXXXXXXXXXXXX1')
    // A ULID starting with digits must not partial-parse to a seq; seq 1 (the cue)
    // must still be replayed.
    expect(text).toContain('id: 1')
    expect(text).toContain('AAA')
    expect(text).toContain('CCC')
  })

  test('terminal meta with no terminal frame in the log closes with an error', async () => {
    fakeRedis[`msg:${mid}:meta`] = { conversationId: sid, status: 'done' }
    zsets[`msg:${mid}:events`] = [
      { score: 1, member: JSON.stringify({ id: '1', seq: 1, type: 'token', data: { token: 'XYZ' } }) },
    ]
    const { text } = await stream(sid, mid)
    expect(text).toContain('XYZ')
    expect(text).toContain('"code":"incomplete"')
  })

  test('stale cursor beyond max seq triggers a full replay', async () => {
    seedLog(sid, mid)
    const { text } = await stream(sid, mid, '99')
    expect(text).toContain('AAA')
    expect(text).toContain('CCC')
  })

  test('not_found for unknown message carries no id', async () => {
    const { text } = await stream(sid, '01HXXXUNKNOWNXXXXXXXXXXXXX1')
    expect(text).toContain('"code":"not_found"')
    expect(text).not.toMatch(/^id: /m)
  })

  test('stalled stream emits a stalled error within the bound', async () => {
    process.env.GREPPA_RESUME_WINDOW_MS = '150'
    _resetGreppaConfigForTests()
    seedLog(sid, mid, false) // no terminal event, no live producer
    const { text } = await stream(sid, mid)
    expect(text).toContain('event: cue')
    expect(text).toContain('"code":"stalled"')
  })

  // Regression: real Upstash auto-deserializes JSON members, so zrange returns
  // objects, not strings. The replay path previously JSON.parse'd them and threw,
  // breaking resume in production while the string-returning mock stayed green.
  test('replays when the store returns already-deserialized object members', async () => {
    fakeRedis[`msg:${mid}:meta`] = { conversationId: sid, status: 'done' }
    zsets[`msg:${mid}:events`] = [
      { score: 1, member: { id: '1', seq: 1, type: 'cue', data: { status: 'thinking' } } },
      { score: 2, member: { id: '2', seq: 2, type: 'token', data: { token: 'AAA' } } },
      { score: 3, member: { id: '3', seq: 3, type: 'token', data: { token: 'BBB' } } },
      { score: 4, member: { id: '4', seq: 4, type: 'done', data: { messageId: mid } } },
    ] as any
    const { text } = await stream(sid, mid, '2')
    expect(text).not.toContain('AAA') // seq 2 <= cursor, not replayed
    expect(text).toContain('BBB') // seq 3 replayed cleanly (no parse crash)
    expect(text).toContain('event: done')
  })
})
