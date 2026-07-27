import { getCheckpoint } from '~/utils/checkpoint'

/**
 * Local cache health for the memory layer.
 *
 * There is no longer a single global memory file to stat — memory is one
 * SQLite database per scope, hydrated on demand into Checkpoint's bounded
 * cache. The meaningful local signal is therefore the cache itself: how many
 * scopes are open, how many bytes they occupy, and whether the byte budget is
 * being exceeded because everything cached is pinned by active work.
 */
export function getMemoryCacheStats() {
  const cp = getCheckpoint()
  return {
    openScopes: cp.openCount,
    cacheBytes: cp.cacheBytes,
    cacheBudgetBytes: Number.isFinite(cp.cacheBudget) ? cp.cacheBudget : null,
    overBudget: cp.overBudget,
  }
}
