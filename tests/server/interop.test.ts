import './_mocks'
import { describe, expect, test, beforeAll, beforeEach } from 'bun:test'
import { fakeRedis, zsets, clearRedisState, clearRealtimeState } from './_mocks'
import { Greppa, ServerSession } from '../../packages/greppa-sdk/src/index'
import { _resetGreppaConfigForTests } from '~/lib/config'

const SECRET = 'f'.repeat(48)

const { createMockApp } = await import('@bethel-nz/sumi/testing')

function setEnv() {
  process.env.GREPPA_SESSION_SECRET = SECRET
  process.env.GREPPA_PUBLIC_URL = 'http://localhost'
  process.env.DATABASE_URL = 'postgres://postgres:postgres@localhost:5432/greppa'
  process.env.BETTER_AUTH_SECRET = 'test-secret-1234567890123456789012345678'
}

function createInteropFetch(request: any) {
  return (async (input: any, init: any) => {
    const urlString = typeof input === 'string' ? input : (input as URL).toString()
    const url = new URL(urlString)
    const path = url.pathname.replace('/api/v1', '') + url.search
    return request(path || '/', init)
  }) as typeof fetch
}

async function seededGreppa(request: any, sid: string): Promise<{ greppa: Greppa; store: ServerSession }> {
  const store = new ServerSession()
  await store.set('default', { sessionId: sid, sig: '', mintedAt: Date.now() })
  const greppa = new Greppa({
    baseUrl: 'http://localhost/api/v1',
    fetch: createInteropFetch(request),
    sessionStore: store,
  })
  return { greppa, store }
}

describe('SDK <-> Server Interop', () => {
  let request: Awaited<ReturnType<typeof createMockApp>>['request']

  beforeAll(async () => {
    setEnv()
    ;({ request } = await createMockApp({
      routesDir: 'routes',
      middlewareDir: 'middleware',
      basePath: '/api/v1',
    }))
  })

  beforeEach(() => {
    _resetGreppaConfigForTests()
    setEnv()
    clearRedisState()
    clearRealtimeState()
  })

  test('SDK mints a session and POST /chat persists the user message', async () => {
    const greppa = new Greppa({
      baseUrl: 'http://localhost/api/v1',
      fetch: createInteropFetch(request),
      sessionStore: new ServerSession(),
    })

    const handle = greppa.chat.send('hello interop')
    await new Promise((r) => setTimeout(r, 10))
    handle.abort()

    const history = await greppa.chat.history()
    expect(history.sessionId.length).toBeGreaterThan(0)
    expect(fakeRedis[`session:${history.sessionId}`]).toBeDefined()
    expect(history.messages.some((m: { role: string; content: string }) => m.role === 'user' && m.content === 'hello interop')).toBe(true)
  })

  test('SDK replays a finished message from the server-side ZSET', async () => {
    const sid = '01HINTEROP'
    const mid = '01HMSG'

    fakeRedis[`msg:${mid}:meta`] = { conversationId: sid, status: 'done' }
    zsets[`msg:${mid}:events`] = [
      { score: 1, member: JSON.stringify({ id: '1', seq: 1, type: 'cue',   data: { status: 'thinking', at: 1 } }) },
      { score: 2, member: JSON.stringify({ id: '2', seq: 2, type: 'token', data: { token: 'hi' } }) },
      { score: 3, member: JSON.stringify({ id: '3', seq: 3, type: 'done',  data: { messageId: mid, message: 'hi', model: 'm', at: 2 } }) },
    ]

    const { greppa } = await seededGreppa(request, sid)

    const handle = greppa.chat.resume(mid)
    const tokens: string[] = []
    for await (const t of handle.tokens) tokens.push(t.token)

    expect(tokens.join('')).toBe('hi')
    const final = await handle.done
    expect(final.message).toBe('hi')
    expect(final.messageId).toBe(mid)
  })

  test('SDK resume with last-event-id replays only events after that id', async () => {
    const sid = '01HRESUME'
    const mid = '01HRESUMEMSG'

    fakeRedis[`msg:${mid}:meta`] = { conversationId: sid, status: 'done' }
    zsets[`msg:${mid}:events`] = [
      { score: 1, member: JSON.stringify({ id: '1', seq: 1, type: 'token', data: { token: 'a' } }) },
      { score: 2, member: JSON.stringify({ id: '2', seq: 2, type: 'token', data: { token: 'b' } }) },
      { score: 3, member: JSON.stringify({ id: '3', seq: 3, type: 'token', data: { token: 'c' } }) },
      { score: 4, member: JSON.stringify({ id: '4', seq: 4, type: 'done',  data: { messageId: mid, message: 'abc', model: 'm', at: 4 } }) },
    ]

    const { store } = await seededGreppa(request, sid)
    const baseFetch = createInteropFetch(request)

    const fetchWithResume: typeof fetch = (async (input, init) => {
      const url = typeof input === 'string' ? input : (input as URL).toString()
      if (url.includes('/chat/stream')) {
        const headers = new Headers(init?.headers)
        headers.set('last-event-id', '2')
        return baseFetch(input as any, { ...(init ?? {}), headers })
      }
      return baseFetch(input as any, init)
    }) as typeof fetch

    const greppaResume = new Greppa({
      baseUrl: 'http://localhost/api/v1',
      fetch: fetchWithResume,
      sessionStore: store,
    })

    const handle = greppaResume.chat.resume(mid)
    const tokens: string[] = []
    for await (const t of handle.tokens) tokens.push(t.token)

    expect(tokens.join('')).toBe('c')
  })

  test('SDK resume against a foreign sessionId surfaces an error event', async () => {
    const ownerSid = '01HOWNER'
    const otherSid = '01HOTHER'
    const mid = '01HFOREIGN'

    fakeRedis[`msg:${mid}:meta`] = { conversationId: ownerSid, status: 'done' }

    const { greppa } = await seededGreppa(request, otherSid)

    const handle = greppa.chat.resume(mid)
    handle.done.catch(() => {})

    let errorSeen: { code: string; reason: string } | null = null
    try {
      for await (const ev of handle.events) {
        if (ev.type === 'error') errorSeen = ev.data
      }
    } catch {
    }

    expect(errorSeen?.code).toBe('not_found')
  })
})
