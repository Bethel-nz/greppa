import type { MiddlewareHandler } from 'hono'
import { createMiddleware } from '@bethel-nz/sumi/router'
import type { SumiContext } from '@bethel-nz/sumi/types'
import { loadGreppaConfig } from '../lib/config'
import { verifySessionId } from '../lib/hmac'

export const sessionAuth: MiddlewareHandler = async (c, next) => {
  const cfg = loadGreppaConfig()
  const deployerHeader = c.req.header('x-greppa-deployer-key')
  if (cfg.deployerKey && deployerHeader && deployerHeader === cfg.deployerKey) {
    c.set('sessionId', 'deployer')
    c.set('isDeployer', true)
    return next()
  }

  const sid = c.req.header('x-greppa-session')
  const sig = c.req.header('x-greppa-session-sig')
  if (!sid || !sig) {
    return c.json({ error: 'session headers required' }, 401)
  }
  if (!verifySessionId(sid, sig, cfg.sessionSecret)) {
    return c.json({ error: 'invalid session' }, 401)
  }
  c.set('sessionId', sid)
  c.set('isDeployer', false)
  return next()
}

export default createMiddleware({
  _: async (c: SumiContext, next) => sessionAuth(c, next),
})