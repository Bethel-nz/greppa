import { describe, expect, test, beforeEach, mock } from 'bun:test'
import { signSessionId } from '../../lib/hmac'
import { _resetGreppaConfigForTests } from '../../lib/config'

const SECRET = 'e'.repeat(48)

const fakeRedis: Record<string, any> = {}
const zsets: Record<string, Array<{ score: number; member: string }>> = {}

const redisMock = {
  zadd: async (key: string, entry: { score: number; member: string }) => {
    zsets[key] = zsets[key] ?? []
    zsets[key].push(entry)
    zsets[key].sort((a, b) => a.score - b.score)
    return 1
  },
  zrange: async (key: string, _s: number, _e: number) =>
    (zsets[key] ?? []).map((e) => e.member),
  hset: async (key: string, fields: Record<string, any>) => {
    fakeRedis[key] = { ...(fakeRedis[key] ?? {}), ...fields }
    return Object.keys(fields).length
  },
  hgetall: async (key: string) => fakeRedis[key] ?? null,
  expire: async () => 1,
  pexpire: async () => 1,
  set: async (key: string, val: any) => { fakeRedis[key] = val; return 'OK' },
  del: async (key: string) => { delete fakeRedis[key]; delete zsets[key]; return 1 },
  incr: async (key: string) => {
    fakeRedis[key] = (fakeRedis[key] ?? 0) + 1
    return fakeRedis[key]
  },
}

mock.module('../../lib/redis', () => ({ redis: redisMock, getRedis: () => redisMock }))
mock.module('../../lib/realtime', () => ({
  realtime: { channel: () => ({ emit: async () => {}, on: () => {} }) },
  realtimeSchema: {},
  getRealtime: () => ({}),
}))
mock.module('../../lib/workflow', () => ({
  triggerChatWorkflow: async () => {},
  getWorkflowClient: () => ({}),
}))

const { createMockApp } = await import('@bethel-nz/sumi/testing')

beforeEach(() => {
  _resetGreppaConfigForTests()
  process.env.GREPPA_SESSION_SECRET = SECRET
  process.env.GREPPA_PUBLIC_URL = 'http://localhost:3000'
  process.env.UPSTASH_REDIS_REST_URL = 'http://localhost:1'
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fake'
  for (const k of Object.keys(fakeRedis)) delete fakeRedis[k]
  for (const k of Object.keys(zsets)) delete zsets[k]
})

describe('chat flow', () => {
  test('POST /chat enqueues + writes user msg + meta', async () => {
    const { request } = await createMockApp({
      routesDir: 'routes',
      middlewareDir: 'middleware',
      basePath: '/api/v1',
    })
    const sid = '01HXXXSESSIONXXXXXXXXXXXX1'
    const sig = signSessionId(sid, SECRET)

    const res = await request('/chat', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-greppa-session': sid,
        'x-greppa-session-sig': sig,
        'x-forwarded-for': '127.0.0.1',
      },
      body: JSON.stringify({ message: 'hello' }),
    })
    expect(res.status).toBe(202)
    const body = (await res.json()) as { messageId: string }
    expect(body.messageId).toBeDefined()

    const histKey = `history:${sid}`
    expect(zsets[histKey]?.length).toBe(1)
    const userMsg = JSON.parse(zsets[histKey][0].member)
    expect(userMsg).toMatchObject({ role: 'user', content: 'hello' })

    expect(fakeRedis[`msg:${body.messageId}:meta`]).toMatchObject({
      sessionId: sid,
      status: 'queued',
    })
  })

  test('GET /chat/stream rejects cross-session access', async () => {
    const { request } = await createMockApp({
      routesDir: 'routes',
      middlewareDir: 'middleware',
      basePath: '/api/v1',
    })
    const ownerSid = '01HXXXOWNERXXXXXXXXXXXXXXX1'
    const otherSid = '01HXXXOTHERXXXXXXXXXXXXXXX1'
    const messageId = '01HXXXMSGXXXXXXXXXXXXXXXXX1'
    fakeRedis[`msg:${messageId}:meta`] = { sessionId: ownerSid, status: 'queued' }

    const res = await request(`/chat/stream?messageId=${messageId}`, {
      method: 'GET',
      headers: {
        'x-greppa-session': otherSid,
        'x-greppa-session-sig': signSessionId(otherSid, SECRET),
      },
    })
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('event: error')
    expect(text).toContain('"code":"not_found"')
  })

  test('GET /chat/history returns messages ordered by at', async () => {
    const { request } = await createMockApp({
      routesDir: 'routes',
      middlewareDir: 'middleware',
      basePath: '/api/v1',
    })
    const sid = '01HXXXHISTXXXXXXXXXXXXXXXX1'
    const sig = signSessionId(sid, SECRET)
    zsets[`history:${sid}`] = [
      { score: 1, member: JSON.stringify({ id: 'a', role: 'user', content: 'one', at: 1 }) },
      { score: 2, member: JSON.stringify({ id: 'b', role: 'assistant', content: 'two', at: 2 }) },
    ]
    const res = await request(`/chat/history?sessionId=${sid}`, {
      method: 'GET',
      headers: { 'x-greppa-session': sid, 'x-greppa-session-sig': sig },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.messages.map((m: any) => m.content)).toEqual(['one', 'two'])
  })
})