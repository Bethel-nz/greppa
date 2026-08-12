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

export const drizzle = new Proxy({} as GreppaDatabase, {
  get(_target, prop) {
    const db = getDrizzle()
    return (db as any)[prop]
  },
}) as GreppaDatabase

export const schema = dbSchema

async function closeDbPool(): Promise<void> {
  if (!pool) return
  const p = pool
  pool = null
  _drizzle = null
  await p.end()
}

function setupCleanup() {
  let closing = false
  const cleanup = async (signal: NodeJS.Signals) => {
    if (closing) return
    closing = true
    console.log(`[db] ${signal} received, closing pool...`)
    try {
      await closeDbPool()
    } catch (err) {
      console.error('[db] pool did not close cleanly', err)
    }
    process.exit(signal === 'SIGINT' ? 130 : 143)
  }
  process.on('SIGINT', cleanup)
  process.on('SIGTERM', cleanup)
}

if (process.env.NODE_ENV !== 'test') {
  setupCleanup()
}

export * from 'drizzle-orm'
