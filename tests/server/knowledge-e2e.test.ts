import { freshUser, sharedCp, sharedStorage } from './_memory-mocks'
import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'

const { jsonError } = await import('~/lib/errors')
const knowledgeRoute = (await import('~/routes/knowledge')).default
const { retrieveScopedContext } = await import('~/lib/memory/scoped-service')
const { scopedDocumentId } = await import('~/lib/memory/document-id')

function mountKnowledge(userId: string | null) {
  const app = new Hono()
  app.onError((err, c) => jsonError(c, err) ?? c.json({ error: err.message }, 500))
  app.use('*', async (c, next) => {
    if (userId) c.set('userId' as never, userId as never)
    await next()
  })
  app.put('/knowledge', knowledgeRoute.put.handler as any)
  app.post('/knowledge', knowledgeRoute.post.handler as any)
  return app
}

function upload(file: File, title?: string) {
  const form = new FormData()
  form.set('file', file)
  if (title) form.set('title', title)
  return { method: 'PUT', body: form }
}

const PLAN = [
  '# Helios migration plan',
  '',
  'The cutover is scheduled for 14 March 2026.',
  'Priya Raman owns the cutover and signs off the go/no-go call.',
  'Rollback is a single command: drain the queue, then roll pods back to the previous tag.',
].join('\n')

describe('end to end: a file becomes memory', () => {
  test('upload over HTTP, flush to storage, then answer from a cold read', async () => {
    const userId = freshUser()
    const app = mountKnowledge(userId)
    const scopeKey = `scopes/scope-${userId}/memory.sqlite`

    expect(await sharedCp.stat(scopeKey)).toBeNull()
    const before = { ...sharedStorage.counts }

    const res = await app.request(
      '/knowledge',
      upload(new File([PLAN], 'helios-plan.md', { type: 'text/markdown' })),
    )
    const body = await res.json()

    expect(res.status).toBe(201)
    expect(body.status).toBe('indexed')
    expect(body.title).toBe('helios-plan.md')
    expect(body.documentId).toBe(scopedDocumentId(userId, undefined, PLAN))
    expect(body.wordCount).toBeGreaterThan(20)

    const flushed = await sharedCp.stat(scopeKey)
    expect(flushed).not.toBeNull()
    expect(flushed!.size).toBeGreaterThan(0)
    expect(sharedStorage.counts.put).toBeGreaterThanOrEqual(before.put + 1)
    expect(flushed!.etag).toBeTruthy()

    console.log(
      `[e2e] flushed ${scopeKey} -> ${flushed!.size} bytes, etag ${flushed!.etag}, ` +
        `storage ops: ${JSON.stringify(sharedStorage.counts)}`,
    )

    await sharedCp.closeAll()
    const afterFlush = { ...sharedStorage.counts }

    const { sources, context } = await retrieveScopedContext({
      userId,
      question: 'who owns the Helios cutover and when is it?',
    })

    expect(context).toContain('Priya')
    expect(context).toContain('14 March')
    expect(sources[0]).toMatchObject({
      documentId: scopedDocumentId(userId, undefined, PLAN),
      sourceType: 'document',
      sourceUrl: 'helios-plan.md',
    })

    expect(sharedStorage.counts.get).toBeGreaterThan(afterFlush.get)

    console.log(
      `[e2e] cold read downloaded the scope and cited ${sources[0]!.sourceUrl}; ` +
        `storage ops: ${JSON.stringify(sharedStorage.counts)}`,
    )
  })

  test('re-uploading the same file is a no-op, not a second copy', async () => {
    const userId = freshUser()
    const app = mountKnowledge(userId)
    const file = () => new File([PLAN], 'helios-plan.md', { type: 'text/markdown' })

    const first = await app.request('/knowledge', upload(file()))
    const second = await app.request('/knowledge', upload(file(), 'Helios (final)'))

    expect(first.status).toBe(201)
    expect(second.status).toBe(200)

    const firstBody = await first.json()
    const secondBody = await second.json()
    expect(secondBody.status).toBe('duplicate')
    expect(secondBody.documentId).toBe(firstBody.documentId)

    const { sources } = await retrieveScopedContext({ userId, question: 'Helios cutover owner' })
    const texts = sources.map((s) => s.snippet)
    expect(new Set(texts).size).toBe(texts.length)
    expect(new Set(sources.map((s) => s.documentId))).toEqual(new Set([firstBody.documentId]))
  })

  test('the same text written without a stable id does duplicate its chunks', async () => {
    const { addScopedMemory } = await import('~/lib/memory/scoped-service')
    const userId = freshUser()
    const input = { userId, title: 'Helios', text: PLAN, sourceType: 'document' as const }

    await addScopedMemory(input)
    await addScopedMemory(input)

    const { sources } = await retrieveScopedContext({ userId, question: 'Helios cutover owner' })
    const texts = sources.map((s) => s.snippet)
    expect(new Set(texts).size).toBeLessThan(texts.length)
  })

  test('rejects a file over the inline limit before parsing it', async () => {
    const app = mountKnowledge(freshUser())
    const oversized = new File(['x'.repeat(2 * 1024 * 1024 + 1)], 'big.md', { type: 'text/markdown' })

    const res = await app.request('/knowledge', upload(oversized))

    expect(res.status).toBe(413)
    expect((await res.json()).error).toContain('2 MiB')
  })

  test(
    'accepts a file that sits just under the inline limit',
    async () => {
      const app = mountKnowledge(freshUser())
      const justUnder = new File(['word '.repeat(400_000)], 'big.md', { type: 'text/markdown' })
      expect(justUnder.size).toBeLessThanOrEqual(2 * 1024 * 1024)

      const res = await app.request('/knowledge', upload(justUnder))

      expect(res.status).toBe(201)
    },
    30_000,
  )

  test('rejects a file with no readable text rather than storing an empty document', async () => {
    const app = mountKnowledge(freshUser())
    const empty = new File(['   \n  '], 'blank.md', { type: 'text/markdown' })

    const res = await app.request('/knowledge', upload(empty))

    expect(res.status).toBe(415)
    expect((await res.json()).error).toMatch(/no readable text/)
  })

  test('rejects an unauthenticated upload', async () => {
    const app = mountKnowledge(null)
    const res = await app.request('/knowledge', upload(new File([PLAN], 'p.md', { type: 'text/markdown' })))
    expect(res.status).toBe(401)
  })

  test('rejects a body that is not multipart', async () => {
    const app = mountKnowledge(freshUser())
    const res = await app.request('/knowledge', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ file: 'nope' }),
    })
    expect(res.status).toBe(400)
  })

  test('rejects a multipart body with no file field', async () => {
    const app = mountKnowledge(freshUser())
    const form = new FormData()
    form.set('title', 'no file attached')
    const res = await app.request('/knowledge', { method: 'PUT', body: form })

    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/file field/)
  })

  test('a caller-supplied title wins over the filename', async () => {
    const app = mountKnowledge(freshUser())
    const res = await app.request(
      '/knowledge',
      upload(new File([PLAN], 'helios-plan.md', { type: 'text/markdown' }), 'Q1 migration plan'),
    )
    expect((await res.json()).title).toBe('Q1 migration plan')
  })
})
