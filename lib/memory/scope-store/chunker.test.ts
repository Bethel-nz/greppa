import { describe, expect, test } from 'bun:test'
import { CHUNK_OVERLAP_CHARS, CHUNK_TARGET_CHARS, chunkText } from './chunker'

describe('chunkText', () => {
  test('returns a short note as a single chunk', () => {
    expect(chunkText('a short note')).toEqual(['a short note'])
  })

  test('returns nothing for empty or whitespace-only input', () => {
    expect(chunkText('')).toEqual([])
    expect(chunkText('   \n\t ')).toEqual([])
  })

  test('splits long text into multiple chunks near the target size', () => {
    const para = 'x'.repeat(400)
    const chunks = chunkText([para, para, para, para, para].join('\n\n'))
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(CHUNK_TARGET_CHARS + CHUNK_OVERLAP_CHARS + 50)
  })

  test('prefers paragraph boundaries', () => {
    const chunks = chunkText(['alpha '.repeat(120), 'beta '.repeat(120)].join('\n\n'))
    expect(chunks[0]).toContain('alpha')
    expect(chunks[0]).not.toContain('beta')
  })

  test('overlaps consecutive chunks so context is not cut mid-idea', () => {
    const sentences = Array.from({ length: 60 }, (_, i) => `Sentence number ${i} carries meaning.`).join(' ')
    const chunks = chunkText(sentences, { targetChars: 300, overlapChars: 80 })
    expect(chunks.length).toBeGreaterThan(2)
    const tail = chunks[0]!.slice(-40)
    expect(chunks[1]!.includes(tail.slice(0, 20))).toBe(true)
  })

  test('hard-splits a single unbroken run with no paragraph or sentence breaks', () => {
    const chunks = chunkText('y'.repeat(5000), { targetChars: 1000, overlapChars: 0 })
    expect(chunks.length).toBe(5)
    expect(chunks.every((c) => c.length <= 1000)).toBe(true)
  })

  test('never emits an empty chunk', () => {
    const chunks = chunkText('a\n\n\n\nb\n\n\n\nc')
    expect(chunks.every((c) => c.trim().length > 0)).toBe(true)
  })
})
