import { describe, expect, test } from 'bun:test'
import { createDeterministicProvider } from './deterministic'
import { getEmbeddingProvider, resetEmbeddingProvider } from './index'
import type { EmbeddingProvider } from './provider'

const norm = (v: Float32Array) => Math.sqrt(v.reduce((a, x) => a + x * x, 0))

export function assertProviderContract(name: string, make: () => EmbeddingProvider): void {
  describe(`provider contract: ${name}`, () => {
    test('declares a non-empty id, positive dimension and batch size', () => {
      const p = make()
      expect(p.id.length).toBeGreaterThan(0)
      expect(p.dimension).toBeGreaterThan(0)
      expect(p.maxBatchSize).toBeGreaterThan(0)
    })

    test('returns one vector per input at exactly the declared dimension', async () => {
      const p = make()
      const out = await p.embed(['first input', 'second input'], 'document')
      expect(out.length).toBe(2)
      for (const v of out) expect(v.length).toBe(p.dimension)
    })

    test('returns L2-normalized vectors', async () => {
      const p = make()
      for (const v of await p.embed(['normalization check'], 'document')) {
        expect(norm(v)).toBeCloseTo(1, 4)
      }
    })

    test('accepts both document and query kinds', async () => {
      const p = make()
      expect((await p.embed(['x'], 'document'))[0]!.length).toBe(p.dimension)
      expect((await p.embed(['x'], 'query'))[0]!.length).toBe(p.dimension)
    })

    test('returns an empty array for empty input', async () => {
      expect(await make().embed([], 'document')).toEqual([])
    })
  })
}

assertProviderContract('deterministic', () => createDeterministicProvider(64))

describe('provider registry', () => {
  test('defaults to the deterministic provider', () => {
    resetEmbeddingProvider()
    delete process.env.EMBEDDING_PROVIDER
    expect(getEmbeddingProvider().id).toStartWith('deterministic@')
    resetEmbeddingProvider()
  })

  test('honours EMBEDDING_DIM', () => {
    resetEmbeddingProvider()
    process.env.EMBEDDING_PROVIDER = 'deterministic'
    process.env.EMBEDDING_DIM = '256'
    expect(getEmbeddingProvider().dimension).toBe(256)
    delete process.env.EMBEDDING_DIM
    delete process.env.EMBEDDING_PROVIDER
    resetEmbeddingProvider()
  })

  test('rejects a non-numeric EMBEDDING_DIM', () => {
    resetEmbeddingProvider()
    process.env.EMBEDDING_DIM = 'lots'
    expect(() => getEmbeddingProvider()).toThrow(/EMBEDDING_DIM must be a positive integer/)
    delete process.env.EMBEDDING_DIM
    resetEmbeddingProvider()
  })

  test('rejects an unknown provider', () => {
    resetEmbeddingProvider()
    process.env.EMBEDDING_PROVIDER = 'nope'
    expect(() => getEmbeddingProvider()).toThrow(/unknown EMBEDDING_PROVIDER/)
    delete process.env.EMBEDDING_PROVIDER
    resetEmbeddingProvider()
  })

  test('requires a key for a network provider', () => {
    resetEmbeddingProvider()
    process.env.EMBEDDING_PROVIDER = 'google'
    const saved = process.env.GOOGLE_API_KEY
    delete process.env.GOOGLE_API_KEY
    expect(() => getEmbeddingProvider()).toThrow(/GOOGLE_API_KEY/)
    if (saved) process.env.GOOGLE_API_KEY = saved
    delete process.env.EMBEDDING_PROVIDER
    resetEmbeddingProvider()
  })

  test('openai-compatible requires base url, model and dimension', () => {
    resetEmbeddingProvider()
    process.env.EMBEDDING_PROVIDER = 'openai-compatible'
    process.env.EMBEDDING_API_KEY = 'k'
    expect(() => getEmbeddingProvider()).toThrow(/EMBEDDING_BASE_URL/)
    delete process.env.EMBEDDING_API_KEY
    delete process.env.EMBEDDING_PROVIDER
    resetEmbeddingProvider()
  })
})
