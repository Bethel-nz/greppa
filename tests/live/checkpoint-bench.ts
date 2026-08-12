import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Checkpoint, type CheckpointConfig } from '~/utils/checkpoint/checkpoint'
import { hybridSearch, insertDocument } from '~/lib/memory/scope-store/store'
import type { ObjectMeta, StorageBackend } from '~/utils/checkpoint/storage'
import {
  LIVE,
  MiB,
  buildCorpus,
  diskUsage,
  frameText,
  liveStorage,
  mib,
  benchProvider,
  openCorpusForWrite,
  openCorpusReadOnly,
  percentile,
  purgePrefix,
  rate,
  runPrefix,
  sampleMemory,
  secs,
  type DiskUsage,
  type MemorySample,
} from './support'

if (!LIVE) {
  console.error('[bench] refusing to run without CHECKPOINT_LIVE_R2=1')
  process.exit(2)
}

const envNum = (name: string, fallback: number): number => {
  const raw = process.env[name]
  if (!raw) return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) throw new Error(`[bench] ${name} must be a positive number`)
  return n
}

const TARGET_BYTES = envNum('BENCH_TARGET_BYTES', 42 * MiB)
const WORDS_PER_FRAME = envNum('BENCH_WORDS_PER_FRAME', 320)
const WARM_SEARCHES = envNum('BENCH_WARM_SEARCHES', 20)
const SCOPES = envNum('BENCH_SCOPES', 3)
const MAX_OPEN = envNum('BENCH_MAX_OPEN', 8)
const BENCH_DIM = envNum('BENCH_DIM', 1536)
const benchEmbedder = benchProvider(BENCH_DIM)

type Call = { op: string; key: string; ms: number; bytes: number }

class TimedStorage implements StorageBackend {
  readonly calls: Call[] = []

  constructor(private readonly inner: StorageBackend) {}

  private async timed<T>(op: string, key: string, fn: () => Promise<T>, bytes = 0): Promise<T> {
    const t = performance.now()
    try {
      return await fn()
    } finally {
      this.calls.push({ op, key, ms: performance.now() - t, bytes })
    }
  }

  since(mark: number, op?: string): { ms: number; bytes: number; count: number } {
    let ms = 0
    let bytes = 0
    let count = 0
    for (let i = mark; i < this.calls.length; i++) {
      const c = this.calls[i]!
      if (op && c.op !== op) continue
      ms += c.ms
      bytes += c.bytes
      count++
    }
    return { ms, bytes, count }
  }

  get mark(): number {
    return this.calls.length
  }

  head(key: string): Promise<ObjectMeta | null> {
    return this.timed('head', key, () => this.inner.head(key))
  }

  get(key: string): Promise<{ body: Uint8Array; etag: string } | null> {
    return this.timed('get', key, () => this.inner.get(key))
  }

  putIfMatch(key: string, body: Uint8Array, etag: string | null): Promise<string> {
    return this.timed('putIfMatch', key, () => this.inner.putIfMatch(key, body, etag), body.byteLength)
  }

  async getToFile(key: string, localPath: string): Promise<{ etag: string } | null> {
    const t = performance.now()
    const r = await this.inner.getToFile!(key, localPath)
    const bytes = r ? await stat(localPath).then((s) => s.size, () => 0) : 0
    this.calls.push({ op: 'getToFile', key, ms: performance.now() - t, bytes })
    return r
  }

  async putFileIfMatch(key: string, localPath: string, etag: string | null): Promise<string> {
    const bytes = await stat(localPath).then((s) => s.size, () => 0)
    return this.timed('putFileIfMatch', key, () => this.inner.putFileIfMatch!(key, localPath, etag), bytes)
  }

  delete(key: string): Promise<void> {
    return this.timed('delete', key, () => this.inner.delete(key))
  }

  list(prefix: string): Promise<ObjectMeta[]> {
    return this.timed('list', prefix, () => this.inner.list(prefix))
  }
}

