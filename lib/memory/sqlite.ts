import { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'
import * as sqliteVec from 'sqlite-vec'

/**
 * Bun's bundled SQLite on macOS is built without dynamic extension loading, so
 * sqlite-vec cannot register. Point Bun at a build that supports it. Linux
 * builds generally allow extensions, so this is a no-op there.
 *
 * MUST run before the first Database is constructed; Bun caches the library.
 */
const MACOS_CANDIDATES = [
  '/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib',
  '/usr/local/opt/sqlite/lib/libsqlite3.dylib',
]

let configured = false

function configureSqlite(): void {
  if (configured) return
  configured = true
  const override = process.env.GREPPA_SQLITE_LIB
  const candidates = override ? [override] : process.platform === 'darwin' ? MACOS_CANDIDATES : []
  const lib = candidates.find((p) => existsSync(p))
  if (lib) Database.setCustomSQLite(lib)
}

export type OpenSqliteOptions = { readonly?: boolean; create?: boolean }

/**
 * Open a scope database with the pragmas Checkpoint requires.
 *
 * journal_mode=DELETE is not a preference: WAL writes `-wal` and `-shm`
 * sidecars, and Checkpoint uploads exactly one path, so a WAL sidecar would be
 * silently dropped and lose data. Checkpoint already serialises writes per
 * scope and readers hold immutable generations, so WAL buys nothing here.
 */
export function openSqlite(path: string, opts: OpenSqliteOptions = {}): Database {
  configureSqlite()
  // Bun maps these options onto sqlite3_open_v2 flags, and `{readonly: false,
  // create: false}` produces no flags at all, which the driver rejects with
  // SQLITE_MISUSE. Each mode has to be requested explicitly.
  const flags = opts.readonly
    ? { readonly: true }
    : opts.create
      ? { readwrite: true, create: true }
      : { readwrite: true }
  const db = new Database(path, flags)
  try {
    sqliteVec.load(db)
  } catch (err) {
    db.close()
    throw new Error(
      `[scope-store] sqlite-vec failed to load: ${(err as Error).message}. ` +
        `On macOS install a SQLite with extension support (brew install sqlite) or set ` +
        `GREPPA_SQLITE_LIB to a libsqlite3 that allows dynamic extensions.`,
    )
  }
  if (!opts.readonly) {
    db.run('pragma journal_mode = DELETE')
    db.run('pragma synchronous = NORMAL')
  }
  db.run('pragma foreign_keys = ON')
  return db
}
