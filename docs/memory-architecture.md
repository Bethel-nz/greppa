# Memory layer architecture

How greppa's memory actually works, end to end.

Companion documents:

- [MEMORY.md](./MEMORY.md) — what the system is, and its limitations
- [why-own-memory.md](./why-own-memory.md) — why it was built rather than bought

---

## 1. The one-sentence version

**A scope's memory is a SQLite database living in object storage, checked out
to local disk on demand, mutated as a private copy, and published back under an
optimistic lock.**

Everything below is a consequence of that sentence.

---

## 2. Layers and ownership

```
┌──────────────────────────────────────────────────────────────┐
│ routes/                                                      │
│   knowledge.ts · orgs/[orgId]/memory.ts · workflows/chat.ts  │
└───────────────────────────┬──────────────────────────────────┘
                            │  userId, orgId, text
┌───────────────────────────▼──────────────────────────────────┐
│ lib/memory/scoped-service.ts   personal scopes               │
│ lib/memory/service.ts          org scopes (+ ACL)            │
│                                                              │
│   owns: chunking, embedding orchestration, answer synthesis  │
│   does NOT own: files, locks, uploads, eviction              │
└───────────────────────────┬──────────────────────────────────┘
                            │  (localPath) => Promise<T>
┌───────────────────────────▼──────────────────────────────────┐
│ utils/checkpoint/checkpoint.ts                               │
│                                                              │
│   owns: hydration, generations, per-key mutex, refcounts,    │
│         compare-and-set publish, LRU + byte-budget eviction  │
│   knows nothing about: SQLite, vectors, embeddings, scopes   │
└───────────────────────────┬──────────────────────────────────┘
                            │  key, localPath, etag
┌───────────────────────────▼──────────────────────────────────┐
│ utils/r2.ts  →  Cloudflare R2                                │
│   streamed GET/PUT, IfMatch / IfNoneMatch                    │
└──────────────────────────────────────────────────────────────┘
```

The seam that matters is between the service and Checkpoint. Checkpoint's entire
contract is:

```ts
read<T>(key: string, fn: (localPath: string) => Promise<T>): Promise<T>
write<T>(key: string, fn: (localPath: string, exists: boolean) => Promise<T>): Promise<T>
```

It hands you a path and takes back a promise. It has no idea the file is a
database. That is why swapping Memvid for SQLite required **zero changes** to
`checkpoint.ts` — and why swapping SQLite for something else later would too.

---

## 3. Object layout

```
scopes/{scopeId}/memory.sqlite     personal scope database   (CAS-published)
scopes/{scopeId}/assets/{sha256}   immutable image blobs     (write-once)
orgs/{orgId}/memory.sqlite         org scope database        (CAS-published)
```

Assets are deliberately **outside** the database. Checkpoint republishes a whole
object per write, so a 20 MiB scope of screenshots would re-upload all 20 MiB to
add a 2 KB note. Content-addressed blobs are written once, deduplicated by
digest, and immutable — so they need no compare-and-set and never conflict.

---

## 4. Inside the file

```sql
meta(key, value)              -- schema_version, embedding_model, embedding_dim
documents(id, title, source_type, source_url, created_by, created_at, meta_json,
          acl_tenant_id, acl_visibility,
          acl_read_roles, acl_read_groups, acl_read_principals)
chunks(id, document_id, ordinal, text, modality, asset_sha256, asset_mime)
chunks_fts   USING fts5(text, content=chunks, content_rowid=id)
chunks_vec   USING vec0(embedding float[N])
```

`chunks.id` is the join key across all three: `chunks_fts.rowid` and
`chunks_vec.rowid` are both set to it, so fusion works on bare integers with no
mapping table.

Three pragmas are load-bearing:

| pragma | why |
| --- | --- |
| `journal_mode = DELETE` | WAL writes `-wal`/`-shm` sidecars. Checkpoint publishes **one** path, so a sidecar would be silently dropped and lose data. |
| `foreign_keys = ON` | SQLite disables FK enforcement per connection by default; the `document_id` cascade is inert without it. |
| reads open `readonly` | Concurrent readers share one immutable generation file. A read-write handle could mutate a file other readers are using. |

---

## 5. The read path

```
searchScopedMemory({ userId, query })
│
├─ 1. resolve scope, derive key                      Postgres
├─ 2. provider.embed([query], 'query')               NETWORK — no lock held
│
└─ 3. checkpoint.read(key, fn)
      │
      ├─ acquire per-key mutex
      ├─ ensureOpen(key, create=false)
      │    └─ miss → hydrate: streamed GET → .hydrate-<uuid>
      │                       → rename → .generation-<uuid>
      ├─ pin: entry.refcount++ , generation.refcount++
      ├─ RELEASE MUTEX                          ◄── fn runs unlocked
      │
      ├─ fn(generationPath):
      │    open readonly → vector top-50 → BM25 top-50
      │    → reciprocal rank fusion → hydrate rows → close
      │
      └─ finally: unpin; delete generation if retired and unpinned;
                  evictIfNeeded()
```

