import { describe, expect, test, beforeEach, mock } from 'bun:test'
import { Hono } from 'hono'
import { _resetGreppaConfigForTests } from '~/lib/config'

const SECRET = 'c'.repeat(48)

mock.module('../../lib/auth', () => ({
  auth: {
    api: {
      getSession: async () => null,
    },
  },
}))

beforeEach(() => {
  _resetGreppaConfigForTests()
  process.env.GREPPA_SESSION_SECRET = SECRET
})

describe('session-auth middleware (chat auth)', () => {
  test('rejects requests with no session header', async () => {
    const { sessionAuth } = await import('../../middleware/session-auth')
    const app = new Hono()
    app.use('*', sessionAuth)
    app.get('/x', (c) => c.text('ok'))
    const res = await app.request('/x')
    expect(res.status).toBe(401)
  })

  test('accepts conversation id and sets anonymous context', async () => {
    const { sessionAuth } = await import('../../middleware/session-auth')
    const app = new Hono()
    app.use('*', sessionAuth)
    app.get('/x', (c) =>
      c.json({
        sid: c.get('sessionId'),
        conversationId: c.get('conversationId'),
        isAnonymous: c.get('isAnonymous'),
      }),
    )
    const res = await app.request('/x', {
      headers: { 'x-greppa-session': 'conv-1' },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      sid: 'conv-1',
      conversationId: 'conv-1',
      isAnonymous: true,
    })
  })
})
