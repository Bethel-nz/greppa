import type { MiddlewareHandler } from 'hono'
import { createMiddleware } from '@bethel-nz/sumi/router'
import type { SumiContext } from '@bethel-nz/sumi/types'
import { auth } from '../lib/auth'

export const userAuth: MiddlewareHandler = async (c, next) => {
  const session = await auth.api.getSession({
    headers: c.req.raw.headers,
  })

  if (!session?.user || !session?.session) {
    return c.json({ error: 'authentication required' }, 401)
  }

  c.set('userId', session.user.id)
  c.set('authUser', session.user)
  c.set('authSession', session.session)

  const orgId = c.req.header('x-greppa-org-id')
  c.set('orgId', orgId || null)

  return next()
}

export default createMiddleware({
  _: async (c: SumiContext, next) => userAuth(c, next),
})
