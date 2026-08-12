import { Checkpoint } from './checkpoint'
import { getStorage } from '~/lib/storage'

let _checkpoint: Checkpoint | null = null

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

const UNITS: Record<string, number> = {
  b: 1,
  kb: 1024,
  mb: 1024 ** 2,
  gb: 1024 ** 3,
  tb: 1024 ** 4,
}

function envBytes(name: string, fallback: number): number {
  const raw = process.env[name]?.trim().toLowerCase()
  if (!raw) return fallback
  const m = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb|tb)?$/.exec(raw)
  if (!m) return fallback
  const n = Number(m[1]) * (UNITS[m[2] ?? 'b'] ?? 1)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

export function getCheckpoint(): Checkpoint {
  if (_checkpoint) return _checkpoint
  _checkpoint = new Checkpoint({
    storage: getStorage(),
    cacheDir: process.env.CHECKPOINT_CACHE_DIR ?? './.greppa/checkpoint',
    maxOpen: envInt('CHECKPOINT_MAX_OPEN', 64),
    maxCacheBytes: envBytes('CHECKPOINT_MAX_CACHE_BYTES', 2 * 1024 ** 3),
    idleMs: envInt('CHECKPOINT_IDLE_MS', 300_000),
  })
  if (process.env.NODE_ENV === 'production') _checkpoint.startEviction()

  if (process.env.CHECKPOINT_SWEEP_ON_BOOT === '1') {
    void _checkpoint
      .sweepOrphans()
      .then(({ removed, bytes }) => {
        if (removed > 0) {
          console.info(`[checkpoint] swept ${removed} orphaned generation(s), reclaimed ${bytes} bytes`)
        }
      })
      .catch((err) => console.warn('[checkpoint] orphan sweep failed:', err))
  }

  return _checkpoint
}
