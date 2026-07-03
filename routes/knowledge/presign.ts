import { z } from 'zod'
import { createRoute } from '@bethel-nz/sumi/router'
import { resolver } from 'hono-openapi/zod'
import { generatePresignedUploadUrl, buildUploadKey } from '~/lib/memory/presign'

const bodySchema = z.object({
  filename: z.string().min(1).describe('Name of the file to upload'),
  contentType: z.string().optional().default('application/octet-stream').describe('MIME type of the file'),
  orgId: z.string().min(1).describe('Organization ID'),
})

const responseSchema = z.object({
  uploadUrl: z.string().describe('Presigned URL to PUT the file to'),
  key: z.string().describe('R2 object key (pass to /knowledge/ingest after upload)'),
  expiresIn: z.number().describe('URL expiry in seconds'),
})

export default createRoute({
  post: {
    schema: { json: bodySchema },
    middleware: ['user-auth'],
    handler: async (c) => {
      const userId = c.get('userId')
      if (!userId) {
        return c.json({ error: 'authentication required' }, 401)
      }

      const { filename, contentType, orgId } = c.req.valid('json')
      const key = buildUploadKey(orgId, userId, filename)
      const { uploadUrl, key: r2Key, expiresIn } = await generatePresignedUploadUrl(key, contentType)

      return c.json({ uploadUrl, key: r2Key, expiresIn })
    },
    openapi: {
      summary: 'Get presigned upload URL',
      description: 'Generates a presigned R2 URL for direct client uploads. After uploading, call POST /knowledge/ingest with the returned key.',
      tags: ['knowledge'],
      responses: {
        200: {
          description: 'Presigned URL generated',
          content: { 'application/json': { schema: resolver(responseSchema) } },
        },
        401: { description: 'Authentication required' },
      },
    },
  },
})
