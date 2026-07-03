import { beforeEach, describe, expect, mock, test } from 'bun:test'

// Redis mock that honours SET ... NX (the agent's `remember` dedup depends on it,
// and the shared _mocks redis ignores nx). Keyed store reset between tests.
const store = new Map<string, string>()
const redisMock = {
  set: async (key: string, value: string, opts?: { nx?: boolean }) => {
    if (opts?.nx && store.has(key)) return null
    store.set(key, value)
    return 'OK'
  },
}
mock.module('../../lib/redis', () => ({ redis: redisMock, getRedis: () => redisMock }))

// Spy on the memory service so we assert the tool's effects, not Memvid behaviour.
const calls = { add: [] as any[], ask: [] as any[] }
let askResult: any = { answer: null, sources: [], context: '', grounding: null }
mock.module('../../lib/memory/scoped-service', () => ({
  addScopedMemory: async (input: any) => {
    calls.add.push(input)
    return { scopeId: `scope-${input.userId}`, frameId: 'frame_1', status: 'indexed' }
  },
  askScopedMemory: async (input: any) => {
    calls.ask.push(input)
    return askResult
  },
}))

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
  store.clear()
  calls.add.length = 0
  calls.ask.length = 0
  askResult = { answer: null, sources: [], context: '', grounding: null }
})

describe('chat agent tools', () => {
  describe('search_knowledge', () => {
    test('queries the user scope, maps sources, and emits search cues', async () => {
      askResult = {
        answer: 'Rex',
        sources: [{ title: 'Pets', snippet: 'I have a dog named Rex.', score: 0.9 }],
        context: 'I have a dog named Rex.',
        grounding: { ok: true },
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

      const out = await tools.remember.execute!({ title: 'Pet', text: 'Has a dog named Rex.' }, {} as any)

      expect(out).toBe('Saved to your memory.')
      expect(calls.add).toEqual([
        { userId: 'user-1', title: 'Pet', text: 'Has a dog named Rex.', sourceType: 'chat' },
      ])
    })

    test('is idempotent: a replay of the same fact does not double-write', async () => {
      const { tools } = makeHarness()
      const args = { title: 'Pet', text: 'Has a dog named Rex.' }

      const first = await tools.remember.execute!(args, {} as any)
      const second = await tools.remember.execute!(args, {} as any)

      expect(first).toBe('Saved to your memory.')
      expect(second).toBe('Already saved (duplicate).')
      expect(calls.add).toHaveLength(1)
    })

    test('a different fact is written even after a prior remember', async () => {
      const { tools } = makeHarness()

      await tools.remember.execute!({ title: 'A', text: 'one' }, {} as any)
      await tools.remember.execute!({ title: 'B', text: 'two' }, {} as any)

      expect(calls.add).toHaveLength(2)
    })
  })
})
