import { afterAll, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rm, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Checkpoint } from '~/utils/checkpoint/checkpoint'
import { MemoryStorage } from '~/utils/checkpoint/storage'
import { NotFoundError } from '~/utils/checkpoint/errors'

// scoped-service has three hard dependencies we replace at the seam:
//   1. ./scope      -> map userId to a stable scopeId without Postgres
//   2. ~/utils/checkpoint -> a real Checkpoint over MemoryStorage (no R2)
//   3. @memvid/sdk  -> a fake that persists records to the local file so the
//      full write -> seal -> upload -> download -> read round-trip is real.

const cacheDir = mkdtempSync(join(tmpdir(), 'scoped-cp-'))
const sharedCp = new Checkpoint({ storage: new MemoryStorage(), cacheDir, maxOpen: 8, idleMs: 60_000 })

mock.module('../../lib/memory/scope', () => ({
  getOrCreatePersonalScope: async (userId: string) => `scope-${userId}`,
  scopeObjectKey: (scopeId: string) => `scopes/${scopeId}/memory.mv2`,
}))

mock.module('../../utils/checkpoint', () => ({
  getCheckpoint: () => sharedCp,
  NotFoundError,
}))

// Persistent fake Memvid: records live in the .mv2 file as JSON so reopening a
// file (the read path's copy-on-read snapshot) sees what was sealed.
type Rec = { id: string; title: string; label: string; text: string; metadata: any }

function loadRecords(path: string): Rec[] {
  if (!existsSync(path)) return []
  const raw = readFileSync(path, 'utf8')
  return raw ? (JSON.parse(raw) as Rec[]) : []
}

class FakeMem {
  constructor(private path: string, private records: Rec[]) {}
  async put(rec: Omit<Rec, 'id'>) {
    const id = `frame_${this.records.length + 1}`
    this.records.push({ id, ...rec })
    return id
  }
  async seal() {
    writeFileSync(this.path, JSON.stringify(this.records))
  }
  private match(query: string, k: number) {
    const q = query.toLowerCase()
    return this.records
      .filter((r) => `${r.title} ${r.text}`.toLowerCase().includes(q))
      .slice(0, k)
      .map((r) => ({ title: r.title, snippet: r.text, score: 1 }))
  }
  async find(query: string, opts?: { k?: number }) {
    const hits = this.match(query, opts?.k ?? 8)
    return { hits, total_hits: hits.length }
  }
  async ask(question: string, opts?: { k?: number }) {
    const hits = this.match(question, opts?.k ?? 10)
    if (!hits.length) return { answer: null, sources: [], context: '', grounding: null }
    return {
      answer: hits[0].snippet,
      sources: hits,
      context: hits.map((h) => h.snippet).join('\n'),
      grounding: { ok: true },
    }
  }
}

mock.module('@memvid/sdk', () => ({
  create: async (path: string) => new FakeMem(path, []),
  use: async (_kind: string, path: string) => new FakeMem(path, loadRecords(path)),
  open: async (path: string) => new FakeMem(path, loadRecords(path)),
}))

const { addScopedMemory, askScopedMemory, searchScopedMemory } = await import('~/lib/memory/scoped-service')

afterAll((done) => rm(cacheDir, { recursive: true, force: true }, () => done()))

// Each test uses a fresh userId so scopes never collide across tests.
let n = 0
const freshUser = () => `u${Date.now()}-${n++}`

describe('scoped-service', () => {
  test('addScopedMemory creates the scope file and returns an indexed frame', async () => {
    const userId = freshUser()
    const res = await addScopedMemory({ userId, title: 'Pets', text: 'I have a dog named Rex.' })

    expect(res.scopeId).toBe(`scope-${userId}`)
    expect(res.frameId).toBe('frame_1')
    expect(res.status).toBe('indexed')
  })

  test('a written memory round-trips through storage and is retrievable via ask', async () => {
    const userId = freshUser()
    await addScopedMemory({ userId, title: 'Pets', text: 'I have a dog named Rex.' })

    const ans = await askScopedMemory({ userId, question: 'dog' })
    expect(ans.answer).toBe('I have a dog named Rex.')
    expect(ans.sources).toHaveLength(1)
    expect(ans.context).toContain('Rex')
  })

  test('a second memory appends (use path), it does not overwrite the first', async () => {
    const userId = freshUser()
    const first = await addScopedMemory({ userId, title: 'Pets', text: 'I have a dog named Rex.' })
    const second = await addScopedMemory({ userId, title: 'Food', text: 'I love jollof rice.' })

    expect(first.frameId).toBe('frame_1')
    expect(second.frameId).toBe('frame_2')

    const dog = await askScopedMemory({ userId, question: 'dog' })
    const food = await askScopedMemory({ userId, question: 'jollof' })
    expect(dog.answer).toBe('I have a dog named Rex.')
    expect(food.answer).toBe('I love jollof rice.')
  })

  test('askScopedMemory on an empty scope returns the empty answer shape, not an error', async () => {
    const userId = freshUser()
    const ans = await askScopedMemory({ userId, question: 'anything' })
    expect(ans).toEqual({ answer: null, sources: [], context: '', grounding: null })
  })

  test('searchScopedMemory on an empty scope returns no hits, not an error', async () => {
    const userId = freshUser()
    const res = await searchScopedMemory({ userId, query: 'anything' })
    expect(res).toEqual({ hits: [], total_hits: 0 })
  })

  test('one user cannot retrieve another user memory (scope isolation)', async () => {
    const alice = freshUser()
    const bob = freshUser()
    await addScopedMemory({ userId: alice, title: 'Secret', text: 'Alice keeps bees.' })

    const bobView = await askScopedMemory({ userId: bob, question: 'bees' })
    expect(bobView.answer).toBeNull()
  })
})
