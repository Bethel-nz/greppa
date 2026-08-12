export const RRF_K = 60

export type FusedHit = { id: number; score: number }

export function reciprocalRankFusion(
  lists: number[][],
  opts: { k?: number; limit?: number; weights?: number[] } = {},
): FusedHit[] {
  const k = opts.k ?? RRF_K
  const scores = new Map<number, number>()
  const firstSeen = new Map<number, number>()
  let order = 0

  for (let i = 0; i < lists.length; i++) {
    const list = lists[i]!
    const weight = opts.weights?.[i] ?? 1
    for (let rank = 0; rank < list.length; rank++) {
      const id = list[rank]!
      scores.set(id, (scores.get(id) ?? 0) + weight / (k + rank + 1))
      if (!firstSeen.has(id)) firstSeen.set(id, order++)
    }
  }

  const fused = [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score || firstSeen.get(a.id)! - firstSeen.get(b.id)!)

  return opts.limit ? fused.slice(0, opts.limit) : fused
}
