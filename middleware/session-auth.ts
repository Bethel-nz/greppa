import type { MiddlewareHandler } from 'hono'
import { createMiddleware } from '@bethel-nz/sumi/router'
import type { SumiContext } from '@bethel-nz/sumi/types'
import { auth } from '../lib/auth'
import { getDrizzle } from '../lib/db'
import { redis } from '../lib/redis'

export const sessionAuth: MiddlewareHandler = async (c, next) => {
  const conversationId = c.req.header('x-greppa-session')
  if (!conversationId) {
    return c.json({ error: 'session headers required' }, 401)
  }

  c.set('sessionId', conversationId)
  c.set('conversationId', conversationId)

  const orgId = c.req.header('x-greppa-org-id')
  c.set('orgId', orgId || null)

  const session = await auth.api.getSession({
    headers: c.req.raw.headers,
  })

  if (session?.user && session?.session) {
    const userId = session.user.id
    c.set('userId', userId)
    c.set('authUser', session.user)
    c.set('authSession', session.session)
    c.set('isAnonymous', false)

    try {
      const cacheKey = `user:${userId}:orgs`
      const cached = await redis.get(cacheKey)
      if (!cached) {
        const db = getDrizzle()
        const memberships = await db.query.memberships.findMany({
          where: (m, { eq }) => eq(m.userId, userId),
        })
        const orgData = memberships.map((m) => ({
          orgId: m.orgId,
          role: m.role,
          groupIds: m.groupIds,
        }))
        await redis.set(cacheKey, JSON.stringify(orgData), { ex: 3600 }) 
      }
    } catch {
    }

    return next()
  }

  c.set('userId', null)
  c.set('authUser', null)
  c.set('authSession', null)
  c.set('isAnonymous', true)
  return next()
}

export default createMiddleware({
  _: async (c: SumiContext, next) => sessionAuth(c, next),
})
