import { createRoute } from '@bethel-nz/sumi/router'
import { auth } from '~/lib/auth'

import { requestErrors } from '../../../lib/errors'
export default createRoute({
  delete: {
    middleware: ['user-auth'],
    handler: async (c) => {
      const keyId = c.req.param('keyId')
      if (!keyId) throw requestErrors.FIELD_REQUIRED({ field: 'keyId' })

      await auth.api.deleteApiKey({
        body: { keyId },
        headers: c.req.raw.headers,
      })
      return c.json({ deleted: true })
    },
    openapi: {
      summary: 'Revoke an API key',
      tags: ['auth'],
      responses: {
        200: { description: 'Key revoked' },
        401: { description: 'Authentication required' },
        404: { description: 'Key not found' },
      },
    },
  },
})
