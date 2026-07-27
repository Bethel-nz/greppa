# Scope Store — design

**Date:** 2026-07-25
**Status:** approved, not yet implemented
**Replaces:** `@memvid/sdk` as greppa's per-scope memory engine

---

## 1. Why

Greppa stores one memory file per scope (user or org) in R2, served by the Checkpoint
layer. That engine was `@memvid/sdk@2.0.159`. Measurement on 2026-07-24/25 found five
disqualifying problems.

**It was never performing semantic search.** `create(path, 'basic', { enableVec: true })`
allocates an empty vector index; it does not generate embeddings. `PutManyOptions.enableEmbedding`
defaults to `false`, and `put()` stores a vector only when the caller supplies one.
`lib/memory/scoped-service.ts` passed `title`, `text` and `metadata` — never an `embedding`.

Evidence:

| probe | result |
| --- | --- |
| `stats()` after a normal `put()` | `effective_vec_dimension: null`, `embedding_identity: null` |
| `stats()` when the caller supplies `embedding` | `effective_vec_dimension: 8` |
| query `"feline pet animal"` vs doc `"the domestic cat is a small carnivorous mammal kept as a pet"` | **0 hits** |
| query `"domestic cat carnivorous"` (literal overlap) | 1 hit |

So `searchScopedMemory` has been keyword-only BM25 in production.

**Quadratic growth with no reachable compaction.** 350 frames of ~2 KB text — roughly
700 KB of content, and zero stored vectors — produced a 16.54 MiB file. `seal()` reclaims
nothing (47 ms, size unchanged) and no `compact()` exists on the SDK surface. Fitting
`bytes ≈ c·n²` puts the 50 MiB ceiling near 600 notes.

| frames | 50 | 100 | 150 | 200 | 250 | 300 | 350 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| MiB | 1.10 | 3.09 | 4.84 | 8.01 | 10.51 | 13.36 | 16.54 |

**A licensed 50 MiB per-file ceiling.** `getCapacity()` returns `52428800`; the free-tier
ticket reports `issuer: "free-tier"`, `verified: false`. Lifting it needs an `mv2_*` key
that fetches a cryptographically signed ticket. The limit is per file, so it binds per scope.

**A closed 47 MB prebuilt native binary.** The npm packages declare Apache-2.0, but what
ships is `memvid_sdk.node`. It cannot be read, patched, or rebuilt.

**An unfixable hang in the write path.** `putMany()` was observed once under Bun to never
settle: tokio workers parked, the N-API callback never reached JS, the event loop went idle
permanently.

### What is not the problem

Checkpoint. Measured overhead is **3 ms** on a 2.59 s hydration and **3 ms** of
clone/rename/bookkeeping on a write. It is correct and stays unchanged.

---

## 2. Goals

- Real semantic retrieval, with an adversarial test that would have caught the above.
- Linear growth, with compaction available.
- No per-file ceiling and no licence gate.
- An engine whose source can be read and patched.
- No N-API async-callback surface in the hot path.
- Embedding provider swappable by configuration, with a lossless migration.
- Multimodal memory: images, screenshots, PDF pages, charts.
- `checkpoint.ts` unmodified.
- Public signatures of `addScopedMemory` / `searchScopedMemory` / `askScopedMemory` unchanged.

## 3. Non-goals

- Sharding a scope across multiple objects.
- A VFS or range-GET pager.
- A distributed lock. The ETag compare-and-set already provides cross-process safety.
- Approximate-nearest-neighbour indexing. Brute force is 100% recall and fast enough at
  this scale; revisit past ~50–100k vectors in a single scope.
- Migration tooling for existing `.mv2` data. The bucket is empty (0 objects under every
  prefix); this is greenfield.

---

## 4. Architecture

```
routes  →  lib/memory/scoped-service.ts        public API, signatures unchanged
             ↓
           lib/memory/scope-store/             NEW
             ↓
           utils/checkpoint/                   UNCHANGED
             ↓
           utils/r2.ts                         + content-addressed assets
```

### Guiding principle

**Text and assets are the source of truth. Vectors are a derived cache, rebuildable for any
provider at any dimension.** Every design decision below follows from this.

### Modules

| module | responsibility |
| --- | --- |
| `lib/memory/sqlite.ts` | Extension-loading shim; resolves a SQLite build that supports `loadExtension` |
| `lib/memory/embedding/provider.ts` | `EmbeddingProvider` interface and the normalization contract |
| `lib/memory/embedding/deterministic.ts` | Seeded provider; every unit test runs offline |
| `lib/memory/embedding/openrouter.ts` | Nemotron Embed VL 1B v2 (2048d, text + image) |
| `lib/memory/embedding/google.ts` | Gemini Embedding 2 (768/1536/3072) — production target |
| `lib/memory/embedding/index.ts` | `getEmbeddingProvider()` from environment |
| `lib/memory/scope-store/schema.ts` | DDL and `schema_version` migrations |
| `lib/memory/scope-store/store.ts` | open, insert, hybrid search |
| `lib/memory/scope-store/chunker.ts` | Text splitting |
| `lib/memory/scope-store/fusion.ts` | Reciprocal rank fusion |
| `lib/memory/scope-store/reembed.ts` | Provider-switch migration |
| `lib/memory/assets.ts` | Content-addressed asset put/get |

---

## 5. Storage layout

```
scopes/{scopeId}/memory.sqlite        the scope database (Checkpoint-managed, CAS-published)
scopes/{scopeId}/assets/{sha256}      immutable image blobs (write-once, no CAS)
```

Assets are separate because Checkpoint rewrites the whole scope file on every write. A scope
holding 20 MiB of screenshots would re-upload all 20 MiB to add a 2 KB note — about 72 s on a
0.28 MiB/s uplink, growing without bound. Content-addressed blobs are written once, deduplicated
by hash, fetched lazily, and cannot conflict.

Consequence: "export my memory" is a bundle of the database plus its assets, not a single file copy.

---

## 6. Schema

```sql
meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
-- schema_version, embedding_provider, embedding_model, embedding_dim, created_at

documents(
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  source_type  TEXT NOT NULL,      -- note | chat | document | webpage | agent_event
  source_url   TEXT,
  created_by   TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  meta_json    TEXT
);

chunks(
  id           INTEGER PRIMARY KEY,
  document_id  TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  ordinal      INTEGER NOT NULL,
  text         TEXT NOT NULL,      -- always stored: makes re-embedding possible
  modality     TEXT NOT NULL,      -- text | image | text_image
  asset_sha256 TEXT,
  asset_mime   TEXT
);

CREATE VIRTUAL TABLE chunks_fts USING fts5(
  text, content=chunks, content_rowid=id
);

CREATE VIRTUAL TABLE chunks_vec USING vec0(
  embedding float[N]               -- N = provider.dimension, never hardcoded
);
```

**Row identity.** `chunks_vec.rowid` and `chunks_fts.rowid` are both set to `chunks.id`. All
three tables are joined on that single integer, so fusion works on rowids without a mapping table.

**Chunk text is always stored**, which is what makes `reembedScope` possible without re-fetching
original sources. For image chunks, `text` holds whatever caption, alt text, or OCR output is
available; it may be empty, in which case **no `chunks_fts` row is inserted** and the chunk is
retrievable by vector only.

**Deletes are out of scope for v1.** The public interface only appends. Note for whoever adds
them: `chunks_fts` is an external-content FTS5 table, so deletes require the
`INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES('delete', ...)` protocol before removing
the underlying row — a plain `DELETE` silently desynchronises the index.

### Chunking parameters

Target ~1000 characters per chunk with ~150 characters of overlap, splitting on paragraph
boundaries first, then sentence boundaries, then a hard character cut. Short submissions (notes,
chat messages) fall through as a single chunk. These values are constants in `chunker.ts` and are
covered by unit tests, so tuning them is a one-line change plus a test update.

### SQLite pragmas — required for correctness

**`journal_mode = DELETE`.** WAL mode creates `-wal` and `-shm` sidecar files. Checkpoint
manages exactly one file path, so a WAL sidecar would be silently omitted from the upload and
lose data. WAL's concurrency benefit is irrelevant here: Checkpoint already serialises writes
per scope, and readers each hold their own immutable generation.

**Reads open read-only.** Multiple concurrent readers share one immutable generation file. A
read-write handle could mutate a file other readers are using. Every read path opens with
`{ readonly: true }`.

**`foreign_keys = ON`.** SQLite disables foreign-key enforcement by default, so the
`chunks.document_id` cascade is inert without it. Set per connection, not per database.

---

## 7. Embedding provider contract

```ts
export interface EmbeddingProvider {
  /** Stable identity written to meta, e.g. "google/gemini-embedding-2@1536". */
  readonly id: string
  /** Configured at construction. Never a module constant. */
  readonly dimension: number
  /** Providers differ; the store batches requests to fit. */
  readonly maxBatchSize: number
  /** Output MUST be L2-normalized. See below. */
  embed(texts: string[], kind: 'document' | 'query'): Promise<Float32Array[]>
  embedImage?(assets: Array<{ bytes: Uint8Array; mime: string }>): Promise<Float32Array[]>
}
```

**`kind` is not cosmetic.** Retrieval models are asymmetric. It maps directly onto Google's
`task_type` (`RETRIEVAL_DOCUMENT` / `RETRIEVAL_QUERY`). Embedding a query as a document
measurably reduces recall.

**Normalization is a hard contract.** Gemini Embedding 2 pre-normalizes only its 3072-dim
output; truncated outputs are not normalized. OpenAI and Nemotron return unit vectors. If the
store assumes normalization and the provider does not deliver it, distances are silently wrong —
the same class of failure as the missing embeddings. Adapters normalize when the upstream API
does not, and a shared conformance test asserts `‖v‖ ≈ 1` for every provider.

### Configuration

```
EMBEDDING_PROVIDER=openrouter|google|deterministic
EMBEDDING_MODEL=nvidia/llama-nemotron-embed-vl-1b-v2
EMBEDDING_DIM=2048
OPENROUTER_API_KEY=...
GOOGLE_API_KEY=...
```

Development uses Nemotron VL on OpenRouter's free tier. Production targets Gemini Embedding 2
at 1536. Switching is an environment change plus one `reembedScope` pass per scope.

---

## 8. Data flow

### Write

```
addScopedMemory(input)
  chunks   = chunk(input.text)
  vectors  = await provider.embed(chunks, 'document')      ← network, NO lock held
  assetRef = await putAssetIfAbsent(sha256, bytes)         ← network, NO lock held
  checkpoint.write(key, (path, exists) => {                ← lock held for local work only
      db = openScope(path, exists, provider)               // creates schema if !exists
      assertIdentity(db, provider)
      transaction {
        insert document
        insert chunks + chunks_fts + chunks_vec
      }
      db.close()                                           // before Checkpoint seals
  })
```

Embeddings are computed **before** taking the Checkpoint lock. This keeps the per-scope mutex
held for milliseconds rather than a network round trip, and makes the conflict-rerun path cheap:
a rerun replays local inserts without re-billing the embedding API.

### Read

```
searchScopedMemory({ query, limit })
  qvec = await provider.embed([query], 'query')            ← network, NO lock held
  checkpoint.read(key, path => {
      db = openReadOnly(path)
      assertIdentity(db, provider)
      vecHits = chunks_vec top-50 by distance
      ftsHits = chunks_fts top-50 by bm25
      fused   = rrf(vecHits, ftsHits, k = 60) → top-`limit` (default 8)
      hydrate chunk text + parent document
  })
  resolve asset URLs for image chunks
```

### Provider switch

```
reembedScope(key, newProvider)
  checkpoint.write(key, (path) => {          ← atomic, CAS-protected, one upload
      db = openScope(path, true, newProvider)
      for each batch of chunks:
        text chunks  → newProvider.embed(chunk.text, 'document')
        image chunks → fetch assets/{sha256} → newProvider.embedImage(...)
      DROP TABLE chunks_vec
      CREATE VIRTUAL TABLE chunks_vec USING vec0(embedding float[newDim])
      reinsert all vectors
      update meta with the new identity
  })
```

`documents`, `chunks`, `chunks_fts` and every asset are untouched. BM25 search keeps working
throughout. Only the derived vectors change.

Note: this is the one place embeddings are computed inside the lock, because re-embedding needs
the chunk text that lives in the file. Acceptable — it is a rare, explicitly-invoked migration.

---

## 9. Error handling

| condition | behaviour |
| --- | --- |
| `meta` identity ≠ live provider | throw `EmbeddingIdentityError`. Never query across models. |
| Embedding provider failure | propagate. Never write a chunk without its vector. |
| Partial write | impossible: document, chunks, FTS and vectors go in one transaction. |
| `NotFoundError` from Checkpoint | empty result, preserving today's behaviour. |
| SQLite extension load failure | explicit error at startup naming the fix. |
| Asset fetch failure during read | return the chunk with its text, mark the asset unavailable. |

---

## 10. `askScopedMemory`

Memvid's `ask()` disappears. Reimplemented as retrieve → prompt Groq through the `ai` SDK
already in `package.json`, returning `{ answer, sources }` in the current shape so the route
contract is unchanged.

---

## 11. Testing

**Offline unit tests** — chunker, RRF, schema migration, identity assertion, provider
normalization conformance. All use `deterministic.ts`; no network, no credentials.

**Adversarial retrieval test** — queries that share *no vocabulary* with their target document
must still retrieve it. This is precisely the test that would have caught the Memvid bug, and it
must fail if embeddings are ever absent or mismatched.

**Provider-switch test** — ingest with provider A at dimension X, `reembedScope` to provider B at
dimension Y, assert retrieval still works and `meta` is updated. Exercises the Google migration in
CI long before production.

**Live end-to-end** — through real Checkpoint and real R2, opt-in behind the existing
`CHECKPOINT_LIVE_R2` gate, reusing `tests/live/support.ts`.

---

## 12. Build order

1. `sqlite.ts` shim + `EmbeddingProvider` interface + deterministic provider
2. `schema.ts` + `store.ts` open/create with identity assertion
3. `chunker.ts` + `fusion.ts`, with unit tests
4. Insert and hybrid search; adversarial retrieval test
5. `openrouter.ts` (Nemotron VL) + `google.ts` (Gemini Embedding 2)
6. `assets.ts` and the image ingest path
7. Rewire `scoped-service.ts`; reimplement `askScopedMemory`
8. `reembed.ts` + provider-switch test
9. Live end-to-end suite

---

## 13. Risks

| risk | status |
| --- | --- |
| sqlite-vec extension loading on the Linux VPS | **unverified.** Confirmed working on macOS only via `Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib')`. Bun's bundled macOS SQLite refuses `loadExtension`. Must be verified on the deploy host before production. |
| OpenRouter free-tier rate limits | unknown; dev-only dependency |
| Brute-force KNN at 2048 dims | ~2× the measured 3.39 ms/query at 1536 dims over 350 vectors. Acceptable; revisit past ~50k vectors per scope. |
| `sqlite-vec` is v0.1.9, pre-1.0 | accepted. Open source and patchable, unlike the alternative. |
| Whole-file re-upload per write | unchanged from today. Write coalescing and zstd-on-the-wire are follow-ups, tracked separately in `todo.md`. |

---

## 14. Measured baseline

Same corpus, 350 chunks of ~2 KB text, this machine:

| | Memvid `.mv2` | SQLite + sqlite-vec + FTS5 |
| --- | --- | --- |
| ingest | 80.00 s | **0.18 s** |
| file size | 16.54 MiB (no vectors) | **7.63 MiB** (incl. 1536-dim vectors) |
| vector query | not available | **3.39 ms** |
| lexical query | ~39 ms p50 | **0.92 ms** |
| growth | quadratic, unreclaimable | linear, `VACUUM` available |
| zstd on the wire | — | **2.20 MiB** (28.8%) |
| ceiling | 50 MiB/file, licensed | none |
