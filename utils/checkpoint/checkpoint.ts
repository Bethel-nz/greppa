import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Mutex } from 'async-mutex'
import { ConflictError, NotFoundError } from './errors'
import type { ObjectMeta, StorageBackend } from './storage'

export type CheckpointConfig = {
  storage: StorageBackend
  cacheDir: string
  maxOpen: number
  idleMs: number
  now?: () => number
}

type Entry = {
  key: string
  localPath: string
  etag: string | null
  refcount: number
  lastUsed: number
  // Whether a valid local file exists at localPath (hydrated from storage or
  // already written once). Passed to write() callbacks so a native store like
  // Memvid can choose create() (new file) vs use() (existing file).
  exists: boolean
}

export class Checkpoint {
  private readonly storage: StorageBackend
  private readonly cacheDir: string
  private readonly maxOpen: number
  private readonly idleMs: number
  private readonly now: () => number

  private readonly open = new Map<string, Entry>()
  private readonly locks = new Map<string, Mutex>()
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(cfg: CheckpointConfig) {
    this.storage = cfg.storage
    this.cacheDir = cfg.cacheDir
    this.maxOpen = cfg.maxOpen
    this.idleMs = cfg.idleMs
    this.now = cfg.now ?? Date.now
  }

  get openCount(): number {
    return this.open.size
  }

  private localPathFor(key: string): string {
    if (key.split('/').includes('..')) throw new Error(`[checkpoint] invalid key: ${key}`)
    return join(this.cacheDir, key)
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
    if (existing) return existing
    const entry = await this.hydrate(key, create)
    this.open.set(key, entry)
    return entry
  }

  private async hydrate(key: string, create: boolean): Promise<Entry> {
    const localPath = this.localPathFor(key)
    const got = await this.storage.get(key)
    await mkdir(dirname(localPath), { recursive: true })

    if (!got) {
      if (!create) throw new NotFoundError(key)
      // Do not pre-create a local file. A 0-byte file is invalid to a native
      // store like Memvid (use() would fail); the write() callback creates the
      // real file via create(). We only ensure the parent dir exists, and clear
      // any stale cached file left behind by a previous process so create()
      // sees a free path.
      await rm(localPath, { force: true })
      return { key, localPath, etag: null, refcount: 0, lastUsed: this.now(), exists: false }
    }

    await writeFile(localPath, got.body)
    return { key, localPath, etag: got.etag, refcount: 0, lastUsed: this.now(), exists: true }
  }

  private release(entry: Entry): void {
    entry.refcount--
    entry.lastUsed = this.now()
  }

  /**
   * Read against an isolated snapshot. The local file is copied to a private
   * temp path while the per-key lock is held, then the lock is released before
   * fn runs. This guarantees fn never observes a half-written file from a
   * concurrent write, and a long read (e.g. an LLM ask()) never blocks writes.
   */
  async read<T>(key: string, fn: (localPath: string) => Promise<T>): Promise<T> {
    const { entry, tmp } = await this.withLock(key, async () => {
      const e = await this.ensureOpen(key, false)
      e.refcount++
      e.lastUsed = this.now()
      try {
        const t = `${e.localPath}.rd-${crypto.randomUUID()}`
        await copyFile(e.localPath, t)
        return { entry: e, tmp: t }
      } catch (err) {
        // The cached file is unusable (e.g. deleted out from under us). Drop
        // the entry so the next operation re-hydrates from storage, and undo
        // the refcount so the entry is not pinned open forever.
        this.open.delete(key)
        this.release(e)
        throw err
      }
    })
    this.evictIfNeeded()
    try {
      return await fn(tmp)
    } finally {
      await rm(tmp, { force: true })
      this.release(entry)
    }
  }

  /**
   * Exclusive write. fn receives the local path and an `exists` flag (false for
   * a brand-new object). fn MUST fully commit and close its handle (e.g. Memvid
   * seal()) before returning, because flush reads the file bytes immediately
   * after fn resolves.
   */
  async write<T>(key: string, fn: (localPath: string, exists: boolean) => Promise<T>): Promise<T> {
    return this.withLock(key, async () => {
      const entry = await this.ensureOpen(key, true)
      entry.refcount++
      entry.lastUsed = this.now()
      this.evictIfNeeded()
      try {
        const result = await fn(entry.localPath, entry.exists)
        await this.flush(entry)
        entry.exists = true
        return result
      } catch (err) {
        // A failed write leaves the local file in an unknown state (partial
        // write, or written but never flushed). Drop the entry and the file so
        // the next operation re-hydrates from storage.
        this.open.delete(key)
        await rm(entry.localPath, { force: true })
        throw err
      } finally {
        this.release(entry)
      }
    })
  }

  private async flush(entry: Entry): Promise<void> {
    const body = await readFile(entry.localPath)
    try {
      entry.etag = await this.storage.putIfMatch(entry.key, body, entry.etag)
    } catch (err) {
      if (!(err instanceof ConflictError)) throw err
      const meta = await this.storage.head(entry.key)
      entry.etag = await this.storage.putIfMatch(entry.key, body, meta?.etag ?? null)
    }
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
        this.open.delete(key)
        await rm(entry.localPath, { force: true })
      }
    })
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

  private evictIfNeeded(): void {
    while (this.open.size > this.maxOpen) {
      let victim: Entry | null = null
      for (const entry of this.open.values()) {
        if (entry.refcount > 0) continue
        if (!victim || entry.lastUsed < victim.lastUsed) victim = entry
      }
      if (!victim) break
      void this.evict(victim).catch(() => {})
    }
  }

  private evict(entry: Entry): Promise<void> {
    // Deleting from the map is synchronous so callers see the open set shrink
    // immediately, but the file removal must run under the key lock: an
    // unlocked rm can race a concurrent re-hydration of the same key and
    // delete the freshly written cache file.
    this.open.delete(entry.key)
    return this.withLock(entry.key, async () => {
      if (this.open.has(entry.key)) return
      await rm(entry.localPath, { force: true })
    })
  }
}
