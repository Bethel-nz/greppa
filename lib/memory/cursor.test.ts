import { describe, expect, test } from 'bun:test'
import {
  clampPageLimit,
  decodeCursor,
  encodeCursor,
  MAX_PAGE_LIMIT,
  paginate,
  type PageCursor,
} from './cursor'

describe('cursor encoding', () => {
  test('round-trips a key', () => {
    const key: PageCursor = { createdAt: 1_755_000_000_000, id: 'doc_abc' }
    expect(decodeCursor(encodeCursor(key))).toEqual(key)
  })

  test('survives ids that contain the separator', () => {
    const key: PageCursor = { createdAt: 42, id: 'a:b:c' }
    expect(decodeCursor(encodeCursor(key))).toEqual(key)
  })

  test('is opaque (not the raw key)', () => {
    expect(encodeCursor({ createdAt: 42, id: 'doc' })).not.toContain('doc')
  })

  test.each([
    ['null', null],
    ['undefined', undefined],
    ['empty', ''],
    ['no separator', Buffer.from('12345', 'utf8').toString('base64url')],
    ['non-numeric time', Buffer.from('abc:doc', 'utf8').toString('base64url')],
    ['empty id', Buffer.from('42:', 'utf8').toString('base64url')],
  ])('decodes %s to null so a bad cursor just starts from the top', (_label, raw) => {
    expect(decodeCursor(raw as string | null | undefined)).toBeNull()
  })
})

describe('clampPageLimit', () => {
  test('defaults when absent or not a number', () => {
    expect(clampPageLimit(undefined)).toBe(50)
    expect(clampPageLimit(Number.NaN, 25)).toBe(25)
  })
  test('floors, and holds the [1, MAX] range', () => {
    expect(clampPageLimit(0)).toBe(1)
    expect(clampPageLimit(-5)).toBe(1)
    expect(clampPageLimit(10.9)).toBe(10)
    expect(clampPageLimit(1000)).toBe(MAX_PAGE_LIMIT)
  })
})

describe('paginate', () => {
  const keyOf = (r: { at: number; id: string }): PageCursor => ({ createdAt: r.at, id: r.id })

  test('one extra row means another page, cursor points at the last kept row', () => {
    const rows = [
      { at: 3, id: 'c' },
      { at: 2, id: 'b' },
      { at: 1, id: 'a' }, // the limit+1 sentinel
    ]
    const { items, nextCursor } = paginate(rows, 2, keyOf)
    expect(items).toEqual([
      { at: 3, id: 'c' },
      { at: 2, id: 'b' },
    ])
    expect(decodeCursor(nextCursor)).toEqual({ createdAt: 2, id: 'b' })
  })

  test('a short page is the last page', () => {
    const rows = [{ at: 3, id: 'c' }]
    const { items, nextCursor } = paginate(rows, 2, keyOf)
    expect(items).toEqual(rows)
    expect(nextCursor).toBeNull()
  })

  test('exactly a full page with no extra is still the last page', () => {
    const rows = [
      { at: 3, id: 'c' },
      { at: 2, id: 'b' },
    ]
    expect(paginate(rows, 2, keyOf).nextCursor).toBeNull()
  })

  test('an empty result has no next cursor', () => {
    expect(paginate([], 2, keyOf)).toEqual({ items: [], nextCursor: null })
  })
})
