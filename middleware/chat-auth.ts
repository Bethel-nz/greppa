import type { MiddlewareHandler } from 'hono'
import { createMiddleware } from '@bethel-nz/sumi/router'
import type { SumiContext } from '@bethel-nz/sumi/types'
import { auth } from '../lib/auth'

export const chatAuth: MiddlewareHandler = async (c, next) => {
  const conversationId = c.req.header('x-greppa-session')
  if (!conversationId) {
    return c.json({ error: 'conversation id required' }, 401)
  }

  c.set('conversationId', conversationId)

  // Try Better Auth session
  const session = await auth.api.getSession({
    headers: c.req.raw.headers,
  })

  if (session?.user && session?.session) {
    c.set('userId', session.user.id)
    c.set('authUser', session.user)
    c.set('authSession', session.session)
    c.set('isAnonymous', false)
    return next()
  }

  // Anonymous
  c.set('userId', null)
  c.set('authUser', null)
  c.set('authSession', null)
  c.set('isAnonymous', true)
  return next()
}

export default createMiddleware({
  _: async (c: SumiContext, next) => chatAuth(c, next),
})
