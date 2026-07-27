# Why greppa runs its own memory system

**Decided:** 2026-07-25
**Status:** implemented
**Supersedes:** `@memvid/sdk` as the scope memory engine

---

## The short version

Three constraints in greppa's architecture eliminate almost every off-the-shelf
memory product. Memvid was the one that appeared to satisfy them, and its file
size grew with the *square of the write count* — which is disqualifying for a
product whose defining behaviour is writing on every conversational turn. Once
it was ruled out, the remaining field had exactly one member, and it was a set
of primitives rather than a product. So we assembled the store ourselves.

This document explains the constraints first, because they are the actual
reason. Memvid's failure is why the decision happened *when* it did, not why it
went the way it did.

---

## 1. What greppa actually needs from memory

Memory in greppa is **per scope** — one user, or one organisation. The product
promise is that "remember me" also means "open only my memory", and that
isolation should be a property of storage, not of every retrieval filter being
written correctly forever.

That promise produced an architecture: **one memory object per scope in
Cloudflare R2**, hydrated on demand into a bounded local cache by a layer called
Checkpoint. Checkpoint gives reads an immutable local generation, gives writes a
private working copy, and publishes changes under an ETag compare-and-set so two
processes cannot silently clobber each other.

Checkpoint's whole contract is one line:

```ts
read(key, fn: (localPath: string) => Promise<T>)
```

**It hands your callback a path to a file.** Everything else follows from that.

### The three constraints

1. **In-process.** The engine must run inside the Bun process and open a local
   path. There is no server to talk to, because the "database" was downloaded
   from object storage four milliseconds ago and may be evicted in five minutes.
2. **A local path.** Ideally a single file. Checkpoint publishes whole objects
   under a compare-and-set; a directory has no atomic equivalent in R2.
3. **A Bun-safe native surface.** Anything with an async N-API callback surface
   is a hazard, for reasons section 3 makes concrete.

These are not preferences. Each one is load-bearing, and together they are
brutal as a filter.

---

## 2. Why the obvious answers don't apply

The instinct is "just use a vector database". Every mainstream one fails
constraint 1 or 2:

| | in-process? | single file? | verdict |
| --- | --- | --- | --- |
| Qdrant, Weaviate, Milvus | ❌ server | — | wrong shape entirely |
| **Chroma** | ❌ **JS is server-only** | ❌ directory | see below |
| Zvec (Alibaba) | ✅ | ❌ directory | viable with packing |
| LanceDB | ✅ | ❌ directory | viable with packing |
| **SQLite + sqlite-vec** | ✅ | ✅ | **the only clean fit** |

Chroma deserves a specific note because it looks like the answer and isn't.
Embedded mode is **Python-only**. From Chroma's own documentation: *"To connect
with the JS/TS client, you must connect to a Chroma server."* There is no seam
where a hydrated directory becomes something the JS client can open. Several
secondary sources claim the JS client "has caught up"; they are conflating it
with Python.

**pgvector deserves a real hearing.** greppa already runs Postgres. Putting
memory in a `vector` column behind a tenant filter would delete Checkpoint,
hydration, the ETag dance, the byte budget and the 50 MiB ceiling in one move.
Appends become O(1) instead of republishing a whole file. It is genuinely
simpler.

We didn't, for one reason: **"your memory is a file you own" is a product
pillar, not an implementation detail.** A scope you can export, inspect, and
carry elsewhere is a different promise from a row in our database. If that
pillar ever gets dropped, pgvector is the correct answer and this whole layer
should go with it. That is a product decision, not an engineering one, and it
should be made deliberately rather than by drift.

---

## 3. What went wrong with Memvid

Memvid packages a scope's data, embeddings, indexes and recovery log into one
portable `.mv2` file. That is exactly the shape described above, which is why
greppa used it. Five findings, all measured on `@memvid/sdk@2.0.159`.

### 3.1 It was never doing semantic search — and that one was our fault

Stated correctly, because the first version of this document got it wrong:
**Memvid can generate embeddings, and it can accept yours.** `PutInput` exposes
both paths:

```ts
enableEmbedding?: boolean      // generate them
embeddingModel?: string        // "bge-small", "openai-small"
embedding?: number[]           // or supply your own
```

greppa passed none of them:

```ts
await mem.put({ title, label: sourceType, text, metadata })
```

