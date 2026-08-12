import { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'
import * as sqliteVec from 'sqlite-vec'

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

export function openSqlite(path: string, opts: OpenSqliteOptions = {}): Database {
  configureSqlite()
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
