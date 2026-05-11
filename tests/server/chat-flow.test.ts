import './_mocks'
import { describe, expect, test, beforeEach } from 'bun:test'
import { fakeRedis, zsets, clearRedisState, clearRealtimeState } from './_mocks'
import { signSessionId } from '../../lib/hmac'
import { _resetGreppaConfigForTests } from '../../lib/config'

const SECRET = 'e'.repeat(48)

const { createMockApp } = await import('@bethel-nz/sumi/testing')

beforeEach(() => {
  _resetGreppaConfigForTests()
  process.env.GREPPA_SESSION_SECRET = SECRET
  process.env.GREPPA_PUBLIC_URL = 'http://localhost:3000'
  process.env.UPSTASH_REDIS_REST_URL = 'http://localhost:1'
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fake'
  clearRedisState()
  clearRealtimeState()
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