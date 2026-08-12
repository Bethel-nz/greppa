import { getCheckpoint } from '~/utils/checkpoint'

export function getMemoryCacheStats() {
  const cp = getCheckpoint()
  return {
    openScopes: cp.openCount,
    cacheBytes: cp.cacheBytes,
    cacheBudgetBytes: Number.isFinite(cp.cacheBudget) ? cp.cacheBudget : null,
    overBudget: cp.overBudget,
  }
}
