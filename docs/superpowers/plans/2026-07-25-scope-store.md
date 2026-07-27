# Scope Store Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `@memvid/sdk` with a per-scope SQLite store providing real semantic + lexical retrieval, served through the existing unmodified Checkpoint layer.

**Architecture:** One SQLite file per scope in R2, managed by Checkpoint's ETag compare-and-set. Vectors via `sqlite-vec` (`vec0`), lexical via FTS5 BM25, fused with reciprocal rank fusion. Embeddings come from a pluggable provider whose identity is pinned in a `meta` table. Images live outside the database as content-addressed R2 objects.

**Tech Stack:** Bun, `bun:sqlite` (built in, not an N-API addon), `sqlite-vec@0.1.9`, FTS5, OpenRouter (Nemotron Embed VL 1B v2), Google Gemini Embedding 2.

**Spec:** `docs/superpowers/specs/2026-07-25-scope-store-design.md`

## Global Constraints

- **Never commit or push.** The user commits explicitly. Every task ends with verification, not `git commit`.
- **Never modify `utils/checkpoint/checkpoint.ts`.** It is measured correct (3 ms overhead) and out of scope.
- **Never touch `sample.md`**, `.codex/`, `.cursor/`, `.gemini/`, `.mcp.json`, `opencode.json`.
- **Do not kill any running dev server** (Sumi or Next.js).
- Legacy single-file memory (`lib/memory/memvid.ts`, `service.ts`, `sync.ts`, `lib/memory/r2.ts`) is **out of scope**. It still imports `@memvid/sdk`; leave it alone.
- `journal_mode = DELETE` on every write connection. WAL sidecars would be dropped from Checkpoint's single-file upload and lose data.
- `foreign_keys = ON` per connection.
- Read connections open `{ readonly: true }`. Readers share one immutable generation file.
- Vector dimension is **never** hardcoded. It comes from `provider.dimension` and is asserted against `meta`.
- Every `EmbeddingProvider.embed()` returns **L2-normalized** vectors.
- Public signatures of `addScopedMemory` / `searchScopedMemory` / `askScopedMemory` do not change.
- Tests run offline by default. Network tests gate on `CHECKPOINT_LIVE_R2=1`.
- Run `bunx tsc --noEmit` before declaring any task done.

---

## File Structure

| path | responsibility |
| --- | --- |
| `lib/memory/sqlite.ts` | Resolve a SQLite build supporting `loadExtension`; open helpers |
| `lib/memory/embedding/provider.ts` | `EmbeddingProvider` interface, `l2normalize`, `EmbeddingIdentityError` |
| `lib/memory/embedding/deterministic.ts` | Seeded offline provider for tests |
| `lib/memory/embedding/openrouter.ts` | Nemotron Embed VL 1B v2 |
| `lib/memory/embedding/google.ts` | Gemini Embedding 2 |
| `lib/memory/embedding/index.ts` | `getEmbeddingProvider()` from env |
| `lib/memory/scope-store/schema.ts` | DDL, `SCHEMA_VERSION`, identity read/write |
| `lib/memory/scope-store/chunker.ts` | `chunkText()` |
| `lib/memory/scope-store/fusion.ts` | `reciprocalRankFusion()` |
| `lib/memory/scope-store/store.ts` | `openScopeStore()`, `insertDocument()`, `hybridSearch()` |

> **Two corrections applied during execution of Tasks 1–5** (already reflected in the code below):
> 1. `openSqlite` must request an explicit sqlite3 open mode; `{readonly: false, create: false}` is SQLITE_MISUSE under Bun.
> 2. `count(*)` on an external-content FTS5 table scans the *content* table, not the index, so FTS coverage must be asserted via `MATCH`, never by counting rows.
| `lib/memory/scope-store/reembed.ts` | `reembedScope()` |
| `lib/memory/assets.ts` | `putAssetIfAbsent()`, `getAsset()` |
| `lib/memory/scoped-service.ts` | **modify** — swap Memvid for the store |

---

## Task 1: SQLite shim, provider interface, deterministic provider

**Files:**
- Create: `lib/memory/sqlite.ts`
- Create: `lib/memory/embedding/provider.ts`
- Create: `lib/memory/embedding/deterministic.ts`
- Test: `lib/memory/embedding/provider.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `openSqlite(path: string, opts: { readonly?: boolean; create?: boolean }): Database`
  - `interface EmbeddingProvider { id: string; dimension: number; maxBatchSize: number; embed(texts: string[], kind: 'document'|'query'): Promise<Float32Array[]>; embedImage?(assets: Array<{bytes: Uint8Array; mime: string}>): Promise<Float32Array[]> }`
  - `l2normalize(v: Float32Array): Float32Array`
  - `class EmbeddingIdentityError extends Error`
  - `createDeterministicProvider(dimension?: number): EmbeddingProvider`

- [ ] **Step 1: Add the dependency**

```bash
cd /Users/APPLE/dev/greppa-ai/greppa && bun add sqlite-vec
```

Expected: `installed sqlite-vec@0.1.9`.

- [ ] **Step 2: Write the failing test**

Create `lib/memory/embedding/provider.test.ts`:

```ts
import { describe, expect, test } from 'bun:test'
import { l2normalize } from './provider'
import { createDeterministicProvider } from './deterministic'

const norm = (v: Float32Array) => Math.sqrt(v.reduce((a, x) => a + x * x, 0))

