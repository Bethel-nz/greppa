import { constants } from 'node:fs'
import { access, copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Mutex } from 'async-mutex'
import { ConflictError, NotFoundError } from './errors'
import type { ObjectMeta, StorageBackend } from './storage'

export type CheckpointConfig = {
  storage: StorageBackend
  cacheDir: string
  /** Hard-ish ceiling on how many scopes stay open. See maxCacheBytes. */
  maxOpen: number
  /**
   * Soft ceiling on local cache bytes. Scope memories vary by orders of
   * magnitude, so a file count alone cannot bound disk use.
   *
   * Both budgets apply: eviction runs until the open set is within maxOpen AND
   * the tracked bytes are within maxCacheBytes. Only idle, unreferenced entries
   * are evictable, so the budget is a target rather than a guarantee — see
   * `overBudget`. Defaults to Infinity, which reproduces the maxOpen-only
   * behaviour exactly.
   */
  maxCacheBytes?: number
  idleMs: number
  now?: () => number
}

type Generation = {
  localPath: string
  /** Size charged to the byte budget. Measured with stat(), never by reading. */
  bytes: number
  refcount: number
  retired: boolean
}

type Entry = {
  key: string
  current: Generation | null
  etag: string | null
  refcount: number
  lastUsed: number
}

const WRITE_ATTEMPTS = 2

export class Checkpoint {
  private readonly storage: StorageBackend
  private readonly cacheDir: string
  private readonly maxOpen: number
  private readonly maxCacheBytes: number
  private readonly idleMs: number
  private readonly now: () => number

  private readonly open = new Map<string, Entry>()
  private readonly locks = new Map<string, Mutex>()
  private timer: ReturnType<typeof setInterval> | null = null
  private bytes = 0
  private warnedOverBudget = false
  /** Wall clock at construction. Anything newer than this belongs to us. */
  private readonly startedAt: number

  constructor(cfg: CheckpointConfig) {
    this.storage = cfg.storage
    this.cacheDir = cfg.cacheDir
    this.maxOpen = cfg.maxOpen
    this.maxCacheBytes = cfg.maxCacheBytes ?? Number.POSITIVE_INFINITY
    this.idleMs = cfg.idleMs
    this.now = cfg.now ?? Date.now
    this.startedAt = Date.now()
  }

  get openCount(): number {
    return this.open.size
  }

  /**
   * Local bytes currently charged to this checkpoint: every current
   * generation, every private working generation mid-write, every hydrated
   * candidate, and every retired generation still pinned by a reader.
   */
  get cacheBytes(): number {
    return this.bytes
  }

  get cacheBudget(): number {
    return this.maxCacheBytes
  }

  /**
   * True when the cache exceeds its byte budget because everything left is
   * pinned by an active reader or writer. Requests are never failed and pinned
   * generations are never deleted to get back under budget; the overage clears
   * as those operations finish. Alarm on this in production: a persistently
   * true value means maxCacheBytes is too small for the live concurrency, or a
   * single scope is larger than the whole budget.
   */
  get overBudget(): boolean {
    return this.bytes > this.maxCacheBytes
  }

  private localPathFor(key: string): string {
    if (key.split('/').includes('..')) throw new Error(`[checkpoint] invalid key: ${key}`)
    return join(this.cacheDir, key)
  }

  private generationPathFor(key: string, kind: 'hydrate' | 'write' | 'generation'): string {
    return `${this.localPathFor(key)}.${kind}-${crypto.randomUUID()}`
  }

  private mutexFor(key: string): Mutex {
    let m = this.locks.get(key)
    if (!m) {
      m = new Mutex()
      this.locks.set(key, m)
    }
    return m
  }

