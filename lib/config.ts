export type GreppaConfig = {
  sessionSecret: string
  deployerKey: string | undefined
  sessionTtlMs: number
  messageTtlMs: number
  allowPublicDelete: boolean
  allowPublicStats: boolean
  protocolVersion: string
  rateLimit: {
    ip: { windowMs: number; limit: number }
    session: { windowMs: number; limit: number }
  }
}

const DAY_MS = 1000 * 60 * 60 * 24

function num(name: string, fallback: number): number {
  const v = process.env[name]
  if (v === undefined) return fallback
  const n = Number(v)
  if (!Number.isFinite(n)) throw new Error(`${name} must be numeric`)
  return n
}

function bool(name: string): boolean {
  const v = process.env[name]
  return v === 'true' || v === '1'
}

let cached: GreppaConfig | null = null

export function loadGreppaConfig(): GreppaConfig {
  if (cached) return cached
  const secret = process.env.GREPPA_SESSION_SECRET
  if (!secret || secret.length < 32) {
    throw new Error('GREPPA_SESSION_SECRET is required and must be at least 32 chars')
  }
  cached = {
    sessionSecret: secret,
    deployerKey: process.env.GREPPA_DEPLOYER_KEY || undefined,
    sessionTtlMs: num('GREPPA_SESSION_TTL_MS', 2 * DAY_MS),
    messageTtlMs: num('GREPPA_MESSAGE_TTL_MS', 60 * 60 * 1000),
    allowPublicDelete: bool('GREPPA_ALLOW_PUBLIC_DELETE'),
    allowPublicStats: bool('GREPPA_ALLOW_PUBLIC_STATS'),
    protocolVersion: process.env.GREPPA_PROTOCOL_VERSION || '1',
    rateLimit: {
      ip: {
        windowMs: num('GREPPA_RATE_IP_WINDOW_MS', 60_000),
        limit: num('GREPPA_RATE_IP_LIMIT', 60),
      },
      session: {
        windowMs: num('GREPPA_RATE_SESSION_WINDOW_MS', 60_000),
        limit: num('GREPPA_RATE_SESSION_LIMIT', 30),
      },
    },
  }
  return cached
}

export function _resetGreppaConfigForTests(): void {
  cached = null
}