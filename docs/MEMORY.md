# greppa memory

greppa no longer uses Memvid. Scope memory is a store we wrote: **SQLite +
sqlite-vec + FTS5**, one database file per scope, served from Cloudflare R2
through the Checkpoint layer.

This document covers what it is, why we replaced Memvid, and — in detail —
what it does **not** do.

---

## 1. The shape

```
one scope  =  one SQLite file in R2  +  N immutable image blobs
              scopes/{scopeId}/memory.sqlite
              scopes/{scopeId}/assets/{sha256}
```

Inside the file:

| table | holds |
| --- | --- |
| `meta` | schema version and the embedding identity (model + dimension) |
| `documents` | one row per submitted memory: title, source type, URL, author |
| `chunks` | the retrievable units, with modality and optional asset reference |
| `chunks_fts` | FTS5 BM25 index (external-content, so text is not duplicated) |
| `chunks_vec` | sqlite-vec `vec0` index, `float[N]` where N is the provider's dimension |

Retrieval is hybrid: the vector index and the BM25 index each return up to 50
candidates, and the two ranked lists are merged with reciprocal rank fusion
(k=60). Vector distance and BM25 scores are not on comparable scales, so they
are combined by *rank*, never by value.

Checkpoint provides the storage semantics: reads get an immutable local
generation, writes get a private working copy that is sealed and published to
R2 under an ETag compare-and-set, and a lost compare-and-set re-hydrates and
reruns the mutation. A long read is never blocked by a write and never sees
torn bytes.

---

## 2. Why Memvid was removed

> For the full decision — the architectural constraints that drove it, the
> alternatives considered and rejected, and what was given up — see
> [why-own-memory.md](./why-own-memory.md). This section is the evidence summary.

Five findings, all measured on `@memvid/sdk@2.0.159` in July 2026.

**Semantic search was never active — our omission, not Memvid's limitation.**
`PutInput` accepts `enableEmbedding`, `embeddingModel` *and* a precomputed
`embedding`; greppa passed none of them, so `enableVec: true` allocated an index
that stayed empty. `stats()` reported `has_vec_index: true` with
`effective_vec_dimension: null`, and a query for *"feline pet animal"* against
*"the domestic cat is a small carnivorous mammal kept as a pet"* returned **zero
hits**. Scope search had been keyword-only BM25 in production while presenting
as semantic memory. One line would have fixed it on Memvid; the reasons we
actually migrated are the four below.

**File size grew with the square of the ingest count.** 350 notes of roughly
2 KB each — about 700 KB of actual text, and no vectors — produced a 16.54 MiB
file. Nothing compacts index history and `seal()` reclaims nothing, so the
practical ceiling arrived at roughly 600 notes.

| documents | 50 | 100 | 150 | 200 | 250 | 300 | 350 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| MiB | 1.10 | 3.09 | 4.84 | 8.01 | 10.51 | 13.36 | 16.54 |

**A licensed 50 MiB per-file ceiling.** `getCapacity()` returns `52428800`. The
free-tier ticket reports `issuer: "free-tier"`, `verified: false`. Lifting it
requires an `mv2_*` key that fetches a cryptographically signed ticket. The
limit is per file, so it binds per scope.

**A closed prebuilt binary.** The npm packages declare Apache-2.0, but what
ships is a 47 MB `memvid_sdk.node`. It cannot be read, patched, or rebuilt.

**An unfixable hang in the write path.** `putMany()` was observed under Bun to
never settle: the tokio worker threads parked and the N-API callback never
reached JavaScript, leaving the event loop permanently idle. No error, no
timeout, no recourse from our side.

### What replaced it, measured on the same corpus

| | Memvid `.mv2` | our store |
| --- | --- | --- |
| ingest, 350 documents | 80.00 s | **0.18 s** |
| file size | 16.54 MiB *(no vectors)* | **7.63 MiB** *(with 1536-d vectors)* |
| vector query | not available | **3.39 ms** |
| lexical query | ~39 ms | **0.92 ms** |
| growth | quadratic, unreclaimable | linear, `VACUUM` available |
| ceiling | 50 MiB/file, licensed | none |

Adversarial retrieval, verified against the live embedding model — every query
sharing **zero content words** with its target document:

```
"when did the cat see the animal doctor"    → vet visit    ✓
"how did the business perform financially"  → q3 numbers   ✓
"why was the software release reverted"     → deploy note  ✓
"instructions for cooking dinner"           → recipe       ✓
```

---

## 3. Embeddings

Embedding generation is ours, behind a pluggable `EmbeddingProvider`:

```ts
interface EmbeddingProvider {
  readonly id: string           // written to meta, e.g. "google/gemini-embedding-2@1536"
  readonly dimension: number    // never a module constant
  readonly maxBatchSize: number
  embed(texts: string[], kind: 'document' | 'query'): Promise<Float32Array[]>
  embedImage?(assets: Array<{ bytes: Uint8Array; mime: string }>): Promise<Float32Array[]>
}
```

Providers: `openrouter` (Nemotron Embed VL 1B v2, 2048-d, multimodal),
`google` (Gemini Embedding, 768/1536/3072), `openai-compatible` (OpenAI,
NVIDIA NIM, self-hosted), and `deterministic` (offline, tests only).

Two contracts matter:

**`kind` is not cosmetic.** Retrieval models are asymmetric. On Nemotron,
omitting `input_type` produces a vector byte-identical to `input_type: "query"`,
so documents indexed without it land in the wrong half of the model's space.
This is silent — no error, just degraded ranking.

**Output must be L2-normalized.** Gemini pre-normalizes only its 3072-d output;
truncated sizes are not normalized. The store compares with dot product, so an
unnormalized vector produces silently wrong distances. Adapters normalize
unconditionally, and a shared conformance test asserts it.