  private async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const m = this.mutexFor(key)
    try {
      return await m.runExclusive(fn)
    } finally {
      if (!m.isLocked()) this.locks.delete(key)
    }
  }

  private async ensureOpen(key: string, create: boolean): Promise<Entry> {
    const existing = this.open.get(key)
    if (existing) {
      if (!create && !existing.current) throw new NotFoundError(key)
      return existing
    }
    const entry = await this.hydrate(key, create)
    this.open.set(key, entry)
    return entry
  }

  private async hydrate(key: string, create: boolean): Promise<Entry> {
    const stagingPath = this.generationPathFor(key, 'hydrate')
    await mkdir(dirname(stagingPath), { recursive: true })

    try {
      let etag: string | null = null
      let found = false

      if (this.storage.getToFile) {
        const got = await this.storage.getToFile(key, stagingPath)
        if (got) {
          etag = got.etag
          found = true
        }
      } else {
        const got = await this.storage.get(key)
        if (got) {
          await writeFile(stagingPath, got.body)
          etag = got.etag
          found = true
        }
      }

      if (!found) {
        if (!create) throw new NotFoundError(key)
        return { key, current: null, etag: null, refcount: 0, lastUsed: this.now() }
      }

      const localPath = this.generationPathFor(key, 'generation')
      await rename(stagingPath, localPath)
      const generation: Generation = { localPath, bytes: 0, refcount: 0, retired: false }
      this.charge(generation, await this.sizeOf(localPath))
      return { key, current: generation, etag, refcount: 0, lastUsed: this.now() }
    } finally {
      await rm(stagingPath, { force: true })
    }
  }

  /** Size a local generation without pulling it into the JS heap. */
  private sizeOf(localPath: string): Promise<number> {
    return stat(localPath).then(
      (s) => s.size,
      () => 0,
    )
  }

  /** Adjust a generation's charge to `bytes`, keeping the running total exact. */
  private charge(generation: Generation, bytes: number): void {
    this.bytes += bytes - generation.bytes
    generation.bytes = bytes
    if (this.bytes <= this.maxCacheBytes) this.warnedOverBudget = false
  }

  /** Drop a generation's charge, e.g. once its file is gone or renamed away. */
  private discharge(generation: Generation): void {
    this.charge(generation, 0)
  }

  /**
   * Uncharge and delete. The uncharge happens synchronously so the eviction
   * loop sees the freed bytes immediately and cannot spin.
   */
  private discard(generation: Generation): Promise<void> {
    this.discharge(generation)
    return rm(generation.localPath, { force: true })
  }

  private release(entry: Entry): void {
    entry.refcount--
    entry.lastUsed = this.now()
  }

  private async retire(generation: Generation | null): Promise<void> {
    if (!generation || generation.retired) return
    generation.retired = true
    // A pinned generation stays on disk, and stays charged, until its last
    // reader releases it. Readers are never torn out from under.
    if (generation.refcount === 0) {
      await this.discard(generation)
    }
  }

  private async invalidate(key: string, entry: Entry): Promise<void> {
    if (this.open.get(key) === entry) this.open.delete(key)
    const generation = entry.current
    entry.current = null
    await this.retire(generation)
  }

  private async pathExists(localPath: string): Promise<boolean> {
    try {
      await access(localPath)
      return true
    } catch {
      return false
    }
  }

  /**
   * Read directly from an immutable local generation. Writers always build and
   * seal a separate generation, so readers never copy the full memory file and
   * never observe a half-written generation.
   */
  async read<T>(key: string, fn: (localPath: string) => Promise<T>): Promise<T> {
    const { entry, generation } = await this.withLock(key, async () => {
      const e = await this.ensureOpen(key, false)
      const current = e.current
      if (!current) throw new NotFoundError(key)
      e.refcount++
      current.refcount++
      e.lastUsed = this.now()
      return { entry: e, generation: current }
    })
    this.evictIfNeeded()

    try {
      return await fn(generation.localPath)
    } catch (err) {
      if (!(await this.pathExists(generation.localPath))) {
        await this.withLock(key, async () => {
          if (this.open.get(key) === entry && entry.current === generation) {
            await this.invalidate(key, entry)
          }
        })
      }
      throw err
    } finally {
      generation.refcount--
      this.release(entry)
      if (generation.retired && generation.refcount === 0) {
        await this.discard(generation)
      }
      // Releasing a pin may make bytes reclaimable that were not before.
      this.evictIfNeeded()
    }
  }

  /**
   * Exclusive, optimistic write. fn receives a private working generation and
   * may be invoked again if another process wins the R2 compare-and-set. It
   * MUST only mutate that file, fully commit/close its handle (e.g. seal()), and
   * be safe to rerun against a freshly hydrated generation.
   */
  async write<T>(key: string, fn: (localPath: string, exists: boolean) => Promise<T>): Promise<T> {
    return this.withLock(key, async () => {
      for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
        const entry = await this.ensureOpen(key, true)
        entry.refcount++
        entry.lastUsed = this.now()
        this.evictIfNeeded()

        const exists = entry.current !== null
        const working: Generation = {
          localPath: this.generationPathFor(key, 'write'),
          bytes: 0,
          refcount: 0,
          retired: false,
        }
        let candidate: Generation | null = null

        try {
          if (entry.current) {
            // Ask the filesystem for a copy-on-write clone where supported;
            // otherwise copy once on the write path, never on every read.
            await copyFile(entry.current.localPath, working.localPath, constants.COPYFILE_FICLONE)
            this.charge(working, await this.sizeOf(working.localPath))
          }

          const result = await fn(working.localPath, exists)
          // The callback just grew the working generation; recharge before it
          // becomes a candidate so the budget sees its real size.
          this.charge(working, await this.sizeOf(working.localPath))

          candidate = {
            localPath: this.generationPathFor(key, 'generation'),
            bytes: 0,
            refcount: 0,
            retired: false,
          }
          await rename(working.localPath, candidate.localPath)
          this.charge(candidate, working.bytes)
          this.discharge(working)

          const etag = await this.flush(key, candidate.localPath, entry.etag)
          const previous = entry.current
          entry.current = candidate
          entry.etag = etag
          candidate = null // published: no longer ours to discard
          await this.retire(previous)
          this.evictIfNeeded()
          return result
        } catch (err) {
          await this.discard(working)
          if (candidate) await this.discard(candidate)

          if (err instanceof ConflictError) {
            // Our working generation was based on stale bytes. Never force it
            // over the new object: discard, rehydrate, and rerun fn.
            await this.invalidate(key, entry)
            if (attempt + 1 < WRITE_ATTEMPTS) continue
          } else if (entry.current && !(await this.pathExists(entry.current.localPath))) {
            await this.invalidate(key, entry)
          }

          throw err
        } finally {
          this.release(entry)
        }
      }

      throw new ConflictError(key)
    })
  }

  private async flush(key: string, localPath: string, etag: string | null): Promise<string> {
    if (this.storage.putFileIfMatch) {
      return this.storage.putFileIfMatch(key, localPath, etag)
    }

    const body = await readFile(localPath)
    return this.storage.putIfMatch(key, body, etag)
  }

  async stat(key: string): Promise<ObjectMeta | null> {
    return this.storage.head(key)
  }

  async list(prefix: string): Promise<ObjectMeta[]> {
    return this.storage.list(prefix)
  }

  async delete(key: string): Promise<void> {
    await this.withLock(key, async () => {
      await this.storage.delete(key)
      const entry = this.open.get(key)
      if (entry) {
        await this.invalidate(key, entry)
      }
    })
  }

  /**
   * Delete generation files stranded by a previous process.
   *
   * Checkpoint keeps no persistent index: the open map is rebuilt from R2 on
   * every boot, and a local generation is never reused across restarts. So a
   * crash leaves `.generation-`/`.write-`/`.hydrate-` files that no instance
   * will ever claim — they are invisible to `maxCacheBytes` and nothing
   * reclaims them. On a long-lived host with a persistent cacheDir that leaks.
   *
   * Two guards make this safe rather than destructive:
   *
   * 1. **Nothing newer than this instance is touched.** Files created since
   *    construction are ours — either a tracked generation or a working copy
   *    mid-write, which is a local variable and appears in no map.
   * 2. **Nothing younger than `minAgeMs` is touched.** If another process
   *    shares this cacheDir, its live generations look exactly like orphans
   *    from here. The age floor is what keeps a concurrent instance's pinned
   *    files out of reach.
   *
   * Guard 2 narrows the multi-process race but cannot close it. A cacheDir
   * shared by two processes is outside this design; give each its own.
   */
  async sweepOrphans(opts: { minAgeMs?: number } = {}): Promise<{ removed: number; bytes: number }> {
    const minAgeMs = opts.minAgeMs ?? 60 * 60_000
    const cutoff = Math.min(this.startedAt, Date.now() - minAgeMs)
    const result = { removed: 0, bytes: 0 }

    const walk = async (dir: string): Promise<void> => {
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        return // cacheDir may not exist yet
      }
      for (const e of entries) {
        const p = join(dir, e.name)
        if (e.isDirectory()) {
          await walk(p)
          continue
        }
        if (!/\.(generation|write|hydrate)-[0-9a-f-]{36}$/.test(e.name)) continue

        const s = await stat(p).catch(() => null)
        if (!s || s.mtimeMs >= cutoff) continue

        await rm(p, { force: true }).then(
          () => {
            result.removed++
            result.bytes += s.size
          },
          () => {}, // raced with another sweep; not an error
        )
      }
    }

    await walk(this.cacheDir)
    return result
  }

  startEviction(intervalMs = 60_000): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      void this.evictIdle().catch(() => {})
    }, intervalMs)
    this.timer.unref?.()
  }

  stopEviction(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  async evictIdle(): Promise<void> {
    const cutoff = this.now() - this.idleMs
    for (const entry of [...this.open.values()]) {
      if (entry.refcount === 0 && entry.lastUsed <= cutoff) {
        await this.evict(entry)
      }
    }
  }

  async closeAll(): Promise<void> {
    this.stopEviction()
    for (const entry of [...this.open.values()]) {
      if (entry.refcount === 0) await this.evict(entry)
    }
  }

  /**
   * Evict least-recently-used idle entries until both the entry-count and the
   * byte budget are satisfied.
   *
   * Entries with a live refcount are skipped, so when the only thing left is
   * in-flight work the loop stops with the cache still over budget rather than
   * pulling a file out from under an active reader. That state is reported by
   * `overBudget` and warned about once per transition. It is reachable two
   * ways: enough concurrent scopes to outweigh the budget, or a single scope
   * bigger than the entire budget — in which case every read of that scope is
   * over budget for its whole duration, and maxCacheBytes must be raised above
   * the largest scope the deployment intends to serve.
   */
  private evictIfNeeded(): void {
    while (this.open.size > this.maxOpen || this.bytes > this.maxCacheBytes) {
      let victim: Entry | null = null
      for (const entry of this.open.values()) {
        if (entry.refcount > 0) continue
        if (!victim || entry.lastUsed < victim.lastUsed) victim = entry
      }
      if (!victim) {
        // evict() discharges synchronously, so if bytes are still over budget
        // here it is because everything remaining is pinned.
        if (this.bytes > this.maxCacheBytes && !this.warnedOverBudget) {
          this.warnedOverBudget = true
          console.warn(
            `[checkpoint] cache is ${this.bytes} bytes against a ${this.maxCacheBytes}-byte budget; ` +
              `all ${this.open.size} open entries are pinned by active readers or writers`,
          )
        }
        break
      }
      void this.evict(victim).catch(() => {})
    }
  }

  private evict(entry: Entry): Promise<void> {
    if (this.open.get(entry.key) !== entry) return Promise.resolve()
    this.open.delete(entry.key)
    const generation = entry.current
    entry.current = null
    return this.retire(generation)
  }
}
