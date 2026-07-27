# Checkpoint serving plan

## Before production

- [ ] Run the scoped Checkpoint path through real multi-user and concurrent read/write workloads.
- [ ] Deploy the memory worker on a VPS or a hosted service with SSD-backed persistent storage; do not rely on a serverless filesystem for the checkpoint cache.
- [ ] Mount `CHECKPOINT_CACHE_DIR` on that persistent disk.
- [ ] Start conservatively with `CHECKPOINT_MAX_OPEN=8` or `16` and `CHECKPOINT_IDLE_MS=300000`.
- [ ] Set `CHECKPOINT_MAX_CACHE_BYTES` above the largest scope served, with headroom for a concurrent write (current + working clone + candidate).
- [ ] Limit per-process memory read/write concurrency until real RSS and latency measurements exist.
- [ ] Record cache hit rate, R2 hydration latency, R2 upload latency, local cache bytes, active snapshot count, and process RSS.
- [ ] Alarm on `checkpoint.overBudget` staying true; it means the budget is below the live working set.

## Make object transfers bounded

- [x] Replace R2 download buffering (`transformToByteArray()`) with a stream pipeline into the local `.mv2` cache file.
- [x] Replace upload buffering (`readFile()`) with a fresh `createReadStream(localPath)` passed to R2 for every upload attempt.
- [x] Keep the ETag conditional write behaviour. On conflict, discard the stale candidate, rehydrate the winning generation, and rerun the mutation against it. Each attempt opens its own read stream; streams are never reused.
- [x] Preserve the current invariant: only upload after Memvid has sealed the local file.

## Make the local cache capacity-aware

- [x] Add `maxCacheBytes` alongside `maxOpen`; file count alone is not enough for large scope memories.
- [x] Track each cached file's size on hydration and after successful writes, via `stat()` only.
- [x] Evict least-recently-used, idle, unreferenced scope files until both entry-count and byte budgets are satisfied.
- [x] Account for a private working generation during writes and retired generations pinned by active readers.
- [x] Define the over-budget contract: never evict a pinned generation, never fail a request for the budget, report via `overBudget`.
- [x] Reclaim generation files stranded by a crashed process (`sweepOrphans()`, opt-in via `CHECKPOINT_SWEEP_ON_BOOT=1`). Guarded against deleting a concurrent instance's live files, but a shared cacheDir remains unsupported.
- [ ] Consider physical-block accounting on copy-on-write filesystems; the current budget counts logical size, so an APFS `clonefile` working generation is over-counted until the writer diverges.

## Validate the 100 MB case

- [x] Build a reproducible, opt-in benchmark over a real Memvid `.mv2` and real R2 (`tests/live/checkpoint-bench.ts`).
- [x] Measure cold hydration, warm query, write/seal/upload, concurrent read+write, and two-instance ETag conflict.
- [x] Capture Node/Bun heap, process RSS, local disk use by generation kind, and R2 transfer time for each operation.
- [x] Confirm Memvid's mmap and segment caching keep query-time memory proportional to accessed index/pages rather than the entire file.
- [ ] **Blocked:** an actual ~100 MiB `.mv2` needs `MEMVID_API_KEY`. Memvid enforces a 50 MiB per-file ceiling on the free tier (`getCapacity()` → 52428800; ticket `issuer: "free-tier"`, `verified: false`). The limit is per file, not per account, so it binds per scope. Benchmarked at 16 MiB; rerun with `BENCH_TARGET_BYTES=104857600` once a key exists.
- [ ] Re-measure R2 transfer rates from the deployment host. The current numbers were taken on a ~4.4/2.4 Mbps link and are link-bound, not Checkpoint-bound (see `tests/live/r2-throughput.ts`).

## Memvid replacement — DONE

Memvid was removed from the scoped memory path on 2026-07-25. See
`docs/superpowers/specs/2026-07-25-scope-store-design.md` for why. Summary:

- [x] It was never doing semantic search. `enableVec: true` allocates an empty index; it does not generate embeddings, and `addScopedMemory` never supplied one. `stats()` reported `effective_vec_dimension: null` and semantic queries returned 0 hits. Scope search had been keyword-only BM25 in production.
- [x] `.mv2` grew with the square of the ingest count and nothing compacted it: 350 notes of ~2 KB (with zero vectors stored) produced 16.54 MiB, putting the 50 MiB ceiling near ~600 notes.
- [x] Replaced with SQLite + sqlite-vec + FTS5 behind unchanged public signatures. Measured on the same corpus: ingest 80.00 s -> 0.18 s, size 16.54 MiB -> 7.63 MiB (now including real 1536-d vectors), vector query 3.39 ms, lexical query 0.92 ms.
- [x] Adversarial retrieval verified against the live model: 4/4 queries sharing no content words with their target retrieved it correctly.

Legacy single-file memory (`lib/memory/{memvid,service,sync,r2}.ts`) still imports
`@memvid/sdk`. It is the pre-scopes global-file path and was deliberately left alone.

- [ ] Decide whether the legacy single-file memory path is dead code and remove it, or migrate it too.

## Scope store follow-ups

- [ ] **Verify sqlite-vec loads on the Linux VPS.** The only unverified link in the design. Confirmed on macOS only, and there Bun's bundled SQLite refuses extension loading, so `lib/memory/sqlite.ts` falls back to Homebrew's build. If the Linux bundled build also refuses, set `GREPPA_SQLITE_LIB` to a system libsqlite3.
- [ ] **Write coalescing.** Every note still re-uploads the whole scope file. Now the dominant cost: local insert is ~0.5 ms while upload is tens of seconds. Batch appends per scope behind a short debounce inside one `Checkpoint.write`.
- [ ] **zstd on the wire.** Measured 28.8% of raw on a representative file, roughly a 3.5x cut in upload time. Belongs in `R2Storage` as a streaming transform, orthogonal to the store.
- [ ] Probe the Google adapter against a live endpoint before using it in production. It is written but, unlike the OpenRouter adapter, has never been exercised.
- [ ] Consider reranking the fused top-50 before returning top-k; the largest remaining retrieval-quality lever.
- [x] Temporal weighting / forgetting: exponential decay from last touch, down-rank only, floor-bounded, off by default (`MEMORY_DECAY_*`). Schema v3 adds `chunks.created_at`, `last_accessed`, `access_count`.
- [ ] **Call `recordAccess()` from a write path.** Decay is currently age-only because reads are readonly; reinforcement needs to piggy-back on a real mutation. Pairs naturally with write coalescing.
- [ ] Tune the half-life against real usage before enabling decay in production. 30 days is a placeholder, not a measurement.

## Retrieval model

- [x] Embedding generation is now greppa's own, behind a pluggable `EmbeddingProvider`. Dev uses Nemotron Embed VL 1B v2 via OpenRouter (2048d, multimodal, `:free` suffix required). Production target is Gemini Embedding 2 at 1536.
- [x] Provider identity is pinned in the scope file's `meta` table and asserted on every open, so a model change can never silently produce garbage distances.
- [x] `reembedScope()` migrates a scope to a new provider or dimension without re-fetching sources: chunk text and assets are the source of truth, vectors are a derived cache.