Two properties fall out of this shape:

**The query embedding is computed before the lock.** A network round trip never
holds a per-scope mutex.

**The reader holds a generation, not a lock.** Once pinned, the mutex is free.
A write can proceed immediately and publish a *new* generation; the reader keeps
reading the old one, which is immutable and cannot be torn. Earlier versions
copied the file per read — that cost a full duplication on every question, and
was removed.

---

## 6. The write path

```
addScopedMemory({ userId, title, text })
│
├─ 1. chunkText(text)                                ~1000 chars, 150 overlap
├─ 2. embedInBatches(chunks, 'document')             NETWORK — no lock held
├─ 3. putAssetIfAbsent(image)                        NETWORK — no lock held
│
└─ 4. checkpoint.write(key, fn)          ◄── mutex held for ALL of this
      │
      ├─ ensureOpen(key, create=true)
      ├─ copyFile(current → .write-<uuid>, COPYFILE_FICLONE)   copy-on-write
      │
      ├─ fn(workingPath, exists):
      │    openScopeStore → assert identity
      │    → ONE transaction: documents + chunks + chunks_fts + chunks_vec
      │    → close()                      ◄── MUST close before returning
      │
      ├─ rename(.write-<uuid> → .generation-<uuid>)      now immutable
      ├─ storage.putFileIfMatch(key, candidate, entry.etag)
      │
      ├─ success → entry.current = candidate; entry.etag = new
      │            retire previous generation
      └─ ConflictError → see §7
```

**Embeddings are computed before the lock, deliberately.** Two reasons: the
mutex is held for milliseconds of local I/O rather than a network round trip,
and a conflict rerun (§7) replays only local inserts without re-billing the
embedding API.

**The callback must close the database before returning.** Checkpoint streams
the file to R2 the moment `fn` resolves. An open handle risks publishing bytes
SQLite has not finished writing.

---

## 7. Conflict resolution

Two processes writing the same scope both read etag `v1`. One wins.

```
   writer A                          writer B
   ────────                          ────────
   clone v1                          clone v1
   insert                            insert
   putFileIfMatch(IfMatch: v1)       putFileIfMatch(IfMatch: v1)
   → 200, etag v2  ✓                 → 412 Precondition Failed  ✗
                                     │
                                     ├─ delete stale candidate
                                     ├─ invalidate entry (drop cached v1)
                                     ├─ re-hydrate → gets v2
                                     └─ RERUN fn against v2 → publishes v3
```

This is **not** last-writer-wins. The loser discards its bytes, not its
intention. Both documents exist in `v3`.

The property that makes it work: the callback must be **idempotent in effect but
re-runnable against different state**. Inserting a document satisfies this. So
does appending. Something that reads a counter and increments it would too,
because the rerun sees fresh state.

`WRITE_ATTEMPTS = 2`. A second conflict surfaces `ConflictError` rather than
looping — under sustained contention the right answer is backpressure, not
spinning.

Verified against real R2: two Checkpoint instances writing from the same ETag
produced exactly **3 callback invocations** for 2 writes, and all documents
survived.

---

## 8. The local cache

Checkpoint keeps a bounded working set. Two budgets apply simultaneously:

| budget | env | meaning |
| --- | --- | --- |
| `maxOpen` | `CHECKPOINT_MAX_OPEN` | how many scopes stay open |
| `maxCacheBytes` | `CHECKPOINT_MAX_CACHE_BYTES` | how many bytes they occupy |

A file count alone cannot bound disk when scopes differ by orders of magnitude,
which is why the byte budget exists.

**What counts toward bytes:** current generations, private working generations
mid-write, freshly hydrated candidates, and retired generations still pinned by
a reader. Sizes come from `stat()` — a large database is never read into the JS
heap to find out how big it is.

**Eviction** removes least-recently-used entries with `refcount === 0` until
both budgets are satisfied. The uncharge is synchronous so the loop always
terminates; only the `rm` is deferred.

**The over-budget contract** is the part worth knowing:

> Eviction never deletes a generation an active reader is using, and never fails
> a request to stay under budget. When everything cached is pinned, the cache
> runs over budget and reports it on `checkpoint.overBudget`.

This is reachable two ways: enough concurrent scopes to outweigh the budget, or
a single scope larger than the entire budget — in which case every read of that
scope is over budget for its whole duration. Alarm on `overBudget` staying true.

### Orphaned generations

Checkpoint keeps **no persistent index**. The open map is rebuilt from R2 on
every boot and a local generation is never reused across restarts, so a crash
leaves `.generation-`/`.write-`/`.hydrate-` files that no instance will claim.
They are invisible to `maxCacheBytes` and nothing reclaims them, which leaks
slowly on a long-lived host with a persistent cacheDir.

`sweepOrphans()` removes them, guarded twice: it skips anything created since
the instance started (that is our own live or in-flight work) and anything
younger than `minAgeMs`, default one hour. The second guard is what keeps a
*concurrent* process's pinned generations out of reach — from inside this
process they are indistinguishable from orphans.

