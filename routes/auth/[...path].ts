import { createRoute } from '@bethel-nz/sumi/router'
import { auth } from '~/lib/auth'

export default createRoute({
  get: {
    handler: async (c) => auth.handler(c.req.raw),
  },
  post: {
    handler: async (c) => auth.handler(c.req.raw),
  },
})
