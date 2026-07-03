import { drizzle as drizzle_orm } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import * as authSchema from '../db/schema/auth'
import * as tenantSchema from '../db/schema/tenant'
import { loadAuthConfig } from './auth-config'

const dbSchema = { ...authSchema, ...tenantSchema }

export type GreppaDatabase = ReturnType<typeof drizzle_orm<typeof dbSchema>>

let pool: Pool | null = null
let _drizzle: GreppaDatabase | null = null

function getPool(): Pool {
  if (pool) return pool
  const cfg = loadAuthConfig()
  pool = new Pool({
    connectionString: cfg.databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  })
  return pool
}

export function getDrizzle(): GreppaDatabase {
  if (_drizzle) return _drizzle
  _drizzle = drizzle_orm(getPool(), { schema: dbSchema }) as GreppaDatabase
  return _drizzle
}

// Lazy proxy for simple property access
export const drizzle = new Proxy({} as GreppaDatabase, {
  get(_target, prop) {
    const db = getDrizzle()
    return (db as any)[prop]
  },
}) as GreppaDatabase

export const schema = dbSchema

export async function closeDbPool(): Promise<void> {
  if (!pool) return
  const p = pool
  pool = null
  _drizzle = null
  await p.end()
}

// Graceful shutdown handlers
function setupCleanup() {
  const cleanup = async () => {
    console.log('[db] closing pool...')
    await closeDbPool()
    process.exit(0)
  }
  process.on('SIGINT', cleanup)
  process.on('SIGTERM', cleanup)
  process.on('beforeExit', cleanup)
}

// Only setup cleanup in non-test environments
if (process.env.NODE_ENV !== 'test') {
  setupCleanup()
}

// Re-export all drizzle-orm functions to ensure type consistency
export * from 'drizzle-orm'