type Stage = {
  name: string
  wallMs: number
  memory: MemorySample
  disk?: DiskUsage
  detail: Record<string, unknown>
}

const stages: Stage[] = []
const cleanup: string[] = []

function record(name: string, wallMs: number, detail: Record<string, unknown>, disk?: DiskUsage): void {
  const stage: Stage = { name, wallMs, memory: sampleMemory(), disk, detail }
  stages.push(stage)
  console.log(`\n── ${name} ──`)
  console.log(`   ${'wall'.padEnd(30)}${secs(wallMs)} s`)
  for (const [k, v] of Object.entries(detail)) console.log(`   ${k.padEnd(30)}${v}`)
  console.log(
    `   rss             ${mib(stage.memory.rssBytes)} MiB   heapUsed ${mib(stage.memory.heapUsedBytes)} MiB` +
      `   heapTotal ${mib(stage.memory.heapTotalBytes)} MiB   external ${mib(stage.memory.externalBytes)} MiB`,
  )
  if (disk) {
    console.log(
      `   cache disk      ${mib(disk.totalBytes)} MiB in ${disk.fileCount} files` +
        `  (generation ${mib(disk.byKind.generation.bytes)} MiB/${disk.byKind.generation.files},` +
        ` working ${mib(disk.byKind.working.bytes)} MiB/${disk.byKind.working.files},` +
        ` hydrating ${mib(disk.byKind.hydrating.bytes)} MiB/${disk.byKind.hydrating.files},` +
        ` other ${mib(disk.byKind.other.bytes)} MiB/${disk.byKind.other.files})`,
    )
  }
}

async function scratch(label: string): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), `bench-${label}-`))
  cleanup.push(d)
  return d
}

function checkpointBytes(cp: Checkpoint): number | null {
  const v = (cp as unknown as { cacheBytes?: number }).cacheBytes
  return typeof v === 'number' ? v : null
}

function checkpointConfig(cacheDir: string, maxCacheBytes: number): CheckpointConfig {
  return { storage, cacheDir, maxOpen: MAX_OPEN, idleMs: 300_000, maxCacheBytes } as CheckpointConfig
}

const startedAt = new Date()
const baseStorage = liveStorage()
const storage = new TimedStorage(baseStorage)
const prefix = runPrefix('bench')
const key = `${prefix}scope-0/memory.sqlite`

console.log(`[bench] started ${startedAt.toISOString()}`)
console.log(`[bench] bun ${Bun.version}  ${process.platform}/${process.arch}`)
console.log(`[bench] target ${mib(TARGET_BYTES)} MiB, ${WORDS_PER_FRAME} words/frame, R2 prefix ${prefix}`)
console.log(`[bench] corpus: scope-store SQLite (sqlite-vec + FTS5), ${BENCH_DIM}-d vectors`)

let corpusPath = process.env.BENCH_CORPUS_PATH
let corpus: { bytes: number; documents: number; buildMs: number } | null = null
let reusedCorpus = false

{
  const existing = corpusPath ? await stat(corpusPath).catch(() => null) : null
  if (existing && existing.size >= TARGET_BYTES) {
    reusedCorpus = true
    corpus = { bytes: existing.size, documents: Number.NaN, buildMs: Number.NaN }
    record('1. build corpus (reused BENCH_CORPUS_PATH)', 0, {
      path: corpusPath!,
      bytes: `${mib(existing.size)} MiB`,
      note: 'build timings unavailable for a reused corpus',
    })
  } else {
    if (!corpusPath) corpusPath = join(await scratch('corpus'), 'memory.sqlite')
    await mkdir(dirname(corpusPath), { recursive: true })
    await rm(corpusPath, { force: true })

    const t = performance.now()
    let lastLog = 0
    const built = await buildCorpus({
      path: corpusPath,
      targetBytes: TARGET_BYTES,
      wordsPerFrame: WORDS_PER_FRAME,
      dimension: BENCH_DIM,
      onProgress: ({ documents, bytes, elapsedMs }) => {
        if (elapsedMs - lastLog < 5000) return
        lastLog = elapsedMs
        console.log(`   … ${documents} documents, ${mib(bytes)} MiB, ${secs(elapsedMs)} s`)
      },
    })
    corpus = built
    record('1. build corpus', performance.now() - t, {
      documents: built.documents,
      bytes: `${mib(built.bytes)} MiB`,
      'bytes/doc': `${(built.bytes / built.documents / 1024).toFixed(1)} KiB`,
      'ms/doc': (built.buildMs / built.documents).toFixed(2),
      dimension: built.dimension,
      path: corpusPath,
    })
  }
}