The provider identity is pinned in `meta` and asserted on every open. Querying
across models is refused with `EmbeddingIdentityError`, because mixing them
returns plausible-looking nonsense rather than an error.

Switching provider or dimension is `reembedScope()`: chunk text and assets are
the source of truth, vectors are a derived cache. `documents`, `chunks` and
`chunks_fts` are untouched, so BM25 keeps working throughout and nothing is
re-fetched from source.

---

## 4. Limitations

Read this section before relying on any of it.

### Every write re-uploads the entire scope file

Checkpoint publishes whole objects under a compare-and-set. Adding a 2 KB note
to a 16 MiB scope uploads 16 MiB. Local insertion takes about 0.5 ms; the
upload dominates by four orders of magnitude. **Write coalescing is the single
most valuable outstanding optimisation** and is not implemented.

### Retrieval latency is exact, but brute force

`sqlite-vec` scans every vector. That is a correctness *advantage* — 100%
recall, where HNSW-based engines are approximate — but cost grows linearly.
Measured 3.39 ms over 350 vectors at 1536 dimensions; expect roughly 100 ms at
10k and about a second at 100k **within a single scope**. There is no ANN
index. Personal-scale memory is comfortably inside this envelope; a scope with
100k+ chunks is not.

### Cold hydration is proportional to file size, not to bytes read

Checkpoint is a whole-object cache, not a VFS. A cold read downloads the entire
scope before answering, so first-query latency scales with total scope size
regardless of how little the query touches. Warm queries hit the local
generation and make zero network calls.

### Image assets are not fetched during retrieval

Search returns `assetSha256`, not resolved URLs or bytes. Presigning and
delivery belong to the route layer. Retrieval never touches R2 for assets, so
an unavailable asset cannot fail a search.

### Deletes are not implemented

The public interface only appends. `chunks_fts` is an external-content FTS5
table, so a future delete must use the
`INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES('delete', ...)`
protocol before removing the underlying row. A plain `DELETE` silently
desynchronises the index.

### Reinforcement requires a write

Temporal decay (`MEMORY_DECAY_ENABLED`) runs from a chunk's last touch, but
reads open the database **readonly** against an immutable Checkpoint
generation — so a search cannot bump `last_accessed`. Turning a query into a
write would re-upload the whole scope file. `recordAccess()` is therefore
exported for callers to invoke inside an existing `Checkpoint.write`,
piggy-backing on a real mutation. Until something calls it, decay measures age
from `created_at` only, which is recency bias rather than true forgetting.

### No reranking

The fused top-k is returned as-is. A cross-encoder or LLM rerank over the top-50
is the largest remaining retrieval-quality lever and is not implemented.

### sqlite-vec extension loading is platform-sensitive

Bun's bundled SQLite on macOS is built without dynamic extension loading, so
`lib/memory/sqlite.ts` falls back to a Homebrew libsqlite3. **Loading has not
been verified on Linux.** If the bundled Linux build also refuses extensions,
set `GREPPA_SQLITE_LIB` to a system libsqlite3. This is the one unverified link
in the design.

### `sqlite-vec` is pre-1.0

Version 0.1.9. Accepted deliberately: it is open source and patchable, unlike
what it replaced.

### Provider adapters differ in verification status

`openrouter` is verified against the live endpoint — text, image, and combined
text+image, all returning 2048-d vectors. **`google` is written but has never
been run**; it must be probed before production use.

### WAL is disabled, deliberately

Scope databases run `journal_mode = DELETE`. WAL writes `-wal` and `-shm`
sidecars, and Checkpoint manages exactly one path, so a sidecar would be
silently omitted from the upload and lose data. WAL's concurrency benefit is
irrelevant here because Checkpoint already serialises writes per scope.

### Byte accounting is logical, not physical

`CHECKPOINT_MAX_CACHE_BYTES` counts logical file size. On copy-on-write
filesystems an APFS `clonefile` working generation shares blocks with its
parent, so the budget over-counts until the writer diverges.

### The budget can be exceeded

Eviction never deletes a generation an active reader is using, and never fails
a request to stay under budget. When everything cached is pinned, the cache
runs over budget and reports it on `checkpoint.overBudget`. A single scope
larger than the whole budget is over budget for the entire duration of every
read of it.

---

## 5. Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `CHECKPOINT_CACHE_DIR` | `./.greppa/checkpoint` | Must be persistent SSD-backed storage, never a serverless filesystem |
| `CHECKPOINT_MAX_OPEN` | `64` | Maximum scopes held open; start at 8–16 |
| `CHECKPOINT_MAX_CACHE_BYTES` | `2gb` | Byte budget; accepts `512mb`, `8gb` |
| `CHECKPOINT_IDLE_MS` | `300000` | Idle sweep threshold |
| `EMBEDDING_PROVIDER` | `deterministic` | `openrouter` \| `google` \| `openai-compatible` \| `deterministic` |
| `EMBEDDING_MODEL` | per provider | Note: OpenRouter requires the `:free` suffix on the Nemotron model id |
| `EMBEDDING_DIM` | per provider | Fixed at scope creation; changing it requires `reembedScope()` |
| `GREPPA_SQLITE_LIB` | auto | Override the libsqlite3 used, for extension-loading issues |

Set the real provider in `.env.local`, not `.env`. Bun skips `.env.local` when
`NODE_ENV=test`, so `bun run` picks up the real provider while `bun test` stays
offline and free. This is deliberate — moving `EMBEDDING_PROVIDER` into `.env`
would make the test suite start issuing paid API calls.
