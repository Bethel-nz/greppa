import { Checkpoint } from './checkpoint'
import { R2Storage } from '../r2'

let _checkpoint: Checkpoint | null = null

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

export function getCheckpoint(): Checkpoint {
  if (_checkpoint) return _checkpoint
  _checkpoint = new Checkpoint({
    storage: R2Storage.fromEnv(),
    cacheDir: process.env.CHECKPOINT_CACHE_DIR ?? './.greppa/checkpoint',
    maxOpen: envInt('CHECKPOINT_MAX_OPEN', 64),
    idleMs: envInt('CHECKPOINT_IDLE_MS', 300_000),
  })
  if (process.env.NODE_ENV === 'production') _checkpoint.startEviction()
  return _checkpoint
}
