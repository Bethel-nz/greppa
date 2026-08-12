import { freshUser } from './_memory-mocks'
import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'

const { jsonError } = await import('~/lib/errors')
const knowledgeRoute = (await import('~/routes/knowledge')).default
const moveRoute = (await import('~/routes/knowledge/move')).default
const { retrieveScopedContext } = await import('~/lib/memory/scoped-service')

const WORKSPACE = 'ws-acme'
const FOLDER = 'folder-onboarding'

function mount(userId: string) {
  const app = new Hono()
  app.onError((err, c) => jsonError(c, err) ?? c.json({ error: err.message }, 500))
  app.use('*', async (c, next) => {
    c.set('userId' as never, userId as never)
    await next()
  })
  app.put('/knowledge', knowledgeRoute.put.handler as any)
  app.post('/knowledge/move', async (c) => {
    const body = await c.req.json()
    ;(c.req as any).valid = () => body
    return moveRoute.post.handler(c as never)
  })
  return app
}

function upload(app: Hono, text: string, name: string, placement: Record<string, string>) {
  const form = new FormData()
  form.set('file', new File([text], name, { type: 'text/markdown' }))
  for (const [key, value] of Object.entries(placement)) form.set(key, value)
  return app.request('/knowledge', { method: 'PUT', body: form })
}

const move = (app: Hono, body: unknown) =>
  app.request('/knowledge/move', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

const FILED = 'The onboarding checklist lives with the Helios runbook and is owned by Priya.'
const LOOSE = 'The Helios runbook covers the drain-and-roll-back cutover procedure.'
const QUESTION = 'Helios runbook onboarding'

async function seed(userId: string) {
  const app = mount(userId)
  const filed = await upload(app, FILED, 'filed.md', { workspaceId: WORKSPACE, folderId: FOLDER })
  const loose = await upload(app, LOOSE, 'loose.md', { workspaceId: WORKSPACE })
  expect(filed.status).toBe(201)
  expect(loose.status).toBe(201)
  return { app, looseId: (await loose.json()).documentId as string }
}

const titlesFor = async (userId: string, scope: object) =>
  (await retrieveScopedContext({ userId, question: QUESTION, ...scope })).sources
    .map((s) => s.sourceUrl)
    .sort()

describe('retrieval honours both hierarchies over HTTP', () => {
  test('a folder query returns only what is filed in it', async () => {
    const userId = freshUser()
    await seed(userId)

    expect(await titlesFor(userId, { workspaceId: WORKSPACE, folderId: FOLDER })).toEqual(['filed.md'])
    expect(await titlesFor(userId, { workspaceId: WORKSPACE })).toEqual(['filed.md', 'loose.md'])
  })

  test('the unfiled slot of a workspace is distinct from the workspace itself', async () => {
    const userId = freshUser()
    await seed(userId)

    expect(await titlesFor(userId, { workspaceId: WORKSPACE, folderId: null })).toEqual(['loose.md'])
  })
})

describe('POST /knowledge/move', () => {
  test('files a loose document into a folder and retrieval follows it', async () => {
    const userId = freshUser()
    const { app, looseId } = await seed(userId)

    const res = await move(app, { documentIds: [looseId], folderId: FOLDER })

    expect(res.status).toBe(200)
    expect((await res.json()).moved).toBe(1)
    expect(await titlesFor(userId, { workspaceId: WORKSPACE, folderId: FOLDER })).toEqual([
      'filed.md',
      'loose.md',
    ])
  })

  test('unplaces a document when the placement is explicitly null', async () => {
    const userId = freshUser()
    const { app, looseId } = await seed(userId)

    await move(app, { documentIds: [looseId], workspaceId: null })

    expect(await titlesFor(userId, { workspaceId: WORKSPACE })).toEqual(['filed.md'])
    expect(await titlesFor(userId, { workspaceId: null })).toEqual(['loose.md'])
  })

  test('rejects a move that names no placement rather than reporting a no-op success', async () => {
    const userId = freshUser()
    const { app, looseId } = await seed(userId)

    const res = await move(app, { documentIds: [looseId] })

    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('request.PLACEMENT_REQUIRED')
  })

  test('reports nothing moved for a document that is not in the caller scope', async () => {
    const userId = freshUser()
    const { app } = await seed(userId)

    const res = await move(app, { documentIds: ['someone-elses-doc'], folderId: FOLDER })

    expect(res.status).toBe(200)
    expect((await res.json()).moved).toBe(0)
  })
})
