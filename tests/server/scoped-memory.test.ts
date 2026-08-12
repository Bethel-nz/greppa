import { freshUser, getAnswerCalls } from './_memory-mocks'
import { describe, expect, test } from 'bun:test'

const {
  addScopedMemory,
  fuseAcrossScopes,
  listScopedFacts,
  retrieveScopedContext,
  searchScopedMemory,
} = await import('~/lib/memory/scoped-service')
const { contentDocumentId } = await import('~/lib/memory/document-id')

describe('scoped-service', () => {
  test('addScopedMemory creates the scope file and returns an indexed document', async () => {
    const userId = freshUser()
    const res = await addScopedMemory({ userId, title: 'Pets', text: 'I have a dog named Rex.' })

    expect(res.scopeId).toBe(`scope-${userId}`)
    expect(res.documentId).toMatch(/^[0-9a-f-]{36}$/)
    expect(res.status).toBe('indexed')
  })

  test('a written memory round-trips through storage and is retrievable', async () => {
    const userId = freshUser()
    await addScopedMemory({ userId, title: 'Pets', text: 'I have a dog named Rex.' })

    const found = await searchScopedMemory({ userId, query: 'dog named Rex' })
    expect(found.total_hits).toBe(1)
    expect(found.hits[0]!.title).toBe('Pets')
    expect(found.hits[0]!.snippet).toContain('Rex')

    const retrieved = await retrieveScopedContext({ userId, question: 'dog named Rex' })
    expect(retrieved.context).toContain('Rex')
  })

  test('a second memory appends, it does not overwrite the first', async () => {
    const userId = freshUser()
    const first = await addScopedMemory({ userId, title: 'Pets', text: 'I have a dog named Rex.' })
    const second = await addScopedMemory({ userId, title: 'Food', text: 'I love jollof rice.' })
    expect(first.documentId).not.toBe(second.documentId)

    const dog = await searchScopedMemory({ userId, query: 'dog named Rex' })
    const food = await searchScopedMemory({ userId, query: 'jollof rice' })
    expect(dog.hits[0]!.title).toBe('Pets')
    expect(food.hits[0]!.title).toBe('Food')
  })

  test('a long memory is chunked into several retrievable pieces', async () => {
    const userId = freshUser()
    const long = Array.from(
      { length: 12 },
      (_, i) => `Paragraph ${i} discusses distinctive topic marker${i} at some length to force splitting.`,
    ).join('\n\n')
    await addScopedMemory({ userId, title: 'Long', text: long, sourceType: 'document' })

    const res = await searchScopedMemory({ userId, query: 'marker7 distinctive topic' })
    expect(res.hits.length).toBeGreaterThan(0)
    expect(res.hits[0]!.title).toBe('Long')
  })

  test('searchScopedMemory on an empty scope returns no hits, not an error', async () => {
    const res = await searchScopedMemory({ userId: freshUser(), query: 'anything' })
    expect(res).toEqual({ hits: [], total_hits: 0, edges: [] })
  })

  test('one user cannot retrieve another user memory (scope isolation)', async () => {
    const alice = freshUser()
    const bob = freshUser()
    await addScopedMemory({ userId: alice, title: 'Secret', text: 'Alice keeps bees.' })

    const bobView = await retrieveScopedContext({ userId: bob, question: 'bees' })
    expect(bobView.context).toBe('')
    expect(bobView.sources).toEqual([])
  })

  test('refuses to store an empty memory rather than writing a vectorless document', async () => {
    await expect(addScopedMemory({ userId: freshUser(), title: 'Empty', text: '   ' })).rejects.toThrow(
      /empty memory/,
    )
  })

  test('hits carry the fields lib/chat/tools.ts consumes', async () => {
    const userId = freshUser()
    await addScopedMemory({ userId, title: 'Shape', text: 'distinctive payload for shape checking' })
    const { hits } = await searchScopedMemory({ userId, query: 'distinctive payload shape' })
    const hit = hits[0]!
    expect(typeof hit.title).toBe('string')
    expect(typeof hit.snippet).toBe('string')
    expect(typeof hit.score).toBe('number')
  })
})

describe('standing facts', () => {
  test('returns only facts, never notes or archived conversations', async () => {
    const userId = freshUser()
    await addScopedMemory({ userId, title: 'Colour', text: 'The user likes the colour red.', sourceType: 'fact' })
    await addScopedMemory({ userId, title: 'Editor', text: 'The user prefers Neovim.', sourceType: 'fact' })
    await addScopedMemory({
      userId,
      title: 'Conversation abc',
      text: 'User: what is the weather\n\nAssistant: I have no live weather access.',
      sourceType: 'chat',
    })
    await addScopedMemory({ userId, title: 'Some note', text: 'An ordinary note.', sourceType: 'note' })

    const texts = (await listScopedFacts({ userId })).map((f) => f.text)

    expect(texts).toHaveLength(2)
    expect(texts).toContain('The user likes the colour red.')
    expect(texts).toContain('The user prefers Neovim.')
    expect(texts.join(' ')).not.toContain('weather')
    expect(texts.join(' ')).not.toContain('ordinary note')
  })

  test('orders newest first and honours the budget', async () => {
    const userId = freshUser()
    for (const n of [1, 2, 3, 4]) {
      await addScopedMemory({ userId, title: `F${n}`, text: `Fact number ${n}.`, sourceType: 'fact' })
    }

    const facts = await listScopedFacts({ userId, limit: 2 })
    expect(facts).toHaveLength(2)
    expect(facts[0]!.text).toBe('Fact number 4.')
    expect(facts[1]!.text).toBe('Fact number 3.')
  })

  test('reassembles a multi-chunk fact in chunk order', async () => {
    const userId = freshUser()
    const head = `HEAD ${'alpha '.repeat(200)}`.trim()
    const tail = `TAIL ${'omega '.repeat(200)}`.trim()
    await addScopedMemory({ userId, title: 'Long', text: `${head}\n\n${tail}`, sourceType: 'fact' })

    const [fact] = await listScopedFacts({ userId })
    expect(fact).toBeDefined()
    expect(fact!.text.indexOf('HEAD')).toBeLessThan(fact!.text.indexOf('TAIL'))
  })

  test('returns nothing for a scope that was never written', async () => {
    expect(await listScopedFacts({ userId: freshUser() })).toEqual([])
  })
})

describe('retrieveScopedContext', () => {
  test('builds context without calling a model', async () => {
    const userId = freshUser()
    await addScopedMemory({ userId, title: 'Vet visit', text: 'Rex saw the veterinarian on Tuesday.' })

    const before = getAnswerCalls()
    const result = await retrieveScopedContext({ userId, question: 'veterinarian Rex Tuesday' })

    expect(result.context).toContain('Rex')
    expect(result.sources.length).toBeGreaterThan(0)
    expect(getAnswerCalls()).toBe(before)
  })

  test('returns an empty result rather than throwing on an empty scope', async () => {
    expect(await retrieveScopedContext({ userId: freshUser(), question: 'anything' })).toEqual({
      sources: [],
      context: '',
      edges: [],
    })
  })
})

describe('uploaded documents are memory', () => {
  test('a stored document is retrievable later and carries its identity', async () => {
    const userId = freshUser()
    await addScopedMemory({
      userId,
      title: 'Q3 revenue report',
      text: 'Revenue for the third quarter reached 4.2 million, up 18 percent year over year.',
      sourceType: 'document',
      sourceUrl: 'q3-report.pdf',
    })

    const { hits } = await searchScopedMemory({ userId, query: 'third quarter revenue growth' })

    expect(hits.length).toBeGreaterThan(0)
    const hit = hits[0]!
    expect(hit.title).toBe('Q3 revenue report')
    expect(hit.sourceType).toBe('document')
    expect(hit.sourceUrl).toBe('q3-report.pdf')
    expect(typeof hit.documentId).toBe('string')
  })

  test('documents and facts share one scope and both surface', async () => {
    const userId = freshUser()
    await addScopedMemory({
      userId,
      title: 'Design brief',
      text: 'The launch page should emphasise clarity over density.',
      sourceType: 'document',
    })
    await addScopedMemory({ userId, title: 'Colour', text: 'The user likes red.', sourceType: 'fact' })

    const { hits } = await searchScopedMemory({ userId, query: 'launch page clarity density' })
    expect(hits.some((h) => h.sourceType === 'document')).toBe(true)

    const facts = await listScopedFacts({ userId })
    expect(facts.map((f) => f.text)).toEqual(['The user likes red.'])
  })
})