So `create(path, 'basic', { enableVec: true })` allocated a vector index and
nothing ever filled it. One line — `enableEmbedding: true` — would have given
greppa working semantic retrieval on Memvid. This was an omission on our side,
not a missing capability, and it is **not** a reason we left.

The legitimate criticism is narrower: `enableVec` is a **create-time** option
while `enableEmbedding` is a **per-write** option, and the former's name implies
it turns vectors on. It produces a `stats()` reporting `has_vec_index: true`
over an empty index. That is a naming and observability trap, and it is why the
defect survived months undetected.

The evidence:

| probe | result |
| --- | --- |
| `stats()` after a normal `put()` | `has_vec_index: true`, `effective_vec_dimension: null` |
| `stats()` when an `embedding` is supplied | `effective_vec_dimension: 8` |
| `"feline pet animal"` vs *"the domestic cat is a small carnivorous mammal kept as a pet"* | **0 hits** |
| `"domestic cat carnivorous"` (literal word overlap) | 1 hit |

`has_vec_index: true` alongside `effective_vec_dimension: null` is the whole
story in one line: **the index existed and was empty.** Every "semantic" answer
greppa had ever returned was a BM25 keyword match. There was no error, no
warning, and no degraded-mode signal. It looked like it worked.

It also survived our own test suite, because every test query shared vocabulary
with its target document. The tests asserted that retrieval *returned something*,
not that it returned something a keyword search couldn't have found.

### 3.2 Size grew with the square of the write count

350 notes of roughly 2 KB each — about 700 KB of real text, and **no vectors** —
produced a 16.54 MiB file.

| documents | 50 | 100 | 150 | 200 | 250 | 300 | 350 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| MiB | 1.10 | 3.09 | 4.84 | 8.01 | 10.51 | 13.36 | 16.54 |

Nothing reclaims it. `seal()` returns in 47 ms and changes nothing. There is no
`compact()` on the SDK surface. Since the growth is driven by write count rather
than payload, a chatty scope hits the ceiling on *activity*, not on data.

For scale: a well-built store holding that same corpus *plus* real 1536-dimension
embeddings should be around 2–3 MiB, growing linearly.

### 3.3 A licensed 50 MiB ceiling, per file

`getCapacity()` returns `52428800`. The free-tier ticket reports
`issuer: "free-tier"`, `verified: false`. Raising it requires an `mv2_*` key that
fetches a cryptographically signed ticket, verified inside the native binary.

Combined with 3.2, the practical ceiling arrived at roughly **600 notes per
scope**. For a memory product, 600 notes is not a limit — it's a demo.

### 3.4 A closed prebuilt binary

The npm packages declare Apache-2.0, but what ships is a 47 MB
`memvid_sdk.node`. We could not read it, patch it, or rebuild it. Every finding
above was reached by black-box probing because there was no other option.

### 3.5 An unfixable hang in the write path

`putMany()` was observed under Bun to never settle. Sampling the process showed
the Rust tokio workers **parked** and the JS event loop **idle** — the native
work finished and the N-API callback never crossed back into JavaScript. No
error, no timeout, no recovery. A hang, in the write path, in a binary we cannot
debug.

Any one of these is survivable. Together they describe a dependency that cannot
be trusted with the product's core promise.

---

## 4. What "our own memory system" actually means

Precision matters here, because the phrase can overclaim.

**We did not write a vector index, a query planner, or a storage engine.** That
would be a bad use of time and would almost certainly be worse than what exists.

**We wrote the store**: the schema, the chunking, the hybrid retrieval and its
fusion, the embedding abstraction, the identity guarantees, and the migration
path. It sits on three components we did not write:

| layer | what it is | who wrote it |
| --- | --- | --- |
| storage engine | SQLite | not us — the most deployed database on earth |
| vector index | `sqlite-vec` (`vec0`) | not us — Apache-2.0/MIT, ~pre-1.0 |
| lexical index | FTS5 (BM25) | not us — ships inside SQLite |
| schema, chunking, fusion, ACL, providers, migration | **the store** | **us** |

The composition is the contribution: a single file that holds text, vectors and
a keyword index, that any SQLite tool can open, that Checkpoint can move around
as one object, and whose embedding provider can be swapped without re-ingesting
anything.

