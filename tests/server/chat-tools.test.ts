import './_mocks'
import { interceptScopedService } from './_memory-mocks'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { clearRedisState } from './_mocks'

const calls = { add: [] as any[], ask: [] as any[] }
let askResult: any = { sources: [], context: '', edges: [] }

const overrides = {
  addScopedMemory: async (input: any) => {
    calls.add.push(input)
    return { scopeId: `scope-${input.userId}`, documentId: 'doc_1', status: 'indexed' as const }
  },
  retrieveScopedContext: async (input: any) => {
    calls.ask.push(input)
    return askResult
  },
  listScopedMemoryEdges: async () => [],
} as any

const { buildTools } = await import('~/lib/chat/tools')

type EmitRecord = { type: string; data: any }

function makeHarness() {
  const emitted: EmitRecord[] = []
  let captured: any[] = []
  const emit = (async (type: string, data: unknown) => {
    emitted.push({ type, data })
    return { id: 'x', seq: emitted.length, type, data }
  }) as any
  const tools = buildTools({ userId: 'user-1', emit, onSources: (s) => (captured = s) })
  return { tools, emitted, sources: () => captured }
}

beforeEach(() => {
  clearRedisState()
  calls.add.length = 0
  calls.ask.length = 0
  askResult = { sources: [], context: '', edges: [] }
  interceptScopedService(overrides)
})

afterEach(() => interceptScopedService(null))

describe('chat agent tools', () => {
  describe('search_knowledge', () => {
    test('queries the user scope, maps sources, and emits search cues', async () => {
      askResult = {
        sources: [{ title: 'Pets', snippet: 'I have a dog named Rex.', score: 0.9 }],
        context: 'I have a dog named Rex.',
        edges: [],
      }
      const { tools, emitted, sources } = makeHarness()

      const out = await tools.search_knowledge.execute!({ query: 'dog' }, {} as any)

      expect(calls.ask).toEqual([{ userId: 'user-1', question: 'dog', limit: 5 }])
      expect(sources()).toEqual([{ title: 'Pets', snippet: 'I have a dog named Rex.', score: 0.9 }])
      expect(out).toContain('Rex')

      const types = emitted.map((e) => e.type)
      expect(types).toContain('sources')
      const cues = emitted.filter((e) => e.type === 'cue').map((e) => e.data.status)
      expect(cues).toEqual(['searching_knowledge', 'reading_sources'])
    })

    test('passes document identity through so a citation is traceable', async () => {
      askResult = {
        sources: [
          {
            title: 'Q3 revenue report',
            snippet: 'Revenue reached 4.2 million.',
            score: 0.8,
            documentId: 'doc-123',
            sourceType: 'document',
            sourceUrl: 'q3-report.pdf',
          },
        ],
        context: 'Revenue reached 4.2 million.',
        edges: [],
      }
      const { tools, emitted, sources } = makeHarness()

      await tools.search_knowledge.execute!({ query: 'revenue' }, {} as any)

      expect(sources()[0]).toEqual({
        title: 'Q3 revenue report',
        snippet: 'Revenue reached 4.2 million.',
        score: 0.8,
        documentId: 'doc-123',
        sourceType: 'document',
        sourceUrl: 'q3-report.pdf',
      })
      const event = emitted.find((e) => e.type === 'sources')!
      expect(event.data[0].documentId).toBe('doc-123')
    })

    test('an empty result yields no sources and a safe fallback string', async () => {
      const { tools, emitted, sources } = makeHarness()

      const out = await tools.search_knowledge.execute!({ query: 'anything' }, {} as any)

      expect(sources()).toEqual([])
      expect(typeof out).toBe('string')
      const readingCue = emitted.find((e) => e.type === 'cue' && e.data.status === 'reading_sources')
      expect(readingCue!.data.count).toBe(0)
    })
  })

  describe('remember', () => {
    test('writes a durable fact to the user scope', async () => {
      const { tools } = makeHarness()

      const out = await tools.remember.execute!({ title: 'Pet', text: 'Has a dog named Rex.', edges: [] }, {} as any)

      expect(out).toBe('Saved. It carries no relationships, so it will only be found by its wording.')
      expect(calls.add).toEqual([
        { userId: 'user-1', title: 'Pet', text: 'Has a dog named Rex.', sourceType: 'fact', folderId: undefined, edges: [] },
      ])
    })

    test('is idempotent: a replay of the same fact does not double-write', async () => {
      const { tools } = makeHarness()
      const args = { title: 'Pet', text: 'Has a dog named Rex.', edges: [] }

      const first = await tools.remember.execute!(args, {} as any)
      const second = await tools.remember.execute!(args, {} as any)

      expect(first).toBe('Saved. It carries no relationships, so it will only be found by its wording.')
      expect(second).toBe('Already saved (duplicate). Do not save it again.')
      expect(calls.add).toHaveLength(1)
    })

    test('a different fact is written even after a prior remember', async () => {
      const { tools } = makeHarness()

      await tools.remember.execute!({ title: 'A', text: 'one', edges: [] }, {} as any)
      await tools.remember.execute!({ title: 'B', text: 'two', edges: [] }, {} as any)

      expect(calls.add).toHaveLength(2)
    })
  })
})
