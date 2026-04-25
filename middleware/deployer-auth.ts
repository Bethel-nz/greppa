import type { MiddlewareHandler } from 'hono'
import { createMiddleware } from '@bethel-nz/sumi/router'
import type { SumiContext } from '@bethel-nz/sumi/types'
import { loadGreppaConfig } from '../lib/config'

export const deployerAuth: MiddlewareHandler = async (c, next) => {
  const cfg = loadGreppaConfig()
  const provided = c.req.header('x-greppa-deployer-key')
  if (!cfg.deployerKey) {
    return c.json({ error: 'deployer key not configured on server' }, 500)
  }
  if (!provided || provided !== cfg.deployerKey) {
    return c.json({ error: 'deployer key required' }, 403)
  }
  c.set('isDeployer', true)
  return next()
}

export default createMiddleware({
  _: async (c: SumiContext, next) => deployerAuth(c, next),
})