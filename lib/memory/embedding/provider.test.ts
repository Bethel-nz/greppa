import { describe, expect, test } from 'bun:test'
import { l2normalize } from './provider'
import { createDeterministicProvider } from './deterministic'

const norm = (v: Float32Array) => Math.sqrt(v.reduce((a, x) => a + x * x, 0))

describe('l2normalize', () => {
  test('scales a vector to unit length', () => {
    const out = l2normalize(new Float32Array([3, 4]))
    expect(norm(out)).toBeCloseTo(1, 6)
    expect(out[0]).toBeCloseTo(0.6, 6)
  })

  test('leaves an all-zero vector alone instead of dividing by zero', () => {
    const out = l2normalize(new Float32Array([0, 0, 0]))
    expect([...out]).toEqual([0, 0, 0])
  })
})

describe('deterministic provider', () => {
  test('declares its identity and dimension', () => {
    const p = createDeterministicProvider(64)
    expect(p.dimension).toBe(64)
    expect(p.id).toBe('deterministic@64')
    expect(p.maxBatchSize).toBeGreaterThan(0)
  })

  test('returns one unit vector per input, of the declared dimension', async () => {
    const p = createDeterministicProvider(64)
    const out = await p.embed(['alpha', 'beta'], 'document')
    expect(out.length).toBe(2)
    expect(out[0]!.length).toBe(64)
    expect(norm(out[0]!)).toBeCloseTo(1, 5)
  })

  test('is deterministic: same text yields the same vector', async () => {
    const p = createDeterministicProvider(64)
    const [a] = await p.embed(['same text'], 'document')
    const [b] = await p.embed(['same text'], 'document')
    expect([...a!]).toEqual([...b!])
  })

  test('similar text is closer than unrelated text', async () => {
    const p = createDeterministicProvider(128)
    const [q, near, far] = await p.embed(
      ['cat pet animal mammal', 'pet animal mammal cat', 'invoice quarterly revenue fiscal'],
      'document',
    )
    const dot = (a: Float32Array, b: Float32Array) => a.reduce((s, x, i) => s + x * b[i]!, 0)
    expect(dot(q!, near!)).toBeGreaterThan(dot(q!, far!))
  })
})
