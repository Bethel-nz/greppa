/**
 * Temporal weighting for retrieval — "forgetting" in the memory-layer sense.
 *
 * Greppa records conversation, so a scope accumulates monotonically. Without a
 * time term, a passing remark from a year ago competes on equal footing with
 * something said this morning, and the store gets steadily noisier as it grows.
 *
 * Three deliberate choices:
 *
 * 1. Decay runs from the LAST TOUCH, not from creation. Decaying from
 *    created_at is recency bias; decaying from last_accessed is forgetting — a
 *    memory that keeps being recalled stays strong, one that never surfaces
 *    fades. That difference is the whole point.
 *
 * 2. Forgetting DOWN-RANKS, it never deletes. The product promise is memory;
 *    silently destroying data to satisfy a heuristic would be a bad trade. The
 *    floor below guarantees an ancient memory keeps a fraction of its weight
 *    and stays reachable by a sufficiently specific query.
 *
 * 3. It is OFF by default. A half-life is a product decision that needs tuning
 *    against real usage, and shipping an untuned decay silently degrades
 *    retrieval — the exact failure class this codebase has learned to distrust.
 */

export const DEFAULT_HALF_LIFE_DAYS = 30
export const DEFAULT_FLOOR = 0.25

const DAY_MS = 86_400_000

export type DecayConfig = {
  enabled: boolean
  /** Days after which an untouched memory's temporal weight halves. */
  halfLifeDays: number
  /**
   * Minimum multiplier an infinitely old memory retains, in [0, 1).
   * A floor of 0 means old memories can be ranked to irrelevance; 0.25 means
   * they keep a quarter of their weight and remain findable.
   */
  floor: number
}

export const DECAY_OFF: DecayConfig = {
  enabled: false,
  halfLifeDays: DEFAULT_HALF_LIFE_DAYS,
  floor: DEFAULT_FLOOR,
}

function envNumber(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]
  if (!raw) return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/**
 * Read decay settings from the environment.
 *
 *   MEMORY_DECAY_ENABLED=1
 *   MEMORY_DECAY_HALF_LIFE_DAYS=30
 *   MEMORY_DECAY_FLOOR=0.25
 */
export function decayConfigFromEnv(env: NodeJS.ProcessEnv = process.env): DecayConfig {
  const floorRaw = Number(env.MEMORY_DECAY_FLOOR)
  return {
    enabled: env.MEMORY_DECAY_ENABLED === '1',
    halfLifeDays: envNumber(env, 'MEMORY_DECAY_HALF_LIFE_DAYS', DEFAULT_HALF_LIFE_DAYS),
    floor: Number.isFinite(floorRaw) && floorRaw >= 0 && floorRaw < 1 ? floorRaw : DEFAULT_FLOOR,
  }
}

/**
 * Temporal weight in [floor, 1].
 *
 * `0.5 ^ (age / halfLife)` — at one half-life the raw decay is 0.5, at two it
 * is 0.25, and so on, asymptotically approaching the floor rather than zero.
 * Future timestamps (clock skew) clamp to a full-strength 1.
 */
export function temporalWeight(lastTouchedMs: number, nowMs: number, cfg: DecayConfig): number {
  if (!cfg.enabled) return 1
  const ageMs = nowMs - lastTouchedMs
  if (ageMs <= 0) return 1
  const halfLives = ageMs / (cfg.halfLifeDays * DAY_MS)
  const raw = Math.pow(0.5, halfLives)
  return cfg.floor + (1 - cfg.floor) * raw
}

/**
 * Fold temporal weight into a fused relevance score.
 *
 * Multiplicative on purpose: RRF scores are already a ranking, and scaling
 * preserves their relative order within a single age cohort while letting a
 * fresher memory overtake a marginally more relevant stale one. Because the
 * weight is bounded below by `floor`, no amount of age can push a strong match
 * below a weak one by more than the floor ratio.
 */
export function applyDecay(rrfScore: number, lastTouchedMs: number, nowMs: number, cfg: DecayConfig): number {
  return rrfScore * temporalWeight(lastTouchedMs, nowMs, cfg)
}
