/**
 * Shared helpers for the opt-in live Checkpoint suite.
 *
 * Everything here talks to real Cloudflare R2 and builds real scope-store
 * SQLite files. Nothing in this directory runs unless CHECKPOINT_LIVE_R2=1, so
 * the ordinary `bun test` run never needs cloud credentials.
 */
import { existsSync, readFileSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { R2Storage } from '~/utils/r2'
import type { StorageBackend } from '~/utils/checkpoint/storage'
import { createDeterministicProvider } from '~/lib/memory/embedding/deterministic'
import type { EmbeddingProvider } from '~/lib/memory/embedding/provider'
import { insertDocument, openScopeStore, type ScopeStore } from '~/lib/memory/scope-store/store'

/**
 * `bun test` sets NODE_ENV=test, and Bun deliberately skips `.env.local` in
 * that mode. The live R2 credentials live there, so without this the suite
 * inherits whatever stale values `.env` happens to hold and fails with an
 * opaque AccessDenied instead of a missing-credential error.
 *
 * Load it explicitly and let it win, reproducing what `bun run` sees. Values
 * here override the process environment on purpose: that is exactly the
 * precedence Bun applies outside test mode.
 */
function loadEnvLocal(): void {
  const path = resolve(import.meta.dir, '../../.env.local')
  if (!existsSync(path)) return
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!m) continue
    let value = m[2]!.trim()
    const quoted = value.length >= 2 && (value.at(0) === '"' || value.at(0) === "'") && value.at(-1) === value.at(0)
    if (quoted) value = value.slice(1, -1)
    process.env[m[1]!] = value
  }
}
loadEnvLocal()

export const LIVE = process.env.CHECKPOINT_LIVE_R2 === '1'

export const MiB = 1024 * 1024

export function requireLiveEnv(): void {
  for (const name of ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY']) {
    if (!process.env[name]) throw new Error(`[live] ${name} is required (put it in .env.local)`)
  }
}

export function liveStorage(): R2Storage {
  requireLiveEnv()
  return R2Storage.fromEnv()
}

/**
 * Every live run gets its own R2 prefix so parallel runs never collide and a
 * crashed run leaves an obviously-disposable island of objects behind.
 */
export function runPrefix(label: string): string {
  return `_live/${label}/${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}/`
}

/** Delete every object under a prefix. Returns how many were removed. */
export async function purgePrefix(storage: StorageBackend, prefix: string): Promise<number> {
  const objects = await storage.list(prefix)
  for (const o of objects) await storage.delete(o.key)
  return objects.length
}

// ---------------------------------------------------------------------------
// process metrics
// ---------------------------------------------------------------------------

export type MemorySample = {
  rssBytes: number
  heapUsedBytes: number
  heapTotalBytes: number
  externalBytes: number
}

/**
 * Sample process memory after a forced GC so heap numbers reflect retained
 * bytes rather than uncollected garbage. `Bun.gc` is Bun-only; under Node the
 * sample is still taken, just without the collection.
 */
export function sampleMemory(): MemorySample {
  const bun = (globalThis as { Bun?: { gc?: (force: boolean) => void } }).Bun
  bun?.gc?.(true)
  const m = process.memoryUsage()
  return {
    rssBytes: m.rss,
    heapUsedBytes: m.heapUsed,
    heapTotalBytes: m.heapTotal,
    externalBytes: m.external ?? 0,
  }
}

// ---------------------------------------------------------------------------
// on-disk accounting
// ---------------------------------------------------------------------------

export type DiskKind = 'generation' | 'working' | 'hydrating' | 'other'

export type DiskUsage = {
  totalBytes: number
  fileCount: number
  byKind: Record<DiskKind, { bytes: number; files: number }>
}

function classify(name: string): DiskKind {
  if (/\.generation-[0-9a-f-]{36}$/.test(name)) return 'generation'
  if (/\.write-[0-9a-f-]{36}$/.test(name)) return 'working'
  if (/\.hydrate-[0-9a-f-]{36}$/.test(name)) return 'hydrating'
  return 'other'
}

/**
 * Walk a cache directory and total the bytes it holds, grouped by the
 * generation kind encoded in each filename. Uses stat() only — a 100 MiB
 * a large scope database is never read into the JS heap to find out how big it is.
 */
export async function diskUsage(root: string): Promise<DiskUsage> {
  const usage: DiskUsage = {
    totalBytes: 0,
    fileCount: 0,
    byKind: {
      generation: { bytes: 0, files: 0 },
      working: { bytes: 0, files: 0 },
      hydrating: { bytes: 0, files: 0 },
      other: { bytes: 0, files: 0 },
    },
  }

  const walk = async (dir: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return // the cache dir may not exist yet
    }
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDirectory()) {
        await walk(p)
        continue
      }
      const s = await stat(p).catch(() => null)
      if (!s) continue // raced with an eviction; not an error
      const kind = classify(e.name)
      usage.totalBytes += s.size
      usage.fileCount++
      usage.byKind[kind].bytes += s.size
      usage.byKind[kind].files++
    }
  }

  await walk(root)
  return usage
}

