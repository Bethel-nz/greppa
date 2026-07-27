/**
 * Live scope-store suite. Real Cloudflare R2, real SQLite + sqlite-vec, no mocks.
 *
 *   CHECKPOINT_LIVE_R2=1 bun test tests/live
 *
 * Uses the deterministic embedding provider on purpose: this suite is about the
 * storage integration — that a SQLite file survives Checkpoint's hydrate, seal,
 * upload and conflict-rerun paths — not about retrieval quality, which is
 * covered offline. Skipped entirely without CHECKPOINT_LIVE_R2=1.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Checkpoint } from '~/utils/checkpoint/checkpoint'
import { createDeterministicProvider } from '~/lib/memory/embedding/deterministic'
import { hybridSearch, insertDocument, openScopeStore } from '~/lib/memory/scope-store/store'
import { putAssetIfAbsent, getAsset } from '~/lib/memory/assets'
import type { R2Storage } from '~/utils/r2'
import { LIVE, liveStorage, purgePrefix, runPrefix } from './support'

const TIMEOUT_MS = 300_000
const dirs: string[] = []

/** sha256 of a file, streamed — never materializes the file in the JS heap. */
async function fileHash(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

describe.skipIf(!LIVE)('scope store (live R2)', () => {
  let storage: R2Storage
  let prefix: string
  const provider = createDeterministicProvider(256)

  beforeAll(() => {
    storage = liveStorage()
    prefix = runPrefix('scope-store')
  })

  afterAll(async () => {
    await purgePrefix(storage, prefix)
    while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true })
  })

  const scratch = async (label: string) => {
    const d = await mkdtemp(join(tmpdir(), `live-${label}-`))
    dirs.push(d)
    return d
  }

  const write = (cp: Checkpoint, key: string, title: string, text: string) =>
    cp.write(key, async (path, exists) => {
      const [embedding] = await provider.embed([text], 'document')
      const store = openScopeStore(path, { provider, create: !exists })
      try {
        return insertDocument(store, {
          title,
          text,
          sourceType: 'note',
          createdBy: 'u1',
          chunks: [{ text, embedding: embedding! }],
        })
      } finally {
        store.close()
      }
    })

  test(
    'writes a scope through Checkpoint and reads it back from a cold instance',
    async () => {
      const key = `${prefix}scope-a/memory.sqlite`
      const cpA = new Checkpoint({ storage, cacheDir: await scratch('a'), maxOpen: 8, idleMs: 300_000 })

      await write(cpA, key, 'pets', 'the domestic cat is a carnivorous mammal')
      await write(cpA, key, 'finance', 'quarterly revenue invoice reconciliation')

      // A cold instance proves the bytes survived the R2 round trip and that a
      // SQLite file is still a valid database after hydration.
      const cpB = new Checkpoint({ storage, cacheDir: await scratch('b'), maxOpen: 8, idleMs: 300_000 })
      const [qv] = await provider.embed(['carnivorous mammal'], 'query')
      const hits = await cpB.read(key, async (path) => {
        const store = openScopeStore(path, { provider, create: false, readonly: true })
        try {
          return hybridSearch(store, 'carnivorous mammal', qv!, 5)
        } finally {
          store.close()
        }
      })
      expect(hits.length).toBeGreaterThan(0)
      expect(hits[0]!.title).toBe('pets')

      await cpA.closeAll()
      await cpB.closeAll()
    },
    TIMEOUT_MS,
  )

  test(
    'two instances writing from the same ETag: one reruns, both documents survive',
    async () => {
      const key = `${prefix}scope-b/memory.sqlite`
      const cfg = { storage, maxOpen: 8, idleMs: 300_000 }
      const cpA = new Checkpoint({ ...cfg, cacheDir: await scratch('c1') })
      const cpB = new Checkpoint({ ...cfg, cacheDir: await scratch('c2') })

      await write(cpA, key, 'seed', 'seed document for the conflict test')
      await cpB.read(key, async () => undefined)

      let attempts = 0
      const append = (marker: string) => async (path: string, exists: boolean) => {
        attempts++
        const [v] = await provider.embed([marker], 'document')
        const store = openScopeStore(path, { provider, create: !exists })
        try {
          insertDocument(store, {
            title: marker,
            text: marker,
            sourceType: 'note',
            createdBy: 'u1',
            chunks: [{ text: marker, embedding: v! }],
          })
        } finally {
          store.close()
        }
      }

      await Promise.all([cpA.write(key, append('alphamarker')), cpB.write(key, append('betamarker'))])

      // Exactly one writer lost the compare-and-set and reran against a freshly
      // hydrated SQLite file. This is the property the whole design rests on.
      expect(attempts).toBe(3)

      const cpC = new Checkpoint({ ...cfg, cacheDir: await scratch('c3') })
      const titles = await cpC.read(key, async (path) => {
        const store = openScopeStore(path, { provider, create: false, readonly: true })
        try {
          return (store.db.prepare('select title from documents').all() as Array<{ title: string }>).map(
            (r) => r.title,
          )
        } finally {
          store.close()
        }
      })
      expect(titles).toContain('alphamarker')
      expect(titles).toContain('betamarker')
      expect(titles).toContain('seed')

      await Promise.all([cpA.closeAll(), cpB.closeAll(), cpC.closeAll()])
    },
    TIMEOUT_MS,
  )

  test(
    'a scope file survives the R2 round trip byte-for-byte',
    async () => {
      const key = `${prefix}scope-hash/memory.sqlite`
      const cp = new Checkpoint({ storage, cacheDir: await scratch('hash'), maxOpen: 8, idleMs: 300_000 })
      await write(cp, key, 'payload', 'bytes that must survive the round trip exactly')

      const local = await cp.read(key, async (path) => ({ path, hash: await fileHash(path) }))
      const dest = join(await scratch('hash-dl'), 'downloaded.sqlite')
      const got = await storage.getToFile(key, dest)
      expect(got).not.toBeNull()
      expect(await fileHash(dest)).toBe(local.hash)

      await cp.closeAll()
    },
    TIMEOUT_MS,
  )

  test(
    'content-addressed assets round-trip and deduplicate',
    async () => {
      const scopeId = `${prefix}assets-scope`
      const bytes = new TextEncoder().encode('pretend this is a screenshot')
      const digest = await putAssetIfAbsent(storage, scopeId, bytes)
      const again = await putAssetIfAbsent(storage, scopeId, bytes)
      expect(again).toBe(digest)

      const fetched = await getAsset(storage, scopeId, digest)
      expect(new TextDecoder().decode(fetched!)).toBe('pretend this is a screenshot')
      expect((await storage.list(`scopes/${scopeId}/assets/`)).length).toBe(1)
    },
    TIMEOUT_MS,
  )

  test(
    'a long read keeps its generation while a concurrent write publishes a new one',
    async () => {
      const key = `${prefix}scope-c/memory.sqlite`
      const dir = await scratch('concurrent')
      const cp = new Checkpoint({ storage, cacheDir: dir, maxOpen: 8, idleMs: 300_000 })
      await write(cp, key, 'v1', 'original generation payload')

      let release!: () => void
      const gate = new Promise<void>((r) => (release = r))
      const sizes: number[] = []

      const reading = cp.read(key, async (path) => {
        sizes.push((await stat(path)).size)
        await gate
        sizes.push((await stat(path)).size)
        const store = openScopeStore(path, { provider, create: false, readonly: true })
        try {
          return (store.db.prepare('select count(*) as n from documents').get() as { n: number }).n
        } finally {
          store.close()
        }
      })

      await new Promise((r) => setTimeout(r, 50))
      await write(cp, key, 'v2', 'second generation payload')
      release()

      // The reader saw one immutable file throughout, unaffected by the writer.
      expect(await reading).toBe(1)
      expect(sizes[0]).toBe(sizes[1]!)

      await cp.closeAll()
    },
    TIMEOUT_MS,
  )

  test(
    'every object this run created is removed',
    async () => {
      await purgePrefix(storage, prefix)
      await purgePrefix(storage, `scopes/${prefix}`)
      expect(await storage.list(prefix)).toEqual([])
    },
    TIMEOUT_MS,
  )
})