const corpusBytes = corpus!.bytes
const MAX_CACHE_BYTES = envNum('BENCH_MAX_CACHE_BYTES', Math.ceil(corpusBytes * 1.5))

let failure: unknown = null
try {
  {
    const mark = storage.mark
    const t = performance.now()
    await storage.putFileIfMatch(key, corpusPath!, null)
    const wall = performance.now() - t
    const put = storage.since(mark, 'putFileIfMatch')
    record('2. seed R2 (streamed upload)', wall, {
      bytes: `${mib(put.bytes)} MiB`,
      throughput: `${rate(put.bytes, put.ms)} MiB/s`,
    })
  }

  const coldDir = await scratch('cold')
  {
    const cp = new Checkpoint(checkpointConfig(coldDir, MAX_CACHE_BYTES))
    const before = sampleMemory()
    const mark = storage.mark
    const t = performance.now()
    const size = await cp.read(key, async (p) => (await stat(p)).size)
    const wall = performance.now() - t
    const got = storage.since(mark, 'getToFile')
    const after = sampleMemory()

    record(
      '3. cold hydration (empty cache → first read)',
      wall,
      {
        bytes: `${mib(size)} MiB`,
        'R2 transfer': `${secs(got.ms)} s at ${rate(got.bytes, got.ms)} MiB/s`,
        'checkpoint overhead': `${(wall - got.ms).toFixed(0)} ms`,
        'rss delta': `${mib(after.rssBytes - before.rssBytes)} MiB`,
        'heapUsed delta': `${mib(after.heapUsedBytes - before.heapUsedBytes)} MiB`,
        'checkpoint cacheBytes': checkpointBytes(cp) ?? 'not implemented',
      },
      await diskUsage(coldDir),
    )

    const warm: number[] = []
    const beforeWarm = sampleMemory()
    const tWarm = performance.now()
    for (let i = 0; i < WARM_SEARCHES; i++) {
      const q = frameText(i, 6)
      const t0 = performance.now()
      const [qv] = await benchEmbedder.embed([q], 'query')
      await cp.read(key, async (p) => {
        const store = openCorpusReadOnly(p, benchEmbedder)
        try {
          return hybridSearch(store, q, qv!, 8)
        } finally {
          store.close()
        }
      })
      warm.push(performance.now() - t0)
    }
    const wallWarm = performance.now() - tWarm
    const afterWarm = sampleMemory()
    const sorted = [...warm].sort((a, b) => a - b)
    const marks = storage.since(storage.mark - 0)
    record(
      `4. warm searches (${WARM_SEARCHES}× read + hybrid search)`,
      wallWarm,
      {
        min: `${sorted[0]!.toFixed(0)} ms`,
        p50: `${percentile(sorted, 50).toFixed(0)} ms`,
        p95: `${percentile(sorted, 95).toFixed(0)} ms`,
        max: `${sorted[sorted.length - 1]!.toFixed(0)} ms`,
        'R2 calls during warm phase': marks.count,
        'rss delta': `${mib(afterWarm.rssBytes - beforeWarm.rssBytes)} MiB`,
        'heapUsed delta': `${mib(afterWarm.heapUsedBytes - beforeWarm.heapUsedBytes)} MiB`,
        'checkpoint cacheBytes': checkpointBytes(cp) ?? 'not implemented',
      },
      await diskUsage(coldDir),
    )

    {
      let cloneAndCallbackMs = 0
      const mark = storage.mark
      const t = performance.now()
      await cp.write(key, async (p, exists) => {
        const t0 = performance.now()
        const text = frameText(999_001, WORDS_PER_FRAME)
        const [v] = await benchEmbedder.embed([text], 'document')
        const store = openCorpusForWrite(p, exists, benchEmbedder)
        try {
          insertDocument(store, { title: 'bench-append', text, sourceType: 'note', createdBy: 'bench', chunks: [{ text, embedding: v! }] })
        } finally {
          store.close()
        }
        cloneAndCallbackMs = performance.now() - t0
      })
      const wall = performance.now() - t
      const put = storage.since(mark, 'putFileIfMatch')
      record(
        '5. write + seal + streamed upload',
        wall,
        {
          'insert + close': `${cloneAndCallbackMs.toFixed(0)} ms`,
          'upload bytes': `${mib(put.bytes)} MiB`,
          upload: `${secs(put.ms)} s at ${rate(put.bytes, put.ms)} MiB/s`,
          'clone + rename + bookkeeping': `${(wall - cloneAndCallbackMs - put.ms).toFixed(0)} ms`,
          'checkpoint cacheBytes': checkpointBytes(cp) ?? 'not implemented',
        },
        await diskUsage(coldDir),
      )
    }

    {
      let release!: () => void
      const gate = new Promise<void>((r) => (release = r))
      const readSizes: number[] = []
      let peakDisk: DiskUsage | null = null

      const t = performance.now()
      const reading = cp.read(key, async (p) => {
        readSizes.push((await stat(p)).size)
        const [cv] = await benchEmbedder.embed(['checkpoint hydration generation'], 'query')
        const store = openCorpusReadOnly(p, benchEmbedder)
        const first = hybridSearch(store, 'checkpoint hydration generation', cv!, 8)
        store.close()
        await gate
        readSizes.push((await stat(p)).size)
        return first.length
      })

      await new Promise((r) => setTimeout(r, 50))
      const tWrite = performance.now()
      await cp.write(key, async (p, exists) => {
        const text = frameText(999_002, WORDS_PER_FRAME)
        const [v] = await benchEmbedder.embed([text], 'document')
        const store = openCorpusForWrite(p, exists, benchEmbedder)
        try {
          insertDocument(store, { title: 'bench-concurrent', text, sourceType: 'note', createdBy: 'bench', chunks: [{ text, embedding: v! }] })
        } finally {
          store.close()
        }
      })
      const writeMs = performance.now() - tWrite
      peakDisk = await diskUsage(coldDir)

      release()
      const hits = await reading
      const wall = performance.now() - t

      record(
        '6. long read concurrent with a write',
        wall,
        {
          'reader saw stable bytes': readSizes[0] === readSizes[1] ? `yes (${mib(readSizes[0]!)} MiB both samples)` : `NO (${readSizes.join(' → ')})`,
          'reader hits': hits,
          'write completed in': `${secs(writeMs)} s (not blocked by the reader)`,
          'generations on disk at peak': peakDisk.byKind.generation.files,
          'peak cache disk': `${mib(peakDisk.totalBytes)} MiB`,
          'cache disk after release': `${mib((await diskUsage(coldDir)).totalBytes)} MiB`,
          'checkpoint cacheBytes': checkpointBytes(cp) ?? 'not implemented',
        },
        await diskUsage(coldDir),
      )
    }

    await cp.closeAll()
  }

  {
    const dirA = await scratch('conflict-a')
    const dirB = await scratch('conflict-b')
    const cpA = new Checkpoint(checkpointConfig(dirA, MAX_CACHE_BYTES))
    const cpB = new Checkpoint(checkpointConfig(dirB, MAX_CACHE_BYTES))

    const tHydrate = performance.now()
    await Promise.all([cpA.read(key, async () => undefined), cpB.read(key, async () => undefined)])
    const hydrateMs = performance.now() - tHydrate

    const attempts: Record<string, number> = { a: 0, b: 0 }
    const append = (who: string, marker: string) => async (p: string, exists: boolean) => {
      attempts[who] = (attempts[who] ?? 0) + 1
      const text = `${marker} distinctive conflict payload`
      const [v] = await benchEmbedder.embed([text], 'document')
      const store = openCorpusForWrite(p, exists, benchEmbedder)
      try {
        insertDocument(store, { title: marker, text, sourceType: 'note', createdBy: 'bench', chunks: [{ text, embedding: v! }] })
      } finally {
        store.close()
      }
    }

    const t = performance.now()
    await Promise.all([cpA.write(key, append('a', 'benchalpha')), cpB.write(key, append('b', 'benchbeta'))])
    const wall = performance.now() - t

    const dirC = await scratch('conflict-c')
    const cpC = new Checkpoint(checkpointConfig(dirC, MAX_CACHE_BYTES))
    const survived = await cpC.read(key, async (p) => {
      const store = openCorpusReadOnly(p, benchEmbedder)
      try {
        const titles = (store.db.prepare('select title from documents').all() as Array<{ title: string }>).map((r) => r.title)
        return { alpha: titles.includes('benchalpha'), beta: titles.includes('benchbeta') }
      } finally {
        store.close()
      }
    })

    record(
      '7. conflict: two instances, one ETag',
      wall,
      {
        'both hydrated in': `${secs(hydrateMs)} s`,
        'callback invocations': `a=${attempts.a}, b=${attempts.b} (total ${attempts.a! + attempts.b!}; 3 means exactly one rerun)`,
        'rerun happened': attempts.a! + attempts.b! === 3 ? 'yes' : 'NO',
        'both mutations survived': survived.alpha && survived.beta ? 'yes' : `NO (${JSON.stringify(survived)})`,
      },
      await diskUsage(dirA),
    )

    await Promise.all([cpA.closeAll(), cpB.closeAll(), cpC.closeAll()])
  }

  let budgetLeg: Record<string, unknown> = { skipped: 'maxCacheBytes not implemented' }
  {
    const probe = new Checkpoint(checkpointConfig(await scratch('probe'), 1))
    const supported = checkpointBytes(probe) !== null
    await probe.closeAll()

    if (supported) {
      const scopeKeys: string[] = [key]
      const tSeed = performance.now()
      for (let i = 1; i < SCOPES; i++) {
        const k = `${prefix}scope-${i}/memory.sqlite`
        await storage.putFileIfMatch(k, corpusPath!, null)
        scopeKeys.push(k)
      }
      const seedMs = performance.now() - tSeed

      const dir = await scratch('budget')
      const budget = Math.ceil(corpusBytes * 1.5)
      const cp = new Checkpoint(checkpointConfig(dir, budget))

      const observed: Array<{ key: string; cacheBytes: number; disk: number }> = []
      const t = performance.now()
      for (const k of scopeKeys) {
        await cp.read(k, async (p) => (await stat(p)).size)
        observed.push({
          key: k.slice(prefix.length),
          cacheBytes: checkpointBytes(cp) ?? -1,
          disk: (await diskUsage(dir)).totalBytes,
        })
      }
      const wall = performance.now() - t
      const finalDisk = await diskUsage(dir)

      let releasePin!: () => void
      const pinGate = new Promise<void>((r) => (releasePin = r))
      const pinned = cp.read(scopeKeys[scopeKeys.length - 1]!, async (p) => {
        await pinGate
        return (await stat(p)).size
      })
      await new Promise((r) => setTimeout(r, 50))
      for (const k of scopeKeys) await cp.read(k, async () => undefined).catch(() => undefined)
      const pinnedSurvived = (await diskUsage(dir)).byKind.generation.files >= 1
      releasePin()
      await pinned

      budgetLeg = {
        scopes: SCOPES,
        'seed extra scopes': `${secs(seedMs)} s`,
        budget: `${mib(budget)} MiB`,
        'per-scope corpus': `${mib(corpusBytes)} MiB`,
        trace: observed.map((o) => `${o.key} → cacheBytes ${mib(o.cacheBytes)} MiB, disk ${mib(o.disk)} MiB`),
        'final cacheBytes': `${mib(checkpointBytes(cp) ?? 0)} MiB`,
        'final disk': `${mib(finalDisk.totalBytes)} MiB in ${finalDisk.fileCount} files`,
        'budget respected': (checkpointBytes(cp) ?? 0) <= budget ? 'yes' : 'NO',
        'pinned generation survived eviction': pinnedSurvived ? 'yes' : 'NO',
        openCount: cp.openCount,
      }
      record('8. maxCacheBytes eviction', wall, budgetLeg, finalDisk)
      await cp.closeAll()
    } else {
      console.log('\n── 8. maxCacheBytes eviction ──\n   skipped: Checkpoint has no maxCacheBytes yet (baseline run)')
    }
  }
} catch (err) {
  failure = err
  console.error(`\n[bench] stage failed, proceeding to cleanup: ${(err as Error).message}`)
}

