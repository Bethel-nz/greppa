import { createMiddleware } from '@bethel-nz/sumi/router'
import type { SumiContext } from '@bethel-nz/sumi/types'
import { cors } from 'hono/cors'

const allowedOrigins = (process.env.GREPPA_ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

const corsMw = cors({
  origin: (origin) => {
    if (!origin) return null
    if (allowedOrigins.includes('*')) return origin
    return allowedOrigins.includes(origin) ? origin : null
  },
  allowHeaders: [
    'content-type',
    'x-greppa-session',
    'x-greppa-session-sig',
    'x-greppa-deployer-key',
    'last-event-id',
  ],
  exposeHeaders: ['x-greppa-version', 'retry-after-ms'],
  credentials: true,
})

export default createMiddleware({
  _: async (c: SumiContext, next) => {
    c.header('x-greppa-version', '1')
    await corsMw(c, async () => {})
    if (c.res.status === 204 || c.req.method === 'OPTIONS') return c.res
    const t0 = Date.now()
    await next()
    console.log(`${c.req.method} ${c.req.url} ${c.res.status} ${Date.now() - t0}ms`)
  },
})