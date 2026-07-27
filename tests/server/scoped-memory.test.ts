import { afterAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rm } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Checkpoint } from '~/utils/checkpoint/checkpoint'
import { MemoryStorage } from '~/utils/checkpoint/storage'
import { NotFoundError } from '~/utils/checkpoint/errors'

// scoped-service has three hard dependencies we replace at the seam:
//   1. ./scope       -> map userId to a stable scopeId without Postgres
//   2. ~/utils/checkpoint -> a real Checkpoint over MemoryStorage (no R2)
//   3. ./answer      -> the grounded-answer LLM call, so ask() needs no model
//
// The store itself is NOT faked. These tests exercise real SQLite, real
// sqlite-vec and real FTS5 through the full write -> seal -> upload -> download
// -> read round-trip. The embedding provider defaults to `deterministic`, which
// needs no network (Bun skips .env.local when NODE_ENV=test).

const cacheDir = mkdtempSync(join(tmpdir(), 'scoped-cp-'))
const sharedCp = new Checkpoint({ storage: new MemoryStorage(), cacheDir, maxOpen: 8, idleMs: 60_000 })

mock.module('../../lib/memory/scope', () => ({
  getOrCreatePersonalScope: async (userId: string) => `scope-${userId}`,
  scopeObjectKey: (scopeId: string) => `scopes/${scopeId}/memory.sqlite`,
}))

mock.module('../../utils/checkpoint', () => ({
  getCheckpoint: () => sharedCp,
  NotFoundError,
}))

// Echo the top retrieved chunk instead of calling a model, so assertions stay
// deterministic while still proving the context handed to the LLM is correct.
mock.module('../../lib/memory/answer', () => ({
  generateAnswer: async ({ context }: { context: string }) => {
    const first = context.split('\n\n')[0] ?? ''
    return first.split('\n').slice(1).join('\n')
  },
}))

const { addScopedMemory, askScopedMemory, searchScopedMemory } = await import('~/lib/memory/scoped-service')

afterAll((done) => rm(cacheDir, { recursive: true, force: true }, () => done()))

// Each test uses a fresh userId so scopes never collide across tests.
let n = 0
const freshUser = () => `u${Date.now()}-${n++}`

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

    const ans = await askScopedMemory({ userId, question: 'dog named Rex' })
    expect(ans.answer).toContain('Rex')
    expect(ans.context).toContain('Rex')
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

  test('askScopedMemory on an empty scope returns the empty answer shape, not an error', async () => {
    const ans = await askScopedMemory({ userId: freshUser(), question: 'anything' })
    expect(ans).toEqual({ answer: null, sources: [], context: '', grounding: null })
  })

  test('searchScopedMemory on an empty scope returns no hits, not an error', async () => {
    const res = await searchScopedMemory({ userId: freshUser(), query: 'anything' })
    expect(res).toEqual({ hits: [], total_hits: 0 })
  })

  test('one user cannot retrieve another user memory (scope isolation)', async () => {
    const alice = freshUser()
    const bob = freshUser()
    await addScopedMemory({ userId: alice, title: 'Secret', text: 'Alice keeps bees.' })

    const bobView = await askScopedMemory({ userId: bob, question: 'bees' })
    expect(bobView.answer).toBeNull()
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
