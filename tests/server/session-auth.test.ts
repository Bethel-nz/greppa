import { describe, expect, test, beforeEach } from 'bun:test'
import { Hono } from 'hono'
import { signSessionId } from '../../lib/hmac'
import { _resetGreppaConfigForTests } from '../../lib/config'

const SECRET = 'c'.repeat(48)

beforeEach(() => {
  _resetGreppaConfigForTests()
  process.env.GREPPA_SESSION_SECRET = SECRET
  delete process.env.GREPPA_DEPLOYER_KEY
})

describe('session-auth middleware', () => {
  test('rejects requests with no session header', async () => {
    const { sessionAuth } = await import('../../middleware/session-auth')
    const app = new Hono()
    app.use('*', sessionAuth)
    app.get('/x', (c) => c.text('ok'))
    const res = await app.request('/x')
    expect(res.status).toBe(401)
  })

  test('rejects requests with bad signature', async () => {
    const { sessionAuth } = await import('../../middleware/session-auth')
    const app = new Hono()
    app.use('*', sessionAuth)
    app.get('/x', (c) => c.text('ok'))
    const res = await app.request('/x', {
      headers: { 'x-greppa-session': 'sid-1', 'x-greppa-session-sig': '0'.repeat(64) },
    })
    expect(res.status).toBe(401)
  })

  test('accepts valid session and sets context', async () => {
    const { sessionAuth } = await import('../../middleware/session-auth')
    const app = new Hono()
    app.use('*', sessionAuth)
    app.get('/x', (c) => c.json({ sid: c.get('sessionId'), dep: c.get('isDeployer') }))
    const sid = 'sid-1'
    const sig = signSessionId(sid, SECRET)
    const res = await app.request('/x', {
      headers: { 'x-greppa-session': sid, 'x-greppa-session-sig': sig },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ sid: 'sid-1', dep: false })
  })

  test('valid deployer key bypasses session header requirement', async () => {
    process.env.GREPPA_DEPLOYER_KEY = 'super-secret'
    _resetGreppaConfigForTests()
    const { sessionAuth } = await import('../../middleware/session-auth')
    const app = new Hono()
    app.use('*', sessionAuth)
    app.get('/x', (c) => c.json({ sid: c.get('sessionId'), dep: c.get('isDeployer') }))
    const res = await app.request('/x', {
      headers: { 'x-greppa-deployer-key': 'super-secret' },
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.dep).toBe(true)
    expect(body.sid).toBe('deployer')
  })
})