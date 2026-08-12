export type GreppaAuthConfig = {
  databaseUrl: string
  secret: string
  baseUrl: string
  trustedOrigins: string[]
  google?: {
    clientId: string
    clientSecret: string
  }
}

let cached: GreppaAuthConfig | null = null

function parseOrigins(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
}

export function loadAuthConfig(): GreppaAuthConfig {
  if (cached) return cached

  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required for Better Auth')
  }

  const secret = process.env.BETTER_AUTH_SECRET
  if (!secret || secret.length < 32) {
    throw new Error('BETTER_AUTH_SECRET is required and must be at least 32 chars')
  }

  const baseUrl = process.env.BETTER_AUTH_URL || 'http://localhost:3009/api/v1/auth'
  const trustedOrigins = Array.from(
    new Set([
      new URL(baseUrl).origin,
      ...parseOrigins(process.env.GREPPA_ALLOWED_ORIGINS),
    ]),
  )

  const googleClientId = process.env.GOOGLE_CLIENT_ID?.trim()
  const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim()

  cached = {
    databaseUrl,
    secret,
    baseUrl,
    trustedOrigins,
    google:
      googleClientId && googleClientSecret
        ? {
            clientId: googleClientId,
            clientSecret: googleClientSecret,
          }
        : undefined,
  }

  return cached
}

