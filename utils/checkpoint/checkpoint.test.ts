import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Checkpoint } from './checkpoint'
import { ConflictError, NotFoundError } from './errors'
import { MemoryStorage, type StorageBackend } from './storage'

const dec = new TextDecoder()
const enc = new TextEncoder()
const dirs: string[] = []

// The storage layer is scope-agnostic: callers pass a full object key. Tests use
// a stable per-"user" key to mirror real usage (scopes/{id}/memory.sqlite).
const K = (id: string) => `users/${id}/memory.sqlite`

async function cacheDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'checkpoint-'))
  dirs.push(d)
  return d
}

afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true })
})

describe('Checkpoint', () => {
  test('read on a missing object throws NotFoundError', async () => {
    const cp = new Checkpoint({ storage: new MemoryStorage(), cacheDir: await cacheDir(), maxOpen: 8, idleMs: 1000 })
    await expect(cp.read(K('u1'), async () => 'x')).rejects.toBeInstanceOf(NotFoundError)
  })

  test('write creates + uploads; a later read reuses the cache (no re-download)', async () => {
    const storage = new MemoryStorage()
    const cp = new Checkpoint({ storage, cacheDir: await cacheDir(), maxOpen: 8, idleMs: 1000 })

    await cp.write(K('u1'), async (p) => writeFile(p, enc.encode('hello')))
    expect(storage.counts.put).toBe(1)

    const getsBefore = storage.counts.get
    const a = await cp.read(K('u1'), async (p) => ({ path: p, value: dec.decode(await readFile(p)) }))
    const b = await cp.read(K('u1'), async (p) => ({ path: p, value: dec.decode(await readFile(p)) }))
    expect(a.value).toBe('hello')
    expect(b.value).toBe('hello')
    expect(a.path).toBe(b.path)
    expect(a.path).not.toContain('.rd-')
    expect(storage.counts.get).toBe(getsBefore)
  })

  test('write signals exists=false for a new object and true once it has been written', async () => {
    const cp = new Checkpoint({ storage: new MemoryStorage(), cacheDir: await cacheDir(), maxOpen: 8, idleMs: 1000 })
    const seen: boolean[] = []

    await cp.write(K('u1'), async (p, exists) => {
      seen.push(exists)
      await writeFile(p, enc.encode('one'))
    })
    await cp.write(K('u1'), async (p, exists) => {
      seen.push(exists)
      await writeFile(p, enc.encode('two'))
    })

    expect(seen).toEqual([false, true])
  })

  test('a new object never leaves an invalid empty local file behind', async () => {
    const storage = new MemoryStorage()
    const cp = new Checkpoint({ storage, cacheDir: await cacheDir(), maxOpen: 8, idleMs: 1000 })

    // Callback that writes nothing must surface as an error (no 0-byte upload of a
    // "created" file the way the old pre-create path would have allowed).
    await expect(cp.write(K('u1'), async () => {})).rejects.toBeTruthy()
    expect(storage.counts.put).toBe(0)
  })

  test('read operates on an isolated snapshot; a concurrent write does not tear it', async () => {
    const cp = new Checkpoint({ storage: new MemoryStorage(), cacheDir: await cacheDir(), maxOpen: 8, idleMs: 1000 })
    await cp.write(K('u1'), async (p) => writeFile(p, enc.encode('v1')))

    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const seen: string[] = []

    const reading = cp.read(K('u1'), async (p) => {
      seen.push(dec.decode(await readFile(p)))
      await gate
      seen.push(dec.decode(await readFile(p)))
    })

    // Publish a new immutable generation while the read is mid-flight.
    await cp.write(K('u1'), async (p) => writeFile(p, enc.encode('v2')))
    release()
    await reading

    expect(seen).toEqual(['v1', 'v1'])
    const after = await cp.read(K('u1'), async (p) => dec.decode(await readFile(p)))
    expect(after).toBe('v2')
  })

  test('open set stays bounded across many users; evicted users re-hydrate', async () => {
    const storage = new MemoryStorage()
    const cp = new Checkpoint({ storage, cacheDir: await cacheDir(), maxOpen: 16, idleMs: 1000 })

    for (let i = 0; i < 1000; i++) {
      await cp.write(K('u' + i), async (p) => writeFile(p, enc.encode('v' + i)))
      expect(cp.openCount).toBeLessThanOrEqual(16)
    }
    const v = await cp.read(K('u0'), async (p) => dec.decode(await readFile(p)))
    expect(v).toBe('v0')
    expect(cp.openCount).toBeLessThanOrEqual(16)
  })

  test('evictIdle drops idle entries but never an in-use one', async () => {
    const storage = new MemoryStorage()
    let clock = 1000
    const cp = new Checkpoint({ storage, cacheDir: await cacheDir(), maxOpen: 8, idleMs: 100, now: () => clock })

    await cp.write(K('u1'), async (p) => writeFile(p, enc.encode('a')))
    await cp.write(K('u2'), async (p) => writeFile(p, enc.encode('b')))
    expect(cp.openCount).toBe(2)

    let active!: () => void
    const gate = new Promise<void>((r) => (active = r))
    const slow = cp.read(K('u2'), async () => {
      await gate
    })

    clock += 1000
    await cp.evictIdle()
    expect(cp.openCount).toBe(1)

    active()
    await slow
  })

  test('writes to the same object serialize; different users run in parallel', async () => {
    const storage = new MemoryStorage()
    const cp = new Checkpoint({ storage, cacheDir: await cacheDir(), maxOpen: 8, idleMs: 1000 })

    let inside = 0
    let maxConcurrent = 0
    const bump = async (p: string, exists: boolean) => {
      inside++
      maxConcurrent = Math.max(maxConcurrent, inside)
      await new Promise((r) => setTimeout(r, 5))
      const cur = exists ? Number(dec.decode(await readFile(p))) : 0
      await writeFile(p, enc.encode(String(cur + 1)))
      inside--
    }

    await cp.write(K('u1'), async (p) => writeFile(p, enc.encode('0')))
    await Promise.all([cp.write(K('u1'), bump), cp.write(K('u1'), bump), cp.write(K('u1'), bump)])
    expect(maxConcurrent).toBe(1)
    const final = await cp.read(K('u1'), async (p) => dec.decode(await readFile(p)))
    expect(final).toBe('3')

    inside = 0
    maxConcurrent = 0
    await Promise.all([cp.write(K('a'), bump), cp.write(K('b'), bump), cp.write(K('c'), bump)])
    expect(maxConcurrent).toBeGreaterThan(1)
  })

  test('etag conflict discards stale bytes, rehydrates, and reruns the mutation', async () => {
    const storage = new MemoryStorage()
    const cp = new Checkpoint({ storage, cacheDir: await cacheDir(), maxOpen: 8, idleMs: 1000 })
    await cp.write(K('u1'), async (p) => writeFile(p, enc.encode('first')))

    const key = K('u1')
    const cur = await storage.head(key)
    await storage.putIfMatch(key, enc.encode('outside'), cur!.etag)

    const bases: string[] = []
    await cp.write(K('u1'), async (p) => {
      const base = dec.decode(await readFile(p))
      bases.push(base)
      await writeFile(p, enc.encode(`${base}+mine`))
    })

    const got = await storage.get(key)
    expect(bases).toEqual(['first', 'outside'])
    expect(dec.decode(got!.body)).toBe('outside+mine')
  })

  test('a persistent conflict surfaces ConflictError', async () => {
    const base = new MemoryStorage()
    const storage: StorageBackend = {
      head: (k) => base.head(k),
      get: (k) => base.get(k),
      list: (p) => base.list(p),
      delete: (k) => base.delete(k),
      putIfMatch: async (k) => {
        throw new ConflictError(k)
      },
    }
    const cp = new Checkpoint({ storage, cacheDir: await cacheDir(), maxOpen: 8, idleMs: 1000 })
    await expect(cp.write(K('u1'), async (p) => writeFile(p, enc.encode('x')))).rejects.toBeInstanceOf(ConflictError)
  })

  test('non-404 storage errors propagate (never treated as absence)', async () => {
    const base = new MemoryStorage()
    const boom = new Error('throttled')
    const storage: StorageBackend = {
      head: (k) => base.head(k),
      get: async () => {
        throw boom
      },
      list: (p) => base.list(p),
      delete: (k) => base.delete(k),
      putIfMatch: (k, b, e) => base.putIfMatch(k, b, e),
    }
    const cp = new Checkpoint({ storage, cacheDir: await cacheDir(), maxOpen: 8, idleMs: 1000 })
    await expect(cp.read(K('u1'), async () => 'x')).rejects.toBe(boom)
  })

  test('startEviction sweeps idle entries on an interval', async () => {
    const storage = new MemoryStorage()
    let clock = 1000
    const cp = new Checkpoint({ storage, cacheDir: await cacheDir(), maxOpen: 8, idleMs: 50, now: () => clock })
    await cp.write(K('u1'), async (p) => writeFile(p, enc.encode('a')))
    expect(cp.openCount).toBe(1)

    cp.startEviction(10)
    clock += 1000
    await new Promise((r) => setTimeout(r, 40))
    cp.stopEviction()
    expect(cp.openCount).toBe(0)
  })

  test('read after a failed first write throws NotFoundError, not a raw fs error', async () => {
    const cp = new Checkpoint({ storage: new MemoryStorage(), cacheDir: await cacheDir(), maxOpen: 8, idleMs: 1000 })
    await expect(
      cp.write(K('u1'), async () => {
        throw new Error('callback boom')
      }),
    ).rejects.toThrow('callback boom')
    await expect(cp.read(K('u1'), async () => 'x')).rejects.toBeInstanceOf(NotFoundError)
  })

  test('a failed first flush leaves no partial generation and the next write starts clean', async () => {
    const base = new MemoryStorage()
    let failPuts = true
    const storage: StorageBackend = {
      head: (k) => base.head(k),
      get: (k) => base.get(k),
      list: (p) => base.list(p),
      delete: (k) => base.delete(k),
      putIfMatch: async (k, b, e) => {
        if (failPuts) throw new Error('storage down')
        return base.putIfMatch(k, b, e)
      },
    }
    const cp = new Checkpoint({ storage, cacheDir: await cacheDir(), maxOpen: 8, idleMs: 1000 })
    await expect(cp.write(K('u1'), async (p) => writeFile(p, enc.encode('lost')))).rejects.toThrow('storage down')

    failPuts = false
    const seen: Array<{ exists: boolean; leftover: string | null }> = []
    await cp.write(K('u1'), async (p, exists) => {
      const leftover = await readFile(p).then((b) => dec.decode(b), () => null)
      seen.push({ exists, leftover })
      await writeFile(p, enc.encode('fresh'))
    })
    expect(seen).toEqual([{ exists: false, leftover: null }])
    expect(dec.decode((await base.get(K('u1')))!.body)).toBe('fresh')
  })

  test('a cache file deleted out from under the checkpoint fails one read, then recovers', async () => {
    const storage = new MemoryStorage()
    let clock = 1000
    const dir = await cacheDir()
    const cp = new Checkpoint({ storage, cacheDir: dir, maxOpen: 8, idleMs: 100, now: () => clock })
    await cp.write(K('u1'), async (p) => writeFile(p, enc.encode('v1')))

    const cachedPath = await cp.read(K('u1'), async (p) => p)
    await rm(cachedPath)
    await expect(cp.read(K('u1'), async (p) => readFile(p))).rejects.toBeTruthy()

    // The failed read must not pin the entry open forever.
    clock += 1000
    await cp.evictIdle()
    expect(cp.openCount).toBe(0)

    const v = await cp.read(K('u1'), async (p) => dec.decode(await readFile(p)))
    expect(v).toBe('v1')
  })

  test('a stale cache file from a previous process is cleared before create', async () => {
    const dir = await cacheDir()
    const stalePath = join(dir, K('u1'))
    await mkdir(dirname(stalePath), { recursive: true })
    await writeFile(stalePath, enc.encode('stale'))

    const cp = new Checkpoint({ storage: new MemoryStorage(), cacheDir: dir, maxOpen: 8, idleMs: 1000 })
    const seen: Array<{ exists: boolean; stale: string | null }> = []
    await cp.write(K('u1'), async (p, exists) => {
      const stale = await readFile(p).then((b) => dec.decode(b), () => null)
      seen.push({ exists, stale })
      await writeFile(p, enc.encode('fresh'))
    })
    expect(seen).toEqual([{ exists: false, stale: null }])
  })

  test('keys cannot traverse outside the cache dir', async () => {
    const cp = new Checkpoint({ storage: new MemoryStorage(), cacheDir: await cacheDir(), maxOpen: 8, idleMs: 1000 })
    await expect(cp.write('../escape', async (p) => writeFile(p, enc.encode('x')))).rejects.toThrow(/invalid key/)
    await expect(cp.read('users/../../escape', async () => 'x')).rejects.toThrow(/invalid key/)
  })

  test('closeAll stops the eviction timer', async () => {
    let clock = 1000
    const cp = new Checkpoint({ storage: new MemoryStorage(), cacheDir: await cacheDir(), maxOpen: 8, idleMs: 50, now: () => clock })
    cp.startEviction(10)
    await cp.closeAll()

    await cp.write(K('u1'), async (p) => writeFile(p, enc.encode('a')))
    clock += 1000
    await new Promise((r) => setTimeout(r, 40))
    expect(cp.openCount).toBe(1)
  })

  test('cacheBytes tracks the current generation and clears on eviction', async () => {
    const storage = new MemoryStorage()
    let clock = 1000
    const cp = new Checkpoint({ storage, cacheDir: await cacheDir(), maxOpen: 8, idleMs: 100, now: () => clock })
    expect(cp.cacheBytes).toBe(0)

    await cp.write(K('u1'), async (p) => writeFile(p, enc.encode('12345')))
    expect(cp.cacheBytes).toBe(5)

    // Overwriting recharges rather than double-counting.
    await cp.write(K('u1'), async (p) => writeFile(p, enc.encode('1234567890')))
    expect(cp.cacheBytes).toBe(10)

    clock += 1000
    await cp.evictIdle()
    expect(cp.cacheBytes).toBe(0)
  })

  test('a failed write leaves no bytes charged', async () => {
    const cp = new Checkpoint({ storage: new MemoryStorage(), cacheDir: await cacheDir(), maxOpen: 8, idleMs: 1000 })
    await cp.write(K('u1'), async (p) => writeFile(p, enc.encode('kept')))
    const settled = cp.cacheBytes

    await expect(
      cp.write(K('u1'), async (p) => {
        await writeFile(p, enc.encode('this working generation is abandoned'))
        throw new Error('callback boom')
      }),
    ).rejects.toThrow('callback boom')

    expect(cp.cacheBytes).toBe(settled)
  })

  test('maxCacheBytes evicts LRU entries even when maxOpen is not reached', async () => {
    const storage = new MemoryStorage()
    let clock = 1000
    // Room for two 10-byte scopes, not three. maxOpen is deliberately generous.
    const cp = new Checkpoint({
      storage,
      cacheDir: await cacheDir(),
      maxOpen: 100,
      maxCacheBytes: 25,
      idleMs: 10_000,
      now: () => clock,
    })

    for (const id of ['u1', 'u2', 'u3']) {
      clock += 10
      await cp.write(K(id), async (p) => writeFile(p, enc.encode('0123456789')))
    }

    expect(cp.cacheBytes).toBeLessThanOrEqual(25)
    expect(cp.openCount).toBe(2)
    expect(cp.overBudget).toBe(false)

    // The evicted scope re-hydrates from storage rather than being lost.
    const v = await cp.read(K('u1'), async (p) => dec.decode(await readFile(p)))
    expect(v).toBe('0123456789')
  })

  test('never evicts an active reader, and reports the resulting overage', async () => {
    const storage = new MemoryStorage()
    const cp = new Checkpoint({ storage, cacheDir: await cacheDir(), maxOpen: 100, maxCacheBytes: 12, idleMs: 10_000 })
    await cp.write(K('u1'), async (p) => writeFile(p, enc.encode('0123456789')))
    await cp.write(K('u2'), async (p) => writeFile(p, enc.encode('0123456789')))

    // Both scopes must be pinned at the same time; a read that has already
    // finished is legitimately evictable and would hide the overage.
    let releaseA!: () => void
    let releaseB!: () => void
    const gateA = new Promise<void>((r) => (releaseA = r))
    const gateB = new Promise<void>((r) => (releaseB = r))
    const held: string[] = []

    const readA = cp.read(K('u1'), async (p) => {
      held.push(dec.decode(await readFile(p)))
      await gateA
      // Still readable: the byte budget must not delete a pinned generation.
      held.push(dec.decode(await readFile(p)))
    })
    const readB = cp.read(K('u2'), async () => {
      await gateB
    })
    await new Promise((r) => setTimeout(r, 5))

    expect(cp.cacheBytes).toBe(20)
    expect(cp.overBudget).toBe(true)

    releaseA()
    releaseB()
    await Promise.all([readA, readB])
    expect(held).toEqual(['0123456789', '0123456789'])

    // Releasing the pins lets the budget be satisfied again.
    expect(cp.cacheBytes).toBeLessThanOrEqual(12)
    expect(cp.overBudget).toBe(false)
  })

  test('a retired generation stays charged while a reader still holds it', async () => {
    const storage = new MemoryStorage()
    const cp = new Checkpoint({ storage, cacheDir: await cacheDir(), maxOpen: 8, idleMs: 10_000 })
    await cp.write(K('u1'), async (p) => writeFile(p, enc.encode('aaaaa')))

    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const reading = cp.read(K('u1'), async () => {
      await gate
    })
    await new Promise((r) => setTimeout(r, 5))

    // Publishing v2 retires v1, but v1 is pinned: both are charged.
    await cp.write(K('u1'), async (p) => writeFile(p, enc.encode('bbbbbbbbbb')))
    expect(cp.cacheBytes).toBe(15)

    release()
    await reading
    expect(cp.cacheBytes).toBe(10)
  })

  test('omitting maxCacheBytes keeps the maxOpen-only behaviour', async () => {
    const storage = new MemoryStorage()
    const cp = new Checkpoint({ storage, cacheDir: await cacheDir(), maxOpen: 4, idleMs: 10_000 })
    expect(cp.cacheBudget).toBe(Number.POSITIVE_INFINITY)

    for (let i = 0; i < 20; i++) {
      await cp.write(K('u' + i), async (p) => writeFile(p, enc.encode('x'.repeat(1000))))
    }
    expect(cp.openCount).toBe(4)
    expect(cp.overBudget).toBe(false)
  })

  test('delete removes the object and its local copy', async () => {
    const storage = new MemoryStorage()
    const cp = new Checkpoint({ storage, cacheDir: await cacheDir(), maxOpen: 8, idleMs: 1000 })
    await cp.write(K('u1'), async (p) => writeFile(p, enc.encode('bye')))
    await cp.delete(K('u1'))
    expect(await storage.head(K('u1'))).toBeNull()
    await expect(cp.read(K('u1'), async () => 'x')).rejects.toBeInstanceOf(NotFoundError)
  })
})