It is opt-in via `CHECKPOINT_SWEEP_ON_BOOT=1` rather than automatic, because
that age floor narrows the multi-process race without closing it. A cacheDir
shared by two processes is outside this design; give each its own.

---

## 9. The embedding seam

```ts
interface EmbeddingProvider {
  readonly id: string           // "google/gemini-embedding-2@1536"
  readonly dimension: number    // never a module constant
  readonly maxBatchSize: number
  embed(texts: string[], kind: 'document' | 'query'): Promise<Float32Array[]>
  embedImage?(assets: Array<{ bytes: Uint8Array; mime: string }>): Promise<Float32Array[]>
}
```

Two invariants the whole system leans on:

**`kind` is not cosmetic.** Retrieval models are asymmetric. It maps to Google's
`task_type` and to NVIDIA's `input_type`. Verified on Nemotron: omitting
`input_type` yields a vector byte-identical to `input_type: "query"` — so
documents indexed without it sit in the wrong half of the model's space, with no
error, just quietly worse ranking.

**Output is always L2-normalized.** The store compares by dot product. Gemini
pre-normalizes only its 3072-d output; truncated sizes arrive unnormalized.
Adapters normalize unconditionally and a conformance test asserts `‖v‖ ≈ 1` for
every provider.

**Identity is pinned in `meta` and asserted on open.** `vec0` fixes its
dimension at table creation, so the schema is built from `provider.dimension`.
Opening a scope with a different provider throws `EmbeddingIdentityError` —
because comparing vectors across models returns plausible nonsense rather than
an error, and that is precisely the failure class this layer exists to prevent.

**Migration is `reembedScope()`.** Chunk text and assets are the source of
truth; vectors are a derived cache. It drops `chunks_vec`, recreates it at the
new dimension, re-embeds from stored text, and rewrites `meta` — inside one
`checkpoint.write`, so it is atomic, CAS-protected, and costs one upload.
`documents`, `chunks` and `chunks_fts` are untouched, so BM25 keeps working
throughout.

---

## 10. Access control

Two mechanisms, deliberately layered.

**Between scopes: physical.** One file per scope. Another tenant's data is not
filtered out of a shared result — their file is never opened. A filtering bug
cannot leak across scopes because there is nothing to filter.

**Within a scope: a SQL predicate.** Org scopes are shared by their members, so
`documents` carries ACL columns and retrieval takes an optional reader context:

```sql
(d.acl_tenant_id IS NULL OR d.acl_tenant_id = ?)
AND (
      d.acl_visibility = 'public'
   OR EXISTS (SELECT 1 FROM json_each(d.acl_read_principals) WHERE value = ?)
   OR EXISTS (SELECT 1 FROM json_each(d.acl_read_roles)      WHERE value IN (…))
   OR EXISTS (SELECT 1 FROM json_each(d.acl_read_groups)     WHERE value IN (…))
)
```

Written as a **predicate on the hydration query, not a post-filter** — a
document the reader may not see never enters the result set, even transiently.
Membership values are normalized (trim + lowercase) on both write and read, so
casing cannot defeat a check.

When ACL is active the candidate depth is multiplied by 4, because filtering
after retrieval would otherwise let an enforced query silently under-fill its
limit.

---

## 11. Failure modes

| condition | behaviour |
| --- | --- |
| Scope has no memories yet | `NotFoundError` → empty result, not an error |
| Embedding provider fails | propagates; never writes a chunk without its vector |
| Callback throws mid-write | working generation deleted; previous `current` untouched |
| ETag conflict | rerun against fresh state (§7); second conflict → `ConflictError` |
| Provider/dimension mismatch | `EmbeddingIdentityError` on open — never queries across models |
| Cache file deleted externally | that read fails once, entry invalidated, next read re-hydrates |
| sqlite-vec extension missing | explicit error at open naming the fix |
| Malformed FTS query | degrades to vector-only; never fails the search |
| Everything cached is pinned | over budget, reported on `overBudget`; no request fails |

---

## 12. Where the seams are

Deliberate extension points, for whoever changes this next:

| seam | swap without touching |
| --- | --- |
| `StorageBackend` | R2 → S3/GCS/local: Checkpoint, the store |
| `EmbeddingProvider` | model or vendor: the store, Checkpoint |
| `Checkpoint.read/write` callback | SQLite → anything file-shaped: Checkpoint |
| `generateAnswer()` | Groq → any model: retrieval |

The two changes this design is *not* ready for, and what they'd cost:

- **Delta writes.** Every write republishes the whole object. Fixing this
  properly means a VFS or a delta format, and the compare-and-set model would
  need rethinking. Write coalescing is the cheap 80% and is not built yet.
- **Approximate search.** `sqlite-vec` scans every vector (100% recall). Past
  roughly 100k vectors in a single scope you'd want an ANN index, which means a
  different extension or engine.
