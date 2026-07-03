import './_mocks'
import { beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { createMockApp } from '@bethel-nz/sumi/testing'
import { _resetGreppaConfigForTests } from '~/lib/config'

type MockAuthSession = {
  user: {
    id: string
    email: string
    name: string | null
    emailVerified: boolean
    image: string | null
    createdAt: Date
    updatedAt: Date
  }
  session: {
    id: string
    userId: string
    expiresAt: Date
    createdAt: Date
    updatedAt: Date
    token: string
    ipAddress: string | null
    userAgent: string | null
  }
} | null

let currentSession: MockAuthSession = null

mock.module('../../lib/auth', () => ({
  auth: {
    api: {
      getSession: async () => currentSession,
    },
    handler: async (request: Request) =>
      Response.json({
        ok: true,
        method: request.method,
        pathname: new URL(request.url).pathname,
      }),
  },
}))

function setEnv() {
  process.env.GREPPA_SESSION_SECRET = 'f'.repeat(48)
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
  currentSession = null
  _resetGreppaConfigForTests()
  setEnv()
})

describe('Better Auth integration', () => {
  test('GET /auth/* delegates to Better Auth handler', async () => {
    const res = await request('/auth/ping', { method: 'GET' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      ok: true,
      method: 'GET',
      pathname: '/api/v1/auth/ping',
    })
  })

  test('GET /me rejects unauthenticated requests', async () => {
    const res = await request('/me')
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'authentication required' })
  })

  test('GET /me returns authenticated user and session', async () => {
    currentSession = {
      user: {
        id: 'user_123',
        email: 'jane@example.com',
        name: 'Jane',
        emailVerified: true,
        image: null,
        createdAt: new Date('2026-05-24T00:00:00.000Z'),
        updatedAt: new Date('2026-05-24T00:00:00.000Z'),
      },
      session: {
        id: 'session_123',
        userId: 'user_123',
        expiresAt: new Date('2026-06-24T00:00:00.000Z'),
        createdAt: new Date('2026-05-24T00:00:00.000Z'),
        updatedAt: new Date('2026-05-24T00:00:00.000Z'),
        token: 'token_123',
        ipAddress: '127.0.0.1',
        userAgent: 'bun-test',
      },
    }

    const res = await request('/me')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      user: {
        id: 'user_123',
        email: 'jane@example.com',
        name: 'Jane',
        emailVerified: true,
        image: null,
      },
      session: {
        id: 'session_123',
        userId: 'user_123',
        expiresAt: '2026-06-24T00:00:00.000Z',
      },
    })
  })
})