### Why this specifically, over Zvec or LanceDB

Both are credible in-process engines. Both store a **directory**, which means
tarring on write and untarring on hydration to rebuild the single-object
invariant Checkpoint already has for free — and both would come as N-API addons,
the exact failure class that had just cost us.

`bun:sqlite` is **built into Bun**. The driver is not an N-API addon at all.
`sqlite-vec` is a loadable C extension with a synchronous surface — far less
machinery than an async callback bridge. After a hang we could not debug, that
was worth a great deal.

---

## 5. What it bought

Same corpus, same 350 documents, measured on the same machine:

| | Memvid | ours |
| --- | --- | --- |
| ingest | 80.00 s | **0.18 s** |
| file size | 16.54 MiB *(no vectors)* | **7.63 MiB** *(with 1536-d vectors)* |
| vector query | not available | **3.39 ms** |
| lexical query | ~39 ms | **0.92 ms** |
| growth | quadratic, unreclaimable | linear, `VACUUM` available |
| ceiling | 50 MiB/file, licensed | none |

The speed is pleasant. It is not the point. **The point is that retrieval works
at all** — queries sharing no content words with their target documents now find
them, which is the thing the product claimed to do and did not.

Three properties matter more than the numbers:

- **Exact search, not approximate.** `sqlite-vec` scans every vector, which is
  100% recall. HNSW-based engines trade recall for speed. The "simple" option is
  the *most accurate* option at this scale.
- **The embedding model is ours to choose.** Behind an `EmbeddingProvider`
  interface, with identity pinned in the file and asserted on open, so a
  misconfiguration is a loud error instead of silently wrong distances.
- **Migration without re-ingestion.** Chunk text and image assets are the source
  of truth; vectors are a derived cache. `reembedScope()` rebuilds them for any
  provider at any dimension while BM25 keeps working throughout.

---

## 6. What we gave up

Not free. In rough order of how much it hurts:

- **Whole-file republish on every write.** Appending a 2 KB note to a 16 MB
  scope uploads 16 MB. Local insert: ~0.5 ms. Upload: seconds. This is
  inherited from Checkpoint, not new, but the store made local writes so cheap
  that the upload is now essentially the entire cost. Write coalescing is the
  highest-value outstanding work.
- **Brute-force scaling.** Fine to ~10k vectors per scope, painful past ~100k.
  No ANN index exists in this design.
- **We own the embedding bill and the failure modes.** Memvid at least intended
  to handle this. Now rate limits, latency and provider outages are ours.
- **`sqlite-vec` is pre-1.0.** Accepted deliberately: open and patchable beats
  closed and mature when the closed one has already failed silently.
- **A platform dependency we haven't fully verified.** Bun's bundled macOS
  SQLite refuses extension loading, so we fall back to Homebrew's. **Linux is
  unverified.** This is the one open risk in the design.

---

## 7. What would make us revisit

Honest triggers, so this doesn't become dogma:

- **"Memory as a file" stops being a product pillar** → move to pgvector and
  delete this layer plus most of Checkpoint. Simpler, and the right call.
- **A single scope routinely exceeds ~100k chunks** → brute force stops being
  viable; revisit Zvec or LanceDB and pay the directory-packing cost.
- **`sqlite-vec` is abandoned** → the data is plain SQLite and the vectors are a
  derived cache, so swapping the index is a `reembedScope()`, not a migration.
- **Write volume makes republishing untenable even with coalescing** → that is
  the point at which a VFS or a delta format earns its complexity.

---

## 8. The part worth generalising

The strongest argument for owning this layer is not performance. It is that
**a dependency which reports success while doing nothing is worse than one that
crashes.** A crash gets fixed the day it ships. `has_vec_index: true` with an
empty index shipped to production and stayed there, because everything looked
healthy from the outside and our own tests agreed.

Two things came out of that:

**Test the property, not the plumbing.** Retrieval is now verified with queries
that share *no vocabulary* with the documents they must find. That test cannot
pass on keyword matching, so it cannot pass with an empty vector index. It would
have caught the original defect on day one, and it is now the first test in the
suite.

**Prefer dependencies you can read.** Every finding in section 3 came from
black-box probing a binary we couldn't open. With SQLite and sqlite-vec, the
equivalent question is answered by reading the source. That was worth more than
any benchmark in this document.
