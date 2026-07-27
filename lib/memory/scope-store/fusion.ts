/** Standard RRF damping constant; 60 is the value from the original paper. */
export const RRF_K = 60

export type FusedHit = { id: number; score: number }

/**
 * Fuse ranked id lists by reciprocal rank. Vector distance and BM25 scores are
 * not on comparable scales, so they are combined by rank rather than by value.
 */
export function reciprocalRankFusion(
  lists: number[][],
  opts: { k?: number; limit?: number } = {},
): FusedHit[] {
  const k = opts.k ?? RRF_K
  const scores = new Map<number, number>()
  const firstSeen = new Map<number, number>()
  let order = 0

  for (const list of lists) {
    for (let rank = 0; rank < list.length; rank++) {
      const id = list[rank]!
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank + 1))
      if (!firstSeen.has(id)) firstSeen.set(id, order++)
    }
  }

  const fused = [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score || firstSeen.get(a.id)! - firstSeen.get(b.id)!)

  return opts.limit ? fused.slice(0, opts.limit) : fused
}