describe('l2normalize', () => {
  test('scales a vector to unit length', () => {
    const out = l2normalize(new Float32Array([3, 4]))
    expect(norm(out)).toBeCloseTo(1, 6)
    expect(out[0]).toBeCloseTo(0.6, 6)
  })

  test('leaves an all-zero vector alone instead of dividing by zero', () => {
    const out = l2normalize(new Float32Array([0, 0, 0]))
    expect([...out]).toEqual([0, 0, 0])
  })
})

describe('deterministic provider', () => {
  test('declares its identity and dimension', () => {
    const p = createDeterministicProvider(64)
    expect(p.dimension).toBe(64)
    expect(p.id).toBe('deterministic@64')
    expect(p.maxBatchSize).toBeGreaterThan(0)
  })

  test('returns one unit vector per input, of the declared dimension', async () => {
    const p = createDeterministicProvider(64)
    const out = await p.embed(['alpha', 'beta'], 'document')
    expect(out.length).toBe(2)
    expect(out[0]!.length).toBe(64)
    expect(norm(out[0]!)).toBeCloseTo(1, 5)
  })

  test('is deterministic: same text yields the same vector', async () => {
    const p = createDeterministicProvider(64)
    const [a] = await p.embed(['same text'], 'document')
    const [b] = await p.embed(['same text'], 'document')
    expect([...a!]).toEqual([...b!])
  })

  test('similar text is closer than unrelated text', async () => {
    const p = createDeterministicProvider(128)
    const [q, near, far] = await p.embed(
      ['cat pet animal mammal', 'pet animal mammal cat', 'invoice quarterly revenue fiscal'],
      'document',
    )
    const dot = (a: Float32Array, b: Float32Array) => a.reduce((s, x, i) => s + x * b[i]!, 0)
    expect(dot(q!, near!)).toBeGreaterThan(dot(q!, far!))
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
cd /Users/APPLE/dev/greppa-ai/greppa && bun test lib/memory/embedding/provider.test.ts
```

Expected: FAIL — cannot resolve `./provider`.

- [ ] **Step 4: Write `lib/memory/sqlite.ts`**

```ts
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
```

- [ ] **Step 5: Write `lib/memory/embedding/provider.ts`**

```ts
/** Thrown when a scope's stored embedding identity disagrees with the live provider. */
export class EmbeddingIdentityError extends Error {
  constructor(expected: string, actual: string) {
    super(
      `[scope-store] embedding identity mismatch: file was written with "${expected}" ` +
        `but the configured provider is "${actual}". Vectors from different models are not ` +
        `comparable; run reembedScope() to migrate this scope.`,
    )
    this.name = 'EmbeddingIdentityError'
  }
}

/** Scale to unit length. A zero vector is returned unchanged rather than NaN. */
export function l2normalize(v: Float32Array): Float32Array {
  let sum = 0
  for (const x of v) sum += x * x
  if (sum === 0) return v
  const inv = 1 / Math.sqrt(sum)
  const out = new Float32Array(v.length)
  for (let i = 0; i < v.length; i++) out[i] = v[i]! * inv
  return out
}

export type EmbedKind = 'document' | 'query'

export interface EmbeddingProvider {
  /** Stable identity written to meta, e.g. "google/gemini-embedding-2@1536". */
  readonly id: string
  /** Configured at construction. Never a module constant. */
  readonly dimension: number
  /** Largest number of inputs per upstream request. */
  readonly maxBatchSize: number
  /**
   * Embed text. Implementations MUST return L2-normalized vectors of exactly
   * `dimension` length: the store compares with dot product and unnormalized
   * vectors produce silently wrong distances.
   *
   * `kind` maps to the provider's asymmetric retrieval mode (Google's
   * task_type). Embedding a query as a document measurably reduces recall.
   */
  embed(texts: string[], kind: EmbedKind): Promise<Float32Array[]>
  embedImage?(assets: Array<{ bytes: Uint8Array; mime: string }>): Promise<Float32Array[]>
}

/** Split into provider-sized batches and run them in order. */
export async function embedInBatches(
  provider: EmbeddingProvider,
  texts: string[],
  kind: EmbedKind,
): Promise<Float32Array[]> {
  const out: Float32Array[] = []
  for (let i = 0; i < texts.length; i += provider.maxBatchSize) {
    out.push(...(await provider.embed(texts.slice(i, i + provider.maxBatchSize), kind)))
  }
  return out
}
```

- [ ] **Step 6: Write `lib/memory/embedding/deterministic.ts`**

```ts
import { type EmbeddingProvider, type EmbedKind, l2normalize } from './provider'

/**
 * Offline provider for tests. Builds a bag-of-words vector by hashing each
 * token into the dimension space, so texts sharing vocabulary land closer
 * together than unrelated texts. Not semantic — it cannot substitute for a
 * real model in retrieval-quality assertions — but it is deterministic, free,
 * and needs no network.
 */
function hash(token: string): number {
  let h = 2166136261 >>> 0
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return h
}

export function createDeterministicProvider(dimension = 128): EmbeddingProvider {
  const embedOne = (text: string): Float32Array => {
    const v = new Float32Array(dimension)
    for (const token of text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
      const h = hash(token)
      v[h % dimension] += 1
      v[(h >>> 8) % dimension] += 0.5
    }
    return l2normalize(v)
  }

  return {
    id: `deterministic@${dimension}`,
    dimension,
    maxBatchSize: 256,
    async embed(texts: string[], _kind: EmbedKind): Promise<Float32Array[]> {
      return texts.map(embedOne)
    },
    async embedImage(assets): Promise<Float32Array[]> {
      return assets.map((a) => embedOne(`image:${a.mime}:${a.bytes.byteLength}`))
    },
  }
}
```

- [ ] **Step 7: Run the tests**

```bash
cd /Users/APPLE/dev/greppa-ai/greppa && bun test lib/memory/embedding/provider.test.ts
```

Expected: PASS, 6 tests.

- [ ] **Step 8: Verify the SQLite shim actually loads sqlite-vec**

```bash
cd /Users/APPLE/dev/greppa-ai/greppa && bun -e '
import { openSqlite } from "./lib/memory/sqlite"
const db = openSqlite(":memory:", { create: true })
console.log("vec_version:", db.prepare("select vec_version() as v").get())
db.run("create virtual table t using fts5(x)")
console.log("fts5: ok")
db.close()
'
```

Expected: `vec_version: { v: "v0.1.9" }` then `fts5: ok`.

- [ ] **Step 9: Typecheck**

```bash
cd /Users/APPLE/dev/greppa-ai/greppa && bunx tsc --noEmit
```

Expected: exit 0, no output.

---

## Task 2: Schema and store open with identity assertion

**Files:**
- Create: `lib/memory/scope-store/schema.ts`
- Test: `lib/memory/scope-store/schema.test.ts`

**Interfaces:**
- Consumes: `openSqlite` (Task 1), `EmbeddingProvider`, `EmbeddingIdentityError` (Task 1).
- Produces:
  - `const SCHEMA_VERSION = 1`
  - `createSchema(db: Database, provider: EmbeddingProvider): void`
  - `readIdentity(db: Database): { model: string; dimension: number; schemaVersion: number } | null`
  - `assertIdentity(db: Database, provider: EmbeddingProvider): void`

- [ ] **Step 1: Write the failing test**

Create `lib/memory/scope-store/schema.test.ts`:

```ts
import { describe, expect, test } from 'bun:test'
import { openSqlite } from '../sqlite'
import { createDeterministicProvider } from '../embedding/deterministic'
import { EmbeddingIdentityError } from '../embedding/provider'
import { SCHEMA_VERSION, assertIdentity, createSchema, readIdentity } from './schema'

const fresh = (dim = 64) => {
  const provider = createDeterministicProvider(dim)
  const db = openSqlite(':memory:', { create: true })
  createSchema(db, provider)
  return { db, provider }
}

describe('schema', () => {
  test('creates every table', () => {
    const { db } = fresh()
    const names = db
      .prepare("select name from sqlite_master where type in ('table','view') order by name")
      .all()
      .map((r: any) => r.name)
    for (const t of ['meta', 'documents', 'chunks', 'chunks_fts', 'chunks_vec']) {
      expect(names).toContain(t)
    }
    db.close()
  })

  test('writes the provider identity into meta', () => {
    const { db, provider } = fresh(64)
    expect(readIdentity(db)).toEqual({
      model: provider.id,
      dimension: 64,
      schemaVersion: SCHEMA_VERSION,
    })
    db.close()
  })

  test('creates the vector table at the provider dimension, not a constant', () => {
    const { db } = fresh(37)
    const v = new Float32Array(37).fill(1)
    db.prepare('insert into chunks_vec(rowid, embedding) values (?, ?)').run(1, Buffer.from(v.buffer))
    expect(db.prepare('select count(*) as n from chunks_vec').get()).toEqual({ n: 1 })
    db.close()
  })

  test('rejects a vector of the wrong dimension', () => {
    const { db } = fresh(37)
    const wrong = new Float32Array(64).fill(1)
    expect(() =>
      db.prepare('insert into chunks_vec(rowid, embedding) values (?, ?)').run(1, Buffer.from(wrong.buffer)),
    ).toThrow()
    db.close()
  })

  test('assertIdentity passes for the same provider', () => {
    const { db, provider } = fresh(64)
    expect(() => assertIdentity(db, provider)).not.toThrow()
    db.close()
  })

  test('assertIdentity throws when the dimension differs', () => {
    const { db } = fresh(64)
    expect(() => assertIdentity(db, createDeterministicProvider(128))).toThrow(EmbeddingIdentityError)
    db.close()
  })

  test('readIdentity returns null on an empty database', () => {
    const db = openSqlite(':memory:', { create: true })
    expect(readIdentity(db)).toBeNull()
    db.close()
  })

  test('foreign keys cascade from documents to chunks', () => {
    const { db } = fresh()
    db.run("insert into documents(id,title,source_type,created_by,created_at) values ('d1','t','note','u',1)")
    db.run("insert into chunks(id,document_id,ordinal,text,modality) values (1,'d1',0,'hello','text')")
    db.run("delete from documents where id='d1'")
    expect(db.prepare('select count(*) as n from chunks').get()).toEqual({ n: 0 })
    db.close()
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
cd /Users/APPLE/dev/greppa-ai/greppa && bun test lib/memory/scope-store/schema.test.ts
```

Expected: FAIL — cannot resolve `./schema`.

- [ ] **Step 3: Write `lib/memory/scope-store/schema.ts`**

```ts
import type { Database } from 'bun:sqlite'
import { type EmbeddingProvider, EmbeddingIdentityError } from '../embedding/provider'

export const SCHEMA_VERSION = 1

export type ScopeIdentity = { model: string; dimension: number; schemaVersion: number }

/**
 * Create every table. The vector table's dimension comes from the provider and
 * is fixed for the life of the file: vec0 cannot be altered in place, so
 * changing providers means reembedScope() drops and recreates it.
 */
export function createSchema(db: Database, provider: EmbeddingProvider): void {
  db.run(`create table if not exists meta(
    key   text primary key,
    value text not null
  )`)

  db.run(`create table if not exists documents(
    id          text primary key,
    title       text not null,
    source_type text not null,
    source_url  text,
    created_by  text not null,
    created_at  integer not null,
    meta_json   text
  )`)

  db.run(`create table if not exists chunks(
    id           integer primary key,
    document_id  text not null references documents(id) on delete cascade,
    ordinal      integer not null,
    text         text not null,
    modality     text not null,
    asset_sha256 text,
    asset_mime   text
  )`)
  db.run('create index if not exists chunks_by_document on chunks(document_id)')

  // External-content FTS5: the text lives in `chunks`, not duplicated here.
  // Rows must be inserted explicitly, and deletes need the 'delete' command.
  db.run(`create virtual table if not exists chunks_fts using fts5(
    text, content=chunks, content_rowid=id
  )`)

  db.run(`create virtual table if not exists chunks_vec using vec0(
    embedding float[${provider.dimension}]
  )`)

  writeIdentity(db, provider)
}

export function writeIdentity(db: Database, provider: EmbeddingProvider): void {
  const put = db.prepare('insert into meta(key, value) values (?, ?) on conflict(key) do update set value = excluded.value')
  put.run('schema_version', String(SCHEMA_VERSION))
  put.run('embedding_model', provider.id)
  put.run('embedding_dim', String(provider.dimension))
  if (!db.prepare("select 1 from meta where key = 'created_at'").get()) {
    put.run('created_at', String(Date.now()))
  }
}

export function readIdentity(db: Database): ScopeIdentity | null {
  const has = db
    .prepare("select name from sqlite_master where type='table' and name='meta'")
    .get()
  if (!has) return null
  const rows = db.prepare('select key, value from meta').all() as Array<{ key: string; value: string }>
  const m = new Map(rows.map((r) => [r.key, r.value]))
  const model = m.get('embedding_model')
  const dim = m.get('embedding_dim')
  if (!model || !dim) return null
  return { model, dimension: Number(dim), schemaVersion: Number(m.get('schema_version') ?? '0') }
}

/**
 * Refuse to query across embedding models. Comparing a query vector from model
 * A against document vectors from model B returns plausible-looking nonsense
 * rather than an error, so this check is the only thing standing between a
 * misconfiguration and silently wrong memories.
 */
export function assertIdentity(db: Database, provider: EmbeddingProvider): void {
  const identity = readIdentity(db)
  if (!identity) return
  if (identity.model !== provider.id || identity.dimension !== provider.dimension) {
    throw new EmbeddingIdentityError(`${identity.model}@${identity.dimension}`, `${provider.id}@${provider.dimension}`)
  }
}
```

- [ ] **Step 4: Run the tests**

```bash
cd /Users/APPLE/dev/greppa-ai/greppa && bun test lib/memory/scope-store/schema.test.ts
```

Expected: PASS, 8 tests.

- [ ] **Step 5: Typecheck**

```bash
cd /Users/APPLE/dev/greppa-ai/greppa && bunx tsc --noEmit
```

Expected: exit 0.

---

## Task 3: Chunker

**Files:**
- Create: `lib/memory/scope-store/chunker.ts`
- Test: `lib/memory/scope-store/chunker.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `chunkText(text: string, opts?: { targetChars?: number; overlapChars?: number }): string[]`, `CHUNK_TARGET_CHARS = 1000`, `CHUNK_OVERLAP_CHARS = 150`.

- [ ] **Step 1: Write the failing test**

Create `lib/memory/scope-store/chunker.test.ts`:

```ts
import { describe, expect, test } from 'bun:test'
import { CHUNK_OVERLAP_CHARS, CHUNK_TARGET_CHARS, chunkText } from './chunker'

describe('chunkText', () => {
  test('returns a short note as a single chunk', () => {
    expect(chunkText('a short note')).toEqual(['a short note'])
  })

  test('returns nothing for empty or whitespace-only input', () => {
    expect(chunkText('')).toEqual([])
    expect(chunkText('   \n\t ')).toEqual([])
  })

  test('splits long text into multiple chunks near the target size', () => {
    const para = 'x'.repeat(400)
    const chunks = chunkText([para, para, para, para, para].join('\n\n'))
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(CHUNK_TARGET_CHARS + CHUNK_OVERLAP_CHARS + 50)
  })

  test('prefers paragraph boundaries', () => {
    const chunks = chunkText(['alpha '.repeat(120), 'beta '.repeat(120)].join('\n\n'))
    expect(chunks[0]).toContain('alpha')
    expect(chunks[0]).not.toContain('beta')
  })

  test('overlaps consecutive chunks so context is not cut mid-idea', () => {
    const sentences = Array.from({ length: 60 }, (_, i) => `Sentence number ${i} carries meaning.`).join(' ')
    const chunks = chunkText(sentences, { targetChars: 300, overlapChars: 80 })
    expect(chunks.length).toBeGreaterThan(2)
    const tail = chunks[0]!.slice(-40)
    expect(chunks[1]!.startsWith(tail.slice(0, 20)) || chunks[1]!.includes(tail.slice(0, 20))).toBe(true)
  })

  test('hard-splits a single unbroken run with no paragraph or sentence breaks', () => {
    const chunks = chunkText('y'.repeat(5000), { targetChars: 1000, overlapChars: 0 })
    expect(chunks.length).toBe(5)
    expect(chunks.every((c) => c.length <= 1000)).toBe(true)
  })

  test('never emits an empty chunk', () => {
    const chunks = chunkText('a\n\n\n\nb\n\n\n\nc')
    expect(chunks.every((c) => c.trim().length > 0)).toBe(true)
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
cd /Users/APPLE/dev/greppa-ai/greppa && bun test lib/memory/scope-store/chunker.test.ts
```

Expected: FAIL — cannot resolve `./chunker`.

- [ ] **Step 3: Write `lib/memory/scope-store/chunker.ts`**

```ts
export const CHUNK_TARGET_CHARS = 1000
export const CHUNK_OVERLAP_CHARS = 150

export type ChunkOptions = { targetChars?: number; overlapChars?: number }

/** Split on paragraphs, then sentences, then a hard cut, in that order. */
function segment(text: string, max: number): string[] {
  const out: string[] = []
  for (const para of text.split(/\n{2,}/)) {
    const trimmed = para.trim()
    if (!trimmed) continue
    if (trimmed.length <= max) {
      out.push(trimmed)
      continue
    }
    let buffer = ''
    for (const sentence of trimmed.split(/(?<=[.!?])\s+/)) {
      if (sentence.length > max) {
        if (buffer) {
          out.push(buffer)
          buffer = ''
        }
        for (let i = 0; i < sentence.length; i += max) out.push(sentence.slice(i, i + max))
        continue
      }
      if (buffer.length + sentence.length + 1 > max) {
        out.push(buffer)
        buffer = sentence
      } else {
        buffer = buffer ? `${buffer} ${sentence}` : sentence
      }
    }
    if (buffer) out.push(buffer)
  }
  return out
}

/**
 * Split text into retrieval-sized chunks. Long documents embedded whole average
 * into an unusable vector, so webpages and PDFs must be chunked before
 * embedding. Short notes and chat messages fall through as a single chunk.
 */
export function chunkText(text: string, opts: ChunkOptions = {}): string[] {
  const target = opts.targetChars ?? CHUNK_TARGET_CHARS
  const overlap = opts.overlapChars ?? CHUNK_OVERLAP_CHARS
  if (!text.trim()) return []

  const pieces = segment(text, target)
  if (pieces.length <= 1) return pieces

  const out: string[] = []
  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i]!
    if (i === 0 || overlap <= 0) {
      out.push(piece)
      continue
    }
    const carry = pieces[i - 1]!.slice(-overlap)
    const merged = `${carry} ${piece}`.trim()
    out.push(merged)
  }
  return out.filter((c) => c.trim().length > 0)
}
```

- [ ] **Step 4: Run the tests**

```bash
cd /Users/APPLE/dev/greppa-ai/greppa && bun test lib/memory/scope-store/chunker.test.ts
```

Expected: PASS, 7 tests. If the overlap test fails, the carry slice is the thing to adjust — the assertion only requires the previous chunk's tail to appear in the next chunk.

- [ ] **Step 5: Typecheck**

```bash
cd /Users/APPLE/dev/greppa-ai/greppa && bunx tsc --noEmit
```

Expected: exit 0.

---

## Task 4: Reciprocal rank fusion

**Files:**
- Create: `lib/memory/scope-store/fusion.ts`
- Test: `lib/memory/scope-store/fusion.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `type Ranked = { id: number }`, `reciprocalRankFusion(lists: number[][], opts?: { k?: number; limit?: number }): Array<{ id: number; score: number }>`, `RRF_K = 60`.

- [ ] **Step 1: Write the failing test**

Create `lib/memory/scope-store/fusion.test.ts`:

```ts
import { describe, expect, test } from 'bun:test'
import { RRF_K, reciprocalRankFusion } from './fusion'

describe('reciprocalRankFusion', () => {
  test('ranks an item appearing high in both lists above one appearing in only one', () => {
    const fused = reciprocalRankFusion([[1, 2, 3], [1, 4, 5]])
    expect(fused[0]!.id).toBe(1)
  })

  test('includes items unique to a single list', () => {
    const ids = reciprocalRankFusion([[1, 2], [3]]).map((r) => r.id)
    expect(ids.sort()).toEqual([1, 2, 3])
  })

  test('scores by summed reciprocal rank', () => {
    const fused = reciprocalRankFusion([[7], [7]])
    expect(fused[0]!.score).toBeCloseTo(2 / (RRF_K + 1), 10)
  })

  test('respects the limit', () => {
    expect(reciprocalRankFusion([[1, 2, 3, 4, 5]], { limit: 2 }).length).toBe(2)
  })

  test('handles empty lists', () => {
    expect(reciprocalRankFusion([[], []])).toEqual([])
  })

  test('is order-stable for equal scores', () => {
    const a = reciprocalRankFusion([[1, 2], [1, 2]]).map((r) => r.id)
    const b = reciprocalRankFusion([[1, 2], [1, 2]]).map((r) => r.id)
    expect(a).toEqual(b)
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
cd /Users/APPLE/dev/greppa-ai/greppa && bun test lib/memory/scope-store/fusion.test.ts
```

Expected: FAIL — cannot resolve `./fusion`.

- [ ] **Step 3: Write `lib/memory/scope-store/fusion.ts`**

```ts
/** Standard RRF damping constant; 60 is the value from the original paper. */
export const RRF_K = 60

export type FusedHit = { id: number; score: number }

/**
 * Fuse ranked id lists by reciprocal rank. Vector distance and BM25 scores are
 * not on comparable scales, so they are combined by rank rather than by value.
 */
export function reciprocalRankFusion(
  lists: number[][],
  opts: { k?: number; limit?: number } = {},
): FusedHit[] {
  const k = opts.k ?? RRF_K
  const scores = new Map<number, number>()
  const firstSeen = new Map<number, number>()
  let order = 0

  for (const list of lists) {
    for (let rank = 0; rank < list.length; rank++) {
      const id = list[rank]!
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank + 1))
      if (!firstSeen.has(id)) firstSeen.set(id, order++)
    }
  }

  const fused = [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score || firstSeen.get(a.id)! - firstSeen.get(b.id)!)

  return opts.limit ? fused.slice(0, opts.limit) : fused
}
```

- [ ] **Step 4: Run the tests**

```bash
cd /Users/APPLE/dev/greppa-ai/greppa && bun test lib/memory/scope-store/fusion.test.ts
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Typecheck**

```bash
cd /Users/APPLE/dev/greppa-ai/greppa && bunx tsc --noEmit
```

Expected: exit 0.

---

## Task 5: Store — insert and hybrid search

**Files:**
- Create: `lib/memory/scope-store/store.ts`
- Test: `lib/memory/scope-store/store.test.ts`

**Interfaces:**
- Consumes: `openSqlite` (T1), `EmbeddingProvider`/`embedInBatches` (T1), `createSchema`/`assertIdentity`/`readIdentity` (T2), `chunkText` (T3), `reciprocalRankFusion` (T4).
- Produces:
  - `type ScopeStore = { db: Database; provider: EmbeddingProvider; close(): void }`
  - `openScopeStore(path: string, opts: { provider: EmbeddingProvider; create: boolean; readonly?: boolean }): ScopeStore`
  - `type InsertDocumentInput = { id?: string; title: string; text: string; sourceType: string; sourceUrl?: string; createdBy: string; meta?: Record<string, unknown>; chunks: Array<{ text: string; embedding: Float32Array; modality?: 'text'|'image'|'text_image'; assetSha256?: string; assetMime?: string }> }`
  - `insertDocument(store: ScopeStore, input: InsertDocumentInput): string`
  - `type SearchHit = { chunkId: number; documentId: string; title: string; text: string; sourceType: string; sourceUrl: string | null; modality: string; assetSha256: string | null; score: number }`
  - `hybridSearch(store: ScopeStore, queryText: string, queryVector: Float32Array, limit: number): SearchHit[]`
  - `CANDIDATE_DEPTH = 50`

- [ ] **Step 1: Write the failing test**

Create `lib/memory/scope-store/store.test.ts`:

```ts
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDeterministicProvider } from '../embedding/deterministic'
import { EmbeddingIdentityError } from '../embedding/provider'
import { hybridSearch, insertDocument, openScopeStore } from './store'

const dirs: string[] = []
const tmpPath = () => {
  const d = mkdtempSync(join(tmpdir(), 'scope-store-'))
  dirs.push(d)
  return join(d, 'memory.sqlite')
}
const cleanup = () => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }) }

const provider = createDeterministicProvider(128)

async function seed(path: string, docs: Array<{ title: string; text: string }>) {
  const store = openScopeStore(path, { provider, create: true })
  for (const d of docs) {
    const [embedding] = await provider.embed([d.text], 'document')
    insertDocument(store, {
      title: d.title,
      text: d.text,
      sourceType: 'note',
      createdBy: 'u1',
      chunks: [{ text: d.text, embedding: embedding! }],
    })
  }
  return store
}

describe('scope store', () => {
  test('inserts a document and finds it by exact keyword', async () => {
    const store = await seed(tmpPath(), [
      { title: 'cat', text: 'the domestic cat is a small carnivorous mammal' },
      { title: 'finance', text: 'quarterly revenue forecast and invoice reconciliation' },
    ])
    const [qv] = await provider.embed(['carnivorous mammal'], 'query')
    const hits = hybridSearch(store, 'carnivorous mammal', qv!, 5)
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]!.title).toBe('cat')
    store.close()
    cleanup()
  })

  test('populates all three tables in one transaction', async () => {
    const path = tmpPath()
    const store = await seed(path, [{ title: 'a', text: 'alpha beta gamma' }])
    expect(store.db.prepare('select count(*) as n from documents').get()).toEqual({ n: 1 })
    expect(store.db.prepare('select count(*) as n from chunks').get()).toEqual({ n: 1 })
    expect(store.db.prepare('select count(*) as n from chunks_vec').get()).toEqual({ n: 1 })
    expect(store.db.prepare('select count(*) as n from chunks_fts').get()).toEqual({ n: 1 })
    store.close()
    cleanup()
  })

  test('does not index an image chunk with no text, but still stores its vector', async () => {
    const store = openScopeStore(tmpPath(), { provider, create: true })
    const [imageVec] = await provider.embed(['image'], 'document')
    const [textVec] = await provider.embed(['alpha beta'], 'document')
    insertDocument(store, {
      title: 'screenshot', text: '', sourceType: 'document', createdBy: 'u1',
      chunks: [{ text: '', embedding: imageVec!, modality: 'image', assetSha256: 'abc', assetMime: 'image/png' }],
    })
    insertDocument(store, {
      title: 'note', text: 'alpha beta', sourceType: 'note', createdBy: 'u1',
      chunks: [{ text: 'alpha beta', embedding: textVec!, modality: 'text' }],
    })
    // chunks_fts is an external-content table, so count(*) scans `chunks` and
    // can never tell us what is indexed. Assert on retrieval instead.
    const matched = store.db.prepare('select rowid as id from chunks_fts where chunks_fts match ?').all('"alpha"') as Array<{ id: number }>
    const imageChunkId = (store.db.prepare("select id from chunks where modality = 'image'").get() as { id: number }).id
    expect(matched.map((r) => r.id)).not.toContain(imageChunkId)
    expect(matched.length).toBe(1)
    expect(store.db.prepare('select count(*) as n from chunks_vec').get()).toEqual({ n: 2 })
    store.close()
    cleanup()
  })

  test('a query with FTS metacharacters does not throw', async () => {
    const store = await seed(tmpPath(), [{ title: 'a', text: 'alpha beta' }])
    const [qv] = await provider.embed(['alpha'], 'query')
    for (const q of ['alpha OR', '"unclosed', 'a AND (b', 'NEAR/', '*', '']) {
      expect(() => hybridSearch(store, q, qv!, 5)).not.toThrow()
    }
    store.close()
    cleanup()
  })

  test('returns vector hits even when no keyword matches', async () => {
    const store = await seed(tmpPath(), [{ title: 'a', text: 'alpha beta gamma delta' }])
    const [qv] = await provider.embed(['alpha beta gamma delta'], 'query')
    const hits = hybridSearch(store, 'zzzznomatchzzzz', qv!, 5)
    expect(hits.length).toBe(1)
    expect(hits[0]!.title).toBe('a')
    store.close()
    cleanup()
  })

  test('respects the limit', async () => {
    const store = await seed(
      tmpPath(),
      Array.from({ length: 10 }, (_, i) => ({ title: `d${i}`, text: `alpha document number ${i}` })),
    )
    const [qv] = await provider.embed(['alpha document'], 'query')
    expect(hybridSearch(store, 'alpha document', qv!, 3).length).toBe(3)
    store.close()
    cleanup()
  })

  test('reopening an existing file preserves its contents', async () => {
    const path = tmpPath()
    const first = await seed(path, [{ title: 'persisted', text: 'alpha beta gamma' }])
    first.close()
    const second = openScopeStore(path, { provider, create: false })
    expect(second.db.prepare('select count(*) as n from documents').get()).toEqual({ n: 1 })
    second.close()
    cleanup()
  })

  test('reopening writable with a different provider throws instead of silently rewriting identity', async () => {
    const path = tmpPath()
    const first = await seed(path, [{ title: 'a', text: 'alpha' }])
    first.close()
    const other = createDeterministicProvider(64) // different dimension
    expect(() => openScopeStore(path, { provider: other, create: false })).toThrow(EmbeddingIdentityError)
    cleanup()
  })

  test('leaves no -wal or -shm sidecar behind', async () => {
    const path = tmpPath()
    const store = await seed(path, [{ title: 'a', text: 'alpha' }])
    store.close()
    const { existsSync } = await import('node:fs')
    expect(existsSync(`${path}-wal`)).toBe(false)
    expect(existsSync(`${path}-shm`)).toBe(false)
    cleanup()
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
cd /Users/APPLE/dev/greppa-ai/greppa && bun test lib/memory/scope-store/store.test.ts
```

Expected: FAIL — cannot resolve `./store`.

- [ ] **Step 3: Write `lib/memory/scope-store/store.ts`**

```ts
import type { Database } from 'bun:sqlite'
import type { EmbeddingProvider } from '../embedding/provider'
import { openSqlite } from '../sqlite'
import { reciprocalRankFusion } from './fusion'
import { assertIdentity, createSchema, readIdentity } from './schema'

/** How many candidates each retriever contributes before fusion. */
export const CANDIDATE_DEPTH = 50

export type ScopeStore = { db: Database; provider: EmbeddingProvider; close(): void }

export type ChunkInput = {
  text: string
  embedding: Float32Array
  modality?: 'text' | 'image' | 'text_image'
  assetSha256?: string
  assetMime?: string
}

export type InsertDocumentInput = {
  id?: string
  title: string
  text: string
  sourceType: string
  sourceUrl?: string
  createdBy: string
  meta?: Record<string, unknown>
  chunks: ChunkInput[]
}

export type SearchHit = {
  chunkId: number
  documentId: string
  title: string
  text: string
  sourceType: string
  sourceUrl: string | null
  modality: string
  assetSha256: string | null
  score: number
}

export function openScopeStore(
  path: string,
  opts: { provider: EmbeddingProvider; create: boolean; readonly?: boolean },
): ScopeStore {
  const db = openSqlite(path, { create: opts.create, readonly: opts.readonly })
  try {
    // Order matters. createSchema() writes the identity, so calling it before
    // the check would overwrite the stored model with the current one and make
    // assertIdentity vacuously pass — silently querying across embedding
    // models, the exact failure this guard exists to prevent.
    const existing = readIdentity(db)
    if (existing) {
      assertIdentity(db, opts.provider)
    } else if (!opts.readonly) {
      createSchema(db, opts.provider)
    }
  } catch (err) {
    db.close()
    throw err
  }
  return { db, provider: opts.provider, close: () => db.close() }
}

const toBlob = (v: Float32Array): Buffer => Buffer.from(v.buffer, v.byteOffset, v.byteLength)

export function insertDocument(store: ScopeStore, input: InsertDocumentInput): string {
  const { db } = store
  const documentId = input.id ?? crypto.randomUUID()

  const insertDoc = db.prepare(
    'insert into documents(id,title,source_type,source_url,created_by,created_at,meta_json) values (?,?,?,?,?,?,?)',
  )
  const insertChunk = db.prepare(
    'insert into chunks(document_id,ordinal,text,modality,asset_sha256,asset_mime) values (?,?,?,?,?,?)',
  )
  const insertFts = db.prepare('insert into chunks_fts(rowid, text) values (?, ?)')
  const insertVec = db.prepare('insert into chunks_vec(rowid, embedding) values (?, ?)')

  const run = db.transaction(() => {
    insertDoc.run(
      documentId,
      input.title,
      input.sourceType,
      input.sourceUrl ?? null,
      input.createdBy,
      Date.now(),
      input.meta ? JSON.stringify(input.meta) : null,
    )
    for (let i = 0; i < input.chunks.length; i++) {
      const c = input.chunks[i]!
      if (c.embedding.length !== store.provider.dimension) {
        throw new Error(
          `[scope-store] chunk ${i} has dimension ${c.embedding.length}, expected ${store.provider.dimension}`,
        )
      }
      const res = insertChunk.run(
        documentId,
        i,
        c.text,
        c.modality ?? 'text',
        c.assetSha256 ?? null,
        c.assetMime ?? null,
      )
      const chunkId = Number(res.lastInsertRowid)
      // An empty-text chunk contributes nothing to BM25 and would only pollute
      // the index, so image-only chunks are vector-retrievable exclusively.
      if (c.text.trim()) insertFts.run(chunkId, c.text)
      insertVec.run(chunkId, toBlob(c.embedding))
    }
  })

  run()
  return documentId
}

/**
 * FTS5 MATCH parses its argument as a query language, so raw user input can be
 * a syntax error. Reduce to bare terms and quote each one.
 */
function toFtsQuery(raw: string): string | null {
  const terms = raw.toLowerCase().match(/[\p{L}\p{N}]+/gu)
  if (!terms || terms.length === 0) return null
  return terms.map((t) => `"${t}"`).join(' OR ')
}

export function hybridSearch(
  store: ScopeStore,
  queryText: string,
  queryVector: Float32Array,
  limit: number,
): SearchHit[] {
  const { db } = store
  if (queryVector.length !== store.provider.dimension) {
    throw new Error(
      `[scope-store] query vector has dimension ${queryVector.length}, expected ${store.provider.dimension}`,
    )
  }

  const vecIds = (
    db
      .prepare('select rowid as id from chunks_vec where embedding match ? and k = ? order by distance')
      .all(toBlob(queryVector), CANDIDATE_DEPTH) as Array<{ id: number }>
  ).map((r) => r.id)

  let ftsIds: number[] = []
  const ftsQuery = toFtsQuery(queryText)
  if (ftsQuery) {
    try {
      ftsIds = (
        db
          .prepare('select rowid as id from chunks_fts where chunks_fts match ? order by bm25(chunks_fts) limit ?')
          .all(ftsQuery, CANDIDATE_DEPTH) as Array<{ id: number }>
      ).map((r) => r.id)
    } catch {
      // A malformed FTS expression must degrade to vector-only, never fail the search.
      ftsIds = []
    }
  }

  const fused = reciprocalRankFusion([vecIds, ftsIds], { limit })
  if (fused.length === 0) return []

  const placeholders = fused.map(() => '?').join(',')
  const rows = db
    .prepare(
      `select c.id as chunkId, c.document_id as documentId, c.text as text, c.modality as modality,
              c.asset_sha256 as assetSha256, d.title as title, d.source_type as sourceType,
              d.source_url as sourceUrl
         from chunks c join documents d on d.id = c.document_id
        where c.id in (${placeholders})`,
    )
    .all(...fused.map((f) => f.id)) as Array<Omit<SearchHit, 'score'>>

  const byId = new Map(rows.map((r) => [r.chunkId, r]))
  return fused.flatMap((f) => {
    const row = byId.get(f.id)
    return row ? [{ ...row, score: f.score }] : []
  })
}
```

- [ ] **Step 4: Run the tests**

```bash
cd /Users/APPLE/dev/greppa-ai/greppa && bun test lib/memory/scope-store/store.test.ts
```

Expected: PASS, 9 tests.

- [ ] **Step 5: Run every test written so far**

```bash
cd /Users/APPLE/dev/greppa-ai/greppa && bun test lib/memory/
```

Expected: PASS, 30 tests across 4 files.

- [ ] **Step 6: Typecheck**

```bash
cd /Users/APPLE/dev/greppa-ai/greppa && bunx tsc --noEmit
```

Expected: exit 0.

---

## Remaining tasks

Tasks 6–10 continue in `2026-07-25-scope-store-part2.md`:

- **Task 6** — real providers: `openrouter.ts` (Nemotron Embed VL 1B v2), `google.ts` (Gemini Embedding 2), `index.ts` registry, shared normalization conformance test.
- **Task 7** — `assets.ts`: content-addressed `scopes/{id}/assets/{sha256}` put-if-absent and fetch.
- **Task 8** — rewire `scoped-service.ts`; reimplement `askScopedMemory` on Groq via the `ai` SDK; update `tests/server/scoped-memory.test.ts`.
- **Task 9** — `reembed.ts` plus the provider-switch migration test.
- **Task 10** — live end-to-end suite through real Checkpoint and real R2.
