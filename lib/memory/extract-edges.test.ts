import { describe, expect, test } from 'bun:test'
import { MockLanguageModelV3 } from 'ai/test'
import { MAX_EXTRACTED_EDGES, extractEdges } from './extract-edges'

/** Long enough to clear the minimum-length gate. */
const DOC = 'The Helios cutover is owned by Marcy Wu. '.repeat(12)

type Triple = { source: string; target: string; relation: string }

// Derived from the mock rather than imported, so it tracks whichever provider
// version is installed.
type MockOptions = NonNullable<ConstructorParameters<typeof MockLanguageModelV3>[0]>
type GenerateFn = Extract<MockOptions['doGenerate'], (...args: never[]) => unknown>
type GenerateResult = Awaited<ReturnType<GenerateFn>>

// finishReason is an object in this provider spec, not a string. Get it wrong
// and generateText silently produces no output at all.
const reply = (text: string): GenerateResult => ({
  finishReason: { unified: 'stop', raw: 'stop' },
  usage: {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  },
  content: [{ type: 'text', text }],
  warnings: [],
})

/** A model that always answers with these triples. */
function modelReturning(edges: Triple[]) {
  return new MockLanguageModelV3({
    doGenerate: async () => reply(JSON.stringify({ edges })),
  })
}

function modelThatFails(err: Error) {
  return new MockLanguageModelV3({
    doGenerate: async () => {
      throw err
    },
  })
}

const run = (edges: Triple[], text = DOC) =>
  extractEdges({ title: 'Helios', text, model: modelReturning(edges) })

describe('extractEdges', () => {
  test('returns the triples the model found', async () => {
    const out = await run([{ source: 'Helios cutover', target: 'Marcy Wu', relation: 'owned by' }])
    expect(out).toEqual([{ source: 'Helios cutover', target: 'Marcy Wu', relation: 'owned by' }])
  })

  test('relations are lowercased so the graph does not split on casing', async () => {
    const out = await run([{ source: 'Helios', target: 'Marcy', relation: 'Owned By' }])
    expect(out[0]!.relation).toBe('owned by')
  })

  test('entity labels keep their casing, which the alias index folds later', async () => {
    const out = await run([{ source: 'Helios Cutover', target: 'Marcy Wu', relation: 'owned by' }])
    expect(out[0]!.source).toBe('Helios Cutover')
  })

  test('whitespace is normalised', async () => {
    const out = await run([{ source: '  Helios\n cutover ', target: 'Marcy  Wu', relation: ' owned   by ' }])
    expect(out[0]).toEqual({ source: 'Helios cutover', target: 'Marcy Wu', relation: 'owned by' })
  })

  test('a self-referential edge is dropped', async () => {
    const out = await run([
      { source: 'Helios', target: 'helios', relation: 'is' },
      { source: 'Helios', target: 'Marcy', relation: 'owned by' },
    ])
    expect(out).toHaveLength(1)
    expect(out[0]!.target).toBe('Marcy')
  })

  test('a repeated relationship is stored once', async () => {
    const out = await run([
      { source: 'Helios', target: 'Marcy Wu', relation: 'owned by' },
      { source: 'helios', target: 'marcy wu', relation: 'Owned By' },
    ])
    expect(out).toHaveLength(1)
  })

  test('the same pair with a different relation is kept', async () => {
    const out = await run([
      { source: 'Helios', target: 'Marcy', relation: 'owned by' },
      { source: 'Helios', target: 'Marcy', relation: 'reviewed by' },
    ])
    expect(out).toHaveLength(2)
  })

  test('an over-long output is trimmed, not thrown away', async () => {
    const many = Array.from({ length: MAX_EXTRACTED_EDGES + 20 }, (_, i) => ({
      source: `Thing ${i}`,
      target: 'Helios',
      relation: 'relates to',
    }))
    const out = await run(many)
    expect(out).toHaveLength(MAX_EXTRACTED_EDGES)
    expect(out[0]!.source).toBe('Thing 0')
  })

  test('one oversized label costs its own edge, not the whole document', async () => {
    const out = await run([
      { source: 'x'.repeat(500), target: 'Helios', relation: 'relates to' },
      { source: 'Helios', target: 'Marcy', relation: 'y'.repeat(200) },
      { source: 'Helios', target: 'Marcy', relation: 'owned by' },
    ])
    expect(out).toEqual([{ source: 'Helios', target: 'Marcy', relation: 'owned by' }])
  })

  test('blank fields are discarded rather than stored as empty nodes', async () => {
    const out = await run([
      { source: '   ', target: 'Marcy', relation: 'owned by' },
      { source: 'Helios', target: 'Marcy', relation: '  ' },
      { source: 'Helios', target: 'Marcy', relation: 'owned by' },
    ])
    expect(out).toEqual([{ source: 'Helios', target: 'Marcy', relation: 'owned by' }])
  })
})

describe('cost and failure behaviour', () => {
  test('a short document never reaches the model', async () => {
    let called = false
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        called = true
        throw new Error('should not be called')
      },
    })

    expect(await extractEdges({ title: 't', text: 'too short to be worth a call', model })).toEqual([])
    expect(called).toBe(false)
  })

  test('an empty document never reaches the model', async () => {
    const out = await extractEdges({ title: 't', text: '   ', model: modelThatFails(new Error('nope')) })
    expect(out).toEqual([])
  })

  test('a model failure degrades to no edges instead of failing ingestion', async () => {
    const out = await extractEdges({
      title: 't',
      text: DOC,
      model: modelThatFails(new Error('rate limited')),
    })
    expect(out).toEqual([])
  })

  test('unparseable model output degrades to no edges', async () => {
    const model = new MockLanguageModelV3({
      doGenerate: async () => reply('I could not find any relationships.'),
    })

    expect(await extractEdges({ title: 't', text: DOC, model })).toEqual([])
  })

  test('a long document is truncated before it is sent', async () => {
    let promptChars = 0
    const model = new MockLanguageModelV3({
      doGenerate: async ({ prompt }) => {
        promptChars = JSON.stringify(prompt).length
        return reply('{"edges":[]}')
      },
    })

    await extractEdges({ title: 't', text: 'a'.repeat(500_000), model })
    expect(promptChars).toBeLessThan(20_000)
  })
})