describe('cross-scope fusion', () => {
  const hit = (documentId: string, chunkId: number, score: number) =>
    ({
      title: documentId,
      snippet: documentId,
      text: documentId,
      score,
      documentId,
      chunkId,
      sourceType: 'document',
      sourceUrl: null,
      modality: 'text',
      assetSha256: null,
    }) as any

  test('chunk ids that collide across stores stay separate results', () => {
    const personal = [hit('personal-doc', 1, 0.9)]
    const org = [hit('org-doc', 1, 0.9)]

    const fused = fuseAcrossScopes([personal, org], 10)

    expect(fused).toHaveLength(2)
    expect(fused.map((h) => h.documentId).sort()).toEqual(['org-doc', 'personal-doc'])
  })

  test('a top hit from either scope outranks a low-ranked one from the other', () => {
    const personal = [hit('p1', 1, 0.5), hit('p2', 2, 0.4), hit('p3', 3, 0.3)]
    const org = [hit('o1', 1, 0.99)]

    const fused = fuseAcrossScopes([personal, org], 10)

    expect(fused.slice(0, 2).map((h) => h.documentId).sort()).toEqual(['o1', 'p1'])
  })

  test('honours the limit', () => {
    const personal = [hit('p1', 1, 0.5), hit('p2', 2, 0.4)]
    const org = [hit('o1', 1, 0.5), hit('o2', 2, 0.4)]

    expect(fuseAcrossScopes([personal, org], 3)).toHaveLength(3)
  })

  test('an empty scope contributes nothing and changes no order', () => {
    const personal = [hit('p1', 1, 0.5), hit('p2', 2, 0.4)]

    const fused = fuseAcrossScopes([personal, []], 10)

    expect(fused.map((h) => h.documentId)).toEqual(['p1', 'p2'])
  })
})

describe('deduplication', () => {
  test('re-adding the same id reports a duplicate and does not store a second copy', async () => {
    const userId = freshUser()
    const id = contentDocumentId(userId, 'The Q3 report shows revenue of 4.2 million.')
    const input = {
      id,
      userId,
      title: 'Q3 report',
      text: 'The Q3 report shows revenue of 4.2 million.',
      sourceType: 'document' as const,
    }

    const first = await addScopedMemory(input)
    const second = await addScopedMemory(input)

    expect(first.status).toBe('indexed')
    expect(second.status).toBe('duplicate')
    expect(second.documentId).toBe(first.documentId)

    const { hits } = await searchScopedMemory({ userId, query: 'Q3 revenue 4.2 million' })
    expect(hits.filter((h) => h.documentId === id)).toHaveLength(1)
  })

  test('a re-upload under a different filename is still the same document', async () => {
    const userId = freshUser()
    const text = 'Deployment runbook: drain the queue before rolling pods.'
    const id = contentDocumentId(userId, text)

    await addScopedMemory({ id, userId, title: 'runbook.md', text, sourceType: 'document', sourceUrl: 'runbook.md' })
    const again = await addScopedMemory({
      id,
      userId,
      title: 'runbook-final.md',
      text,
      sourceType: 'document',
      sourceUrl: 'runbook-final.md',
    })

    expect(again.status).toBe('duplicate')
  })

  test('different content from the same user is a different document', async () => {
    const userId = freshUser()
    expect(contentDocumentId(userId, 'one')).not.toBe(contentDocumentId(userId, 'two'))
  })

  test('identical content from different users does not collide', () => {
    expect(contentDocumentId('user-a', 'shared text')).not.toBe(contentDocumentId('user-b', 'shared text'))
  })

  test('a file stored as memory answers a question in a later, unrelated session', async () => {
    const userId = freshUser()
    const text = 'The Helios migration is scheduled for 14 March and Priya owns the cutover.'

    await addScopedMemory({
      id: contentDocumentId(userId, text),
      userId,
      title: 'helios-plan.md',
      text,
      sourceType: 'document',
      sourceUrl: 'helios-plan.md',
    })

    const { sources, context } = await retrieveScopedContext({
      userId,
      question: 'who owns the Helios cutover?',
    })

    expect(context).toContain('Priya')
    expect(sources[0]).toMatchObject({
      documentId: contentDocumentId(userId, text),
      sourceType: 'document',
      sourceUrl: 'helios-plan.md',
    })
  })

  test('an id-less write is never treated as a duplicate', async () => {
    const userId = freshUser()
    const input = { userId, title: 'Note', text: 'Some passing thought.' }

    const first = await addScopedMemory(input)
    const second = await addScopedMemory(input)

    expect(first.status).toBe('indexed')
    expect(second.status).toBe('indexed')
    expect(second.documentId).not.toBe(first.documentId)
  })
})
