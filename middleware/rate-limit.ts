import { createMiddleware } from '@bethel-nz/sumi/router'
import type { SumiContext } from '@bethel-nz/sumi/types'
import { redis } from '../lib/redis'
import { loadGreppaConfig } from '../lib/config'

async function bumpAndCheck(key: string, windowMs: number, limit: number): Promise<{ ok: boolean; resetIn: number }> {
  const bucket = Math.floor(Date.now() / windowMs)
  const fullKey = `${key}:${bucket}`
  const count = await redis.incr(fullKey)
  if (count === 1) {
    await redis.pexpire(fullKey, windowMs)
  }
  if (count > limit) {
    const resetIn = (bucket + 1) * windowMs - Date.now()
    return { ok: false, resetIn }
  }
  return { ok: true, resetIn: 0 }
}

export default createMiddleware({
  _: async (c: SumiContext, next) => {
    const cfg = loadGreppaConfig()
    const ip =
      c.req.header('x-forwarded-for')?.split(',')[0].trim() ||
      c.req.header('x-real-ip') ||
      'unknown'
    const sid = c.get('sessionId')

    const ipCheck = await bumpAndCheck(`rate:ip:${ip}`, cfg.rateLimit.ip.windowMs, cfg.rateLimit.ip.limit)
    if (!ipCheck.ok) {
      c.header('retry-after-ms', String(ipCheck.resetIn))
      return c.json({ error: 'rate_limited', scope: 'ip' }, 429)
    }

    if (sid) {
      const sCheck = await bumpAndCheck(`rate:session:${sid}`, cfg.rateLimit.session.windowMs, cfg.rateLimit.session.limit)
      if (!sCheck.ok) {
        c.header('retry-after-ms', String(sCheck.resetIn))
        return c.json({ error: 'rate_limited', scope: 'session' }, 429)
      }
    }

    return next()
  },
})
