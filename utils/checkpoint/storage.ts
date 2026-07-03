import { ConflictError } from './errors'

export type ObjectMeta = { key: string; etag: string; size: number }

export interface StorageBackend {
  head(key: string): Promise<ObjectMeta | null>
  get(key: string): Promise<{ body: Uint8Array; etag: string } | null>
  putIfMatch(key: string, body: Uint8Array, etag: string | null): Promise<string>
  delete(key: string): Promise<void>
  list(prefix: string): Promise<ObjectMeta[]>
}

type Stored = { body: Uint8Array; etag: string }

export class MemoryStorage implements StorageBackend {
  private objects = new Map<string, Stored>()
  private seq = 0
  readonly counts = { head: 0, get: 0, put: 0, delete: 0, list: 0 }

  private nextEtag(): string {
    return `etag-${++this.seq}`
  }

  async head(key: string): Promise<ObjectMeta | null> {
    this.counts.head++
    const o = this.objects.get(key)
    return o ? { key, etag: o.etag, size: o.body.length } : null
  }

  async get(key: string): Promise<{ body: Uint8Array; etag: string } | null> {
    this.counts.get++
    const o = this.objects.get(key)
    return o ? { body: new Uint8Array(o.body), etag: o.etag } : null
  }

  async putIfMatch(key: string, body: Uint8Array, etag: string | null): Promise<string> {
    this.counts.put++
    const existing = this.objects.get(key)
    if ((existing?.etag ?? null) !== etag) throw new ConflictError(key)
    const next = this.nextEtag()
    this.objects.set(key, { body: new Uint8Array(body), etag: next })
    return next
  }

  async delete(key: string): Promise<void> {
    this.counts.delete++
    this.objects.delete(key)
  }

  async list(prefix: string): Promise<ObjectMeta[]> {
    this.counts.list++
    const out: ObjectMeta[] = []
    for (const [key, o] of this.objects) {
      if (key.startsWith(prefix)) out.push({ key, etag: o.etag, size: o.body.length })
    }
    return out
  }
}