// ---------------------------------------------------------------------------
// representative scope-store corpus
// ---------------------------------------------------------------------------

const VOCAB =
  `alpha beta gamma delta epsilon zeta eta theta iota kappa lambda sigma tau
   deploy rollback latency throughput checkpoint hydration generation etag bucket
   invoice contract renewal quarterly forecast pipeline retention churn cohort
   migration schema index vector lexical segment compaction tombstone frame scope`
    .split(/\s+/)
    .filter(Boolean)

/**
 * Deterministic pseudo-natural text. Seeded by frame index so two runs with the
 * same parameters build byte-identical content and the benchmark is repeatable.
 */
export function frameText(index: number, words: number): string {
  let seed = (index * 2_654_435_761) >>> 0
  const out: string[] = []
  for (let i = 0; i < words; i++) {
    seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0
    out.push(VOCAB[seed % VOCAB.length]!)
  }
  return out.join(' ')
}

/** Embedding provider used to build benchmark corpora: offline and free. */
export const benchProvider = (dimension = 1536): EmbeddingProvider => createDeterministicProvider(dimension)

/** Open a scope store read-only, mirroring searchScopedMemory(). */
export function openCorpusReadOnly(localPath: string, provider: EmbeddingProvider): ScopeStore {
  return openScopeStore(localPath, { provider, create: false, readonly: true })
}

/** Open a working generation for mutation, mirroring addScopedMemory(). */
export function openCorpusForWrite(localPath: string, exists: boolean, provider: EmbeddingProvider): ScopeStore {
  return openScopeStore(localPath, { provider, create: !exists })
}

export type CorpusResult = {
  path: string
  bytes: number
  documents: number
  buildMs: number
  wordsPerFrame: number
  dimension: number
}

export type BuildCorpusOptions = {
  path: string
  targetBytes: number
  wordsPerFrame?: number
  /** Embedding width; dominates file size at 4 bytes per dimension. */
  dimension?: number
  /** Documents inserted between size checks. */
  batchSize?: number
  onProgress?: (p: { documents: number; bytes: number; elapsedMs: number }) => void
}

/**
 * Build a real scope-store SQLite file and keep appending documents until it
 * reaches targetBytes. This is the benchmark's fixture: an actual sqlite-vec
 * index plus an actual FTS5 index over actual text, not a random byte buffer.
 *
 * Unlike the Memvid corpus this replaced, size grows linearly with document
 * count, so bytes-per-document is a stable, meaningful figure.
 */
export async function buildCorpus(opts: BuildCorpusOptions): Promise<CorpusResult> {
  const { path, targetBytes } = opts
  const wordsPerFrame = opts.wordsPerFrame ?? 320
  const dimension = opts.dimension ?? 1536
  const batchSize = opts.batchSize ?? 100

  const provider = benchProvider(dimension)
  const started = performance.now()
  const store = openScopeStore(path, { provider, create: true })

  let documents = 0
  let bytes = 0
  try {
    for (;;) {
      const texts = Array.from({ length: batchSize }, (_, i) => frameText(documents + i, wordsPerFrame))
      const vectors = await provider.embed(texts, 'document')
      for (let i = 0; i < texts.length; i++) {
        insertDocument(store, {
          title: `frame ${documents + i}`,
          text: texts[i]!,
          sourceType: 'note',
          createdBy: 'bench',
          meta: { app: 'greppa', bench_index: documents + i },
          chunks: [{ text: texts[i]!, embedding: vectors[i]! }],
        })
      }
      documents += batchSize
      bytes = (await stat(path)).size
      opts.onProgress?.({ documents, bytes, elapsedMs: performance.now() - started })
      if (bytes >= targetBytes) break
    }
  } finally {
    store.close()
  }

  const buildMs = performance.now() - started
  bytes = (await stat(path)).size
  return { path, bytes, documents, buildMs, wordsPerFrame, dimension }
}

// ---------------------------------------------------------------------------
// formatting
// ---------------------------------------------------------------------------

export const mib = (bytes: number): string => (bytes / MiB).toFixed(2)
export const ms = (v: number): string => v.toFixed(0)
export const secs = (v: number): string => (v / 1000).toFixed(2)

/** MiB/s for a transfer of `bytes` that took `elapsedMs`. */
export const rate = (bytes: number, elapsedMs: number): string =>
  elapsedMs <= 0 ? 'n/a' : (bytes / MiB / (elapsedMs / 1000)).toFixed(1)

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return Number.NaN
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[idx]!
}