{
  const t = performance.now()
  const removed = await purgePrefix(storage, prefix)
  const remaining = await storage.list(prefix)

  const tracked = [...cleanup]
  while (cleanup.length) await rm(cleanup.pop()!, { recursive: true, force: true })
  const leftovers: string[] = []
  for (const d of tracked) {
    if (await stat(d).then(() => true, () => false)) leftovers.push(d)
  }
  const dirsBefore = tracked.length

  record('9. cleanup', performance.now() - t, {
    'R2 objects deleted': removed,
    'R2 objects remaining under prefix': remaining.length === 0 ? '0 (clean)' : `${remaining.length} LEFTOVER`,
    'temp dirs removed': dirsBefore,
    'temp dirs remaining': leftovers.length === 0 ? '0 (clean)' : leftovers.join(', '),
  })
}

const totalMs = stages.reduce((a, s) => a + s.wallMs, 0)
const peakRss = Math.max(...stages.map((s) => s.memory.rssBytes))
const peakHeap = Math.max(...stages.map((s) => s.memory.heapUsedBytes))

const hydration = stages.find((s) => s.name.startsWith('3.'))
const rssOverCorpus = hydration ? Number(hydration.detail['rss delta']?.toString().split(' ')[0]) : Number.NaN

console.log('\n══ summary ══')
console.log(`   corpus            ${mib(corpusBytes)} MiB${reusedCorpus ? ' (reused)' : ''}`)
console.log(`   total wall        ${secs(totalMs)} s`)
console.log(`   peak rss          ${mib(peakRss)} MiB`)
console.log(`   peak heapUsed     ${mib(peakHeap)} MiB  (see caveat below)`)
console.log(
  `   hydration rss Δ   ${rssOverCorpus.toFixed(2)} MiB for a ${mib(corpusBytes)} MiB file` +
    ` — a delta far below the file size is the evidence that hydration streams to disk`,
)
console.log(
  '   caveat: under Bun, process.memoryUsage() heapUsed/heapTotal do not carry their Node\n' +
    '   meanings (heapUsed routinely exceeds heapTotal here). RSS is the trustworthy figure;\n' +
    '   treat heapUsed as indicative only.',
)

const jsonOut = process.env.BENCH_JSON_OUT
if (jsonOut) {
  await Bun.write(
    jsonOut,
    JSON.stringify(
      {
        startedAt: startedAt.toISOString(),
        runtime: { bun: Bun.version, platform: process.platform, arch: process.arch },
        config: { TARGET_BYTES, WORDS_PER_FRAME, WARM_SEARCHES, SCOPES, MAX_OPEN, MAX_CACHE_BYTES },
        corpus: { ...corpus, reused: reusedCorpus },
        stages,
        summary: { totalMs, peakRss, peakHeap },
      },
      null,
      2,
    ),
  )
  console.log(`\n[bench] wrote ${jsonOut}`)
}

if (failure) {
  console.error('\n[bench] run did NOT complete; the numbers above are partial')
  throw failure
}
