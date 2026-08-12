
export const DEFAULT_HALF_LIFE_DAYS = 30
export const DEFAULT_FLOOR = 0.25

const DAY_MS = 86_400_000

export type DecayConfig = {
  enabled: boolean
  halfLifeDays: number
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

export function decayConfigFromEnv(env: NodeJS.ProcessEnv = process.env): DecayConfig {
  const floorRaw = Number(env.MEMORY_DECAY_FLOOR)
  return {
    enabled: env.MEMORY_DECAY_ENABLED === '1',
    halfLifeDays: envNumber(env, 'MEMORY_DECAY_HALF_LIFE_DAYS', DEFAULT_HALF_LIFE_DAYS),
    floor: Number.isFinite(floorRaw) && floorRaw >= 0 && floorRaw < 1 ? floorRaw : DEFAULT_FLOOR,
  }
}

export function temporalWeight(lastTouchedMs: number, nowMs: number, cfg: DecayConfig): number {
  if (!cfg.enabled) return 1
  const ageMs = nowMs - lastTouchedMs
  if (ageMs <= 0) return 1
  const halfLives = ageMs / (cfg.halfLifeDays * DAY_MS)
  const raw = Math.pow(0.5, halfLives)
  return cfg.floor + (1 - cfg.floor) * raw
}

export function applyDecay(rrfScore: number, lastTouchedMs: number, nowMs: number, cfg: DecayConfig): number {
  return rrfScore * temporalWeight(lastTouchedMs, nowMs, cfg)
}
