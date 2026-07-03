import { describe, expect, test, beforeAll, beforeEach } from 'bun:test'
import { createMockApp } from '@bethel-nz/sumi/testing'
import { _resetGreppaConfigForTests } from '~/lib/config'

function setEnv() {
  process.env.GREPPA_SESSION_SECRET = 'd'.repeat(48)
  process.env.UPSTASH_REDIS_REST_URL = 'http://localhost:1'
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fake'
}

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
})

describe('POST /session', () => {
  test('returns sessionId and ttlMs', async () => {
    const res = await request('/session', { method: 'POST' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { sessionId: string; ttlMs: number }
    expect(body.sessionId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(body.ttlMs).toBeGreaterThan(0)
  })
})
