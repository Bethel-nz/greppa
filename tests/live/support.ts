import { existsSync, readFileSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { R2Storage } from '~/utils/r2'
import type { StorageBackend } from '~/utils/checkpoint/storage'
import { createDeterministicProvider } from '~/lib/memory/embedding/deterministic'
import type { EmbeddingProvider } from '~/lib/memory/embedding/provider'
import { insertDocument, openScopeStore, type ScopeStore } from '~/lib/memory/scope-store/store'

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

export function runPrefix(label: string): string {
  return `_live/${label}/${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}/`
}

export async function purgePrefix(storage: StorageBackend, prefix: string): Promise<number> {
  const objects = await storage.list(prefix)
  for (const o of objects) await storage.delete(o.key)
  return objects.length
}

export type MemorySample = {
  rssBytes: number
  heapUsedBytes: number
  heapTotalBytes: number
  externalBytes: number
}

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
      return 
    }
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDirectory()) {
        await walk(p)
        continue
      }
      const s = await stat(p).catch(() => null)
      if (!s) continue 
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

const VOCAB =
  `alpha beta gamma delta epsilon zeta eta theta iota kappa lambda sigma tau
   deploy rollback latency throughput checkpoint hydration generation etag bucket
   invoice contract renewal quarterly forecast pipeline retention churn cohort
   migration schema index vector lexical segment compaction tombstone frame scope`
    .split(/\s+/)
    .filter(Boolean)

export function frameText(index: number, words: number): string {
  let seed = (index * 2_654_435_761) >>> 0
  const out: string[] = []
  for (let i = 0; i < words; i++) {
    seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0
    out.push(VOCAB[seed % VOCAB.length]!)
  }
  return out.join(' ')
}

export const benchProvider = (dimension = 1536): EmbeddingProvider => createDeterministicProvider(dimension)

export function openCorpusReadOnly(localPath: string, provider: EmbeddingProvider): ScopeStore {
  return openScopeStore(localPath, { provider, create: false, readonly: true })
}

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
  dimension?: number
  batchSize?: number
  onProgress?: (p: { documents: number; bytes: number; elapsedMs: number }) => void
}

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

export const mib = (bytes: number): string => (bytes / MiB).toFixed(2)
export const ms = (v: number): string => v.toFixed(0)
export const secs = (v: number): string => (v / 1000).toFixed(2)

export const rate = (bytes: number, elapsedMs: number): string =>
  elapsedMs <= 0 ? 'n/a' : (bytes / MiB / (elapsedMs / 1000)).toFixed(1)

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return Number.NaN
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[idx]!
}
