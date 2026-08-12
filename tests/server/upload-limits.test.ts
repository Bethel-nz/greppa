import { afterEach, describe, expect, mock, test } from 'bun:test'
import { Hono } from 'hono'

const r2 = { size: null as number | null, deleted: [] as string[] }
mock.module('../../lib/memory/presign', () => ({
  generatePresignedUploadUrl: async (key: string) => ({ uploadUrl: `https://r2.test/${key}`, key, expiresIn: 300 }),
  buildUploadKey: (orgId: string, userId: string, filename: string) => `uploads/${orgId}/${userId}/uuid-${filename}`,
  headUploadedSize: async () => r2.size,
  deleteUpload: async (key: string) => {
    r2.deleted.push(key)
  },
}))

const triggered: unknown[] = []
mock.module('../../lib/workflow', () => ({
  triggerIngestWorkflow: async (input: unknown) => {
    triggered.push(input)
  },
}))

mock.module('../../lib/knowledge/services/progress.service', () => ({
  createIngestionJob: async () => ({ id: 'job-1' }),
}))

mock.module('../../lib/db', () => ({
  drizzle: { insert: () => ({ values: async () => undefined }) },
  schema: { documents: {} },
}))

const { jsonError } = await import('~/lib/errors')
const presignRoute = (await import('~/routes/knowledge/presign')).default
const ingestRoute = (await import('~/routes/knowledge/ingest')).default
const { formatBytes, maxUploadBytes } = await import('~/lib/memory/upload-limits')

const MIB = 1024 * 1024

function mount(route: any, path: string) {
  const app = new Hono()
  app.onError((err, c) => jsonError(c, err) ?? c.json({ error: err.message }, 500))
  app.use('*', async (c, next) => {
    c.set('userId' as never, 'user-1' as never)
    await next()
  })
  app.post(path, async (c) => {
    const body = await c.req.json()
    ;(c.req as any).valid = () => body
    return route.post.handler(c)
  })
  return app
}

const post = (app: Hono, path: string, body: unknown) =>
  app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

afterEach(() => {
  delete process.env.MAX_UPLOAD_BYTES
  r2.size = null
  r2.deleted.length = 0
  triggered.length = 0
})

describe('maxUploadBytes', () => {
  test('defaults to 25 MiB', () => {
    expect(maxUploadBytes()).toBe(25 * MIB)
  })

  test('is overridable by env', () => {
    process.env.MAX_UPLOAD_BYTES = String(5 * MIB)
    expect(maxUploadBytes()).toBe(5 * MIB)
  })

  test('falls back to the default on junk rather than disabling the limit', () => {
    for (const junk of ['', 'lots', '-1', '0', 'NaN']) {
      process.env.MAX_UPLOAD_BYTES = junk
      expect(maxUploadBytes()).toBe(25 * MIB)
    }
  })

  test('formats limits the way the error messages read', () => {
    expect(formatBytes(2 * MIB)).toBe('2 MiB')
    expect(formatBytes(25 * MIB)).toBe('25 MiB')
    expect(formatBytes(1.5 * MIB)).toBe('1.5 MiB')
  })
})

describe('POST /knowledge/presign', () => {
  const app = mount(presignRoute, '/presign')
  const body = (extra: object = {}) => ({
    filename: 'big.pdf',
    contentType: 'application/pdf',
    orgId: 'org-1',
    ...extra,
  })

  test('issues a URL when the declared size is under the ceiling', async () => {
    const res = await post(app, '/presign', body({ size: 10 * MIB }))
    expect(res.status).toBe(200)
    expect((await res.json()).uploadUrl).toContain('uploads/org-1/user-1/')
  })

  test('refuses to issue a URL when the declared size is over the ceiling', async () => {
    const res = await post(app, '/presign', body({ size: 30 * MIB }))
    expect(res.status).toBe(413)
    const json = await res.json()
    expect(json.error).toContain('25 MiB')
    expect(json.limitBytes).toBe(25 * MIB)
  })

  test('honours a lowered ceiling', async () => {
    process.env.MAX_UPLOAD_BYTES = String(4 * MIB)
    const res = await post(app, '/presign', body({ size: 5 * MIB }))
    expect(res.status).toBe(413)
    expect((await res.json()).error).toContain('4 MiB')
  })

  test('still issues a URL when no size is declared, since ingest re-checks', async () => {
    const res = await post(app, '/presign', body())
    expect(res.status).toBe(200)
  })
})

describe('POST /knowledge/ingest', () => {
  const app = mount(ingestRoute, '/ingest')
  const body = { key: 'uploads/org-1/user-1/uuid-big.pdf', title: 'Big', orgId: 'org-1' }

  test('queues the workflow for an object inside the limit', async () => {
    r2.size = 10 * MIB
    const res = await post(app, '/ingest', body)

    expect(res.status).toBe(202)
    expect((await res.json()).status).toBe('queued')
    expect(triggered).toHaveLength(1)
  })

  test('rejects an object that is over the limit despite what presign was told', async () => {
    r2.size = 40 * MIB
    const res = await post(app, '/ingest', body)

    expect(res.status).toBe(413)
    expect((await res.json()).error).toContain('40 MiB')
    expect(triggered).toHaveLength(0)
  })

  test('removes the oversized object instead of leaving it unreferenced', async () => {
    r2.size = 40 * MIB
    await post(app, '/ingest', body)
    expect(r2.deleted).toEqual([body.key])
  })

  test('404s when nothing was actually uploaded to the key', async () => {
    r2.size = null
    const res = await post(app, '/ingest', body)

    expect(res.status).toBe(404)
    expect(triggered).toHaveLength(0)
  })

  test('accepts an object exactly at the ceiling', async () => {
    r2.size = maxUploadBytes()
    const res = await post(app, '/ingest', body)
    expect(res.status).toBe(202)
  })
})
