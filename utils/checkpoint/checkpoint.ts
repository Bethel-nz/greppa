import { constants } from 'node:fs'
import { access, copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Mutex } from 'async-mutex'
import { ConflictError, NotFoundError } from './errors'
import type { ObjectMeta, StorageBackend } from './storage'

export type CheckpointConfig = {
  storage: StorageBackend
  cacheDir: string
  maxOpen: number
  maxCacheBytes?: number
  idleMs: number
  now?: () => number
}

type Generation = {
  localPath: string
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

  get cacheBytes(): number {
    return this.bytes
  }

  get cacheBudget(): number {
    return this.maxCacheBytes
  }

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

  private sizeOf(localPath: string): Promise<number> {
    return stat(localPath).then(
      (s) => s.size,
      () => 0,
    )
  }

  private charge(generation: Generation, bytes: number): void {
    this.bytes += bytes - generation.bytes
    generation.bytes = bytes
    if (this.bytes <= this.maxCacheBytes) this.warnedOverBudget = false
  }

  private discharge(generation: Generation): void {
    this.charge(generation, 0)
  }

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
      this.evictIfNeeded()
    }
  }

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
            await copyFile(entry.current.localPath, working.localPath, constants.COPYFILE_FICLONE)
            this.charge(working, await this.sizeOf(working.localPath))
          }

          const result = await fn(working.localPath, exists)
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
          candidate = null 
          await this.retire(previous)
          this.evictIfNeeded()
          return result
        } catch (err) {
          await this.discard(working)
          if (candidate) await this.discard(candidate)

          if (err instanceof ConflictError) {
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

  async sweepOrphans(opts: { minAgeMs?: number } = {}): Promise<{ removed: number; bytes: number }> {
    const minAgeMs = opts.minAgeMs ?? 60 * 60_000
    const cutoff = Math.min(this.startedAt, Date.now() - minAgeMs)
    const result = { removed: 0, bytes: 0 }

    const walk = async (dir: string): Promise<void> => {
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => null)
      if (!entries) return

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
          () => {},
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

  private evictIfNeeded(): void {
    while (this.open.size > this.maxOpen || this.bytes > this.maxCacheBytes) {
      let victim: Entry | null = null
      for (const entry of this.open.values()) {
        if (entry.refcount > 0) continue
        if (!victim || entry.lastUsed < victim.lastUsed) victim = entry
      }
      if (!victim) {
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
