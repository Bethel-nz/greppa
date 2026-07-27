import { describe, expect, test } from 'bun:test'
import { RRF_K, reciprocalRankFusion } from './fusion'

describe('reciprocalRankFusion', () => {
  test('ranks an item appearing high in both lists above one appearing in only one', () => {
    const fused = reciprocalRankFusion([[1, 2, 3], [1, 4, 5]])
    expect(fused[0]!.id).toBe(1)
  })

  test('includes items unique to a single list', () => {
    const ids = reciprocalRankFusion([[1, 2], [3]]).map((r) => r.id)
    expect(ids.sort()).toEqual([1, 2, 3])
  })

  test('scores by summed reciprocal rank', () => {
    const fused = reciprocalRankFusion([[7], [7]])
    expect(fused[0]!.score).toBeCloseTo(2 / (RRF_K + 1), 10)
  })

  test('respects the limit', () => {
    expect(reciprocalRankFusion([[1, 2, 3, 4, 5]], { limit: 2 }).length).toBe(2)
  })

  test('handles empty lists', () => {
    expect(reciprocalRankFusion([[], []])).toEqual([])
  })

  test('is order-stable for equal scores', () => {
    const a = reciprocalRankFusion([[1, 2], [1, 2]]).map((r) => r.id)
    const b = reciprocalRankFusion([[1, 2], [1, 2]]).map((r) => r.id)
    expect(a).toEqual(b)
  })
})
