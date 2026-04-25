import { describe, expect, test, beforeEach } from 'bun:test'
import { createMockApp } from '@bethel-nz/sumi/testing'
import { _resetGreppaConfigForTests } from '../../lib/config'

beforeEach(() => {
  _resetGreppaConfigForTests()
  process.env.GREPPA_SESSION_SECRET = 'd'.repeat(48)
  process.env.UPSTASH_REDIS_REST_URL = 'http://localhost:1'
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fake'
})

describe('POST /session', () => {
  test('returns sessionId, sig, ttlMs', async () => {
    const { request } = await createMockApp({
      routesDir: 'routes',
      middlewareDir: 'middleware',
      basePath: '/api/v1',
    })
    const res = await request('/session', { method: 'POST' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { sessionId: string; sig: string; ttlMs: number }
    expect(body.sessionId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(body.sig).toMatch(/^[0-9a-f]{64}$/)
    expect(body.ttlMs).toBeGreaterThan(0)
  })
})