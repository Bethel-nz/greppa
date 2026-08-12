# Deferred work

Known, deliberate omissions in the memory engine. Each was understood and
consciously left out — this file exists so the reasoning survives the decision,
and so the next person doesn't rediscover them as surprises. Nothing here is a
bug in shipped behavior; they are edges the current design does not yet cover.

---

## 1. Tombstoned rows are never reclaimed

**Where:** `lib/memory/scope-store/store.ts` (`deleteDocuments`, `LIVE_ONLY`,
`hasDeletedAt`), `lib/memory/scope-store/schema.ts` (`deleted_at`,
`documents_by_deleted`).

**What happens today.** A delete sets `documents.deleted_at` and every read path
filters it out (`d.deleted_at is null`). We tombstone rather than hard-delete on
purpose: `chunks_fts` is an external-content FTS5 table and `chunks_vec` is a
vec0 virtual table, so neither is reached by the row's foreign-key cascade.
Deleting the `documents` row would leave their entries dangling. Tombstoning
sidesteps that — the content simply stops being returned.

**What is missing.** Nothing ever removes the tombstoned rows or their chunks,
FTS entries, vectors, and edges. A tenant's per-scope SQLite file therefore
grows monotonically with every delete and never shrinks. Because a cold read
downloads the whole file, deletion silently raises steady-state read cost
instead of lowering it.

**Why deferred.** It never fails and never returns wrong data — it only wastes
space. Correctness was the priority; reclamation is an optimization.

**Shape of the fix.** A compaction pass, per scope, run out of band (not on the
delete path): inside a single `checkpoint.write`, delete the tombstoned
`documents` rows and explicitly delete their matching `chunks_fts` /
`chunks_vec` rowids and `memory_edges`, then let the file shrink on the next
flush. Gate it on age or on a tombstone-count / live-row ratio so it does not
run on every delete. It must be idempotent and safe to interrupt — a killed
compaction should leave a still-valid file, which the checkpoint's
copy-on-write staging already gives us for free.

---

## 2. Write amplification — no WAL

**Where:** the whole write path — `Checkpoint.write`
(`utils/checkpoint/checkpoint.ts`) and every `write*Scope` / `addScopedMemory`
caller.

**What happens today.** Each logical write copies the current generation of the
scope file (`COPYFILE_FICLONE`, so cheap locally), applies the mutation, and
flushes the **entire** file back to object storage via `putIfMatch` under an
etag CAS. One appended memory rewrites the full multi-hundred-KB file. Under
concurrent writers, the loser of the CAS hits `ConflictError`, invalidates, and
replays (`WRITE_ATTEMPTS = 2`); past that it surfaces the conflict.

**What is missing.** A write-ahead log. The user's intended design (their words,
recorded here so it isn't relitigated): push a per-tenant WAL, append every
write to it, and consolidate/compact into the base SQLite file out of band.
That turns the hot path into an append instead of a full-file rewrite, and lets
the expensive consolidation happen on its own cadence.

**Why deferred.** The user is designing this themselves and asked to circle back
to it. It is not blocked on anything in the codebase; it is a design they want
to own. Do not implement it speculatively.

**Constraints any implementation must respect.**
- The consolidation watermark and the base file must stay consistent under the
  same etag-CAS discipline the checkpoint already enforces — a reader must never
  see a base file that is missing WAL records it believes were consolidated.
- Recovery has to be deterministic: replaying the WAL from the last watermark
  must reproduce exactly the consolidated state, so records need stable ordering
  (a sequence, not wall-clock time).
- It has to compose with tombstone compaction (item 1) rather than fight it —
  ideally the same out-of-band pass.

---

## 3. `Checkpoint.write` has no no-op contract

**Where:** `utils/checkpoint/checkpoint.ts`, `write()` — specifically the
`rename(working.localPath, candidate.localPath)` at the end of a successful
attempt.

**What happens today.** `write(key, fn)` assumes `fn` leaves a file at
`localPath`. On an **existing** key that is fine — the current generation is
`COPYFILE_FICLONE`-copied into `working.localPath` before `fn` runs, so the file
is always there. The gap is a **brand-new** key (`entry.current === null`, no
copy happens) whose callback decides it has nothing to write and creates no
file. `sizeOf` tolerates the missing file (returns 0), but the subsequent
`rename` throws `ENOENT`, so a legitimate no-op write crashes instead of being a
clean no-op.

In practice callers avoid this — e.g. `writeExistingScope` / the org-scope
helpers `stat` first and only call `write` when there is something to persist,
precisely because this contract is unstated. So it is latent, not live.

**Why deferred.** It was acknowledged, not authorized. No shipped caller hits it
because every caller already works around it. Fixing it is worthwhile as
hardening, but it changes a public contract, so it should be a deliberate change
rather than a drive-by.

**Shape of the fix.** Treat "callback created no file" as a no-op: after `fn`
returns, if `working.localPath` does not exist (and there was no prior
generation to fall back to), skip the `rename`/`flush`/generation-swap entirely
and return the callback's result, leaving the key absent. Document the contract
explicitly on `write` so callers can rely on it instead of stat-guarding. Add a
test for the fresh-key no-op path.
