# Streaming Resume Window — Design

Date: 2026-07-03
Status: Approved, pending implementation plan

## Problem

Chat generation streams token-by-token over SSE (`/chat/stream?messageId=`). Replay
and resumption today have three gaps:

1. **Replay is bound to Realtime's retention, not a window we control.** `lib/emit.ts`
   single-writes each event to Upstash Realtime only. There is no durable event log.
   Resumption depends entirely on `lib/realtime.ts` `history: { expireAfterSecs: 3600 }`.

2. **The resume cursor is unreliable.** `routes/chat/stream.ts:54` compares
   `inner.id <= lastEventId` on **ULIDs**. Tokens are emitted many-per-millisecond and
   plain `ulid()` is random within a millisecond, so string ordering is not stable for
   sub-ms events. Resumption can drop or duplicate tokens. The `StoredEvent.seq` field
   is the real monotonic order and is currently unused for resumption.

3. **TTLs are incidental, not intentional.** Meta hash TTL is 1 h (`messageTtlMs`),
   Realtime history is 1 h, conversation history is 2 days. Past 1 h, resume silently
   returns `not_found`. None of these were chosen to express a resume policy.

## Goal

Replicate the OpenAI chat behaviour: leave a message that is still generating, come back
within a short window, and the stream resumes from the exact token where it stopped.
Past the window, the finished answer is shown from normal conversation history — there is
nothing to "resume", and nothing is retained longer than it needs to be.

## Design

### The resume window

A single knob, `resumeWindowMs`, default **5 minutes** (configurable 5–30 min), governs
every resume-related lifetime:

- the durable event log TTL,
- the Realtime history retention,
- the message meta (resume gate) TTL.

Within the window: pause/resume a live-or-just-finished stream. Past the window: the
finished message is rendered from the 2-day conversation history load path, not the stream.

### 1. Durable event log

`emit` dual-writes every event to a Redis ZSET `msg:<messageId>:events`:

- `score = seq` (monotonic per message)
- `member = JSON(StoredEvent)`
- `TTL = resumeWindowMs`, set in the same round-trip as the ZADD (pipeline)
- **Write order: ZADD first, Realtime emit second.** An event is not "emitted" until it
  is durable. If the Realtime emit fails after the ZADD, connected clients miss a live
  frame but every resume replays it; the reverse order could replay a log that lies by
  omission.

This ZSET is the authoritative, ordered replay source during the window. It holds all
event types including the terminal `done`/`error`, so a reconnect that lands just after
generation finishes replays cleanly.

Because the ZSET TTL refreshes on every ZADD, the log expires `resumeWindowMs` after the
*last* event. The meta TTL is re-anchored the same way (see item 4) so the gate and the
log expire together.

### 2. Swap ULID for a monotonic seq

Per-event random ULIDs are the root of the sub-ms ordering bug. Replace them with the
integer `seq` that `StoredEvent` already carries:

- `StoredEvent.id = String(seq)` — kept as a string so the `lib/realtime.ts` zod
  `storedEvent` schema (`id: z.string()`) is unchanged, but now deterministic and
  monotonic-parseable rather than random.
- The SSE event `id` is that same `String(seq)`.
- The resume cursor (`last-event-id`) is parsed back to an integer `seq` for ranging.
  **An unparseable cursor (including a legacy ULID from a client that reconnects across
  the deploy) is treated exactly like a stale cursor: full replay of the current log.**
- Control/error frames written directly by the stream handler (`not_found` etc.) carry
  **no SSE `id`** — any frame with an `id` updates the browser's `lastEventId`, and
  control frames must not poison the cursor. (Today they attach a fresh `ulid()`.)

`seq` is monotonic per message and per-message is exactly the SSE cursor scope, so no
global ordering guarantee is needed. `ulid()` remains for `messageId` and message record
ids — those are not emitted many-per-ms and are unaffected.

### 3. Minimize Realtime retention

With the ZSET as the sole replay source and the stream handler subscribing with
`history: false`, Realtime history has no reader. Set `lib/realtime.ts`
`history.expireAfterSecs` to a minimal transport buffer (60 s) rather than the window —
aligning it would store every token twice for the full window for nothing. Realtime is
the live-tail transport only.

### 4. Meta TTL to the window, re-anchored on activity

`msg:<messageId>:meta` TTL becomes `resumeWindowMs` (down from 1 h). Meta is the resume
gate, so its lifetime is the window. No 2-day bump. The existing `messageTtlMs`
config/env (`GREPPA_MESSAGE_TTL_MS`, default 1 h) is renamed to `resumeWindowMs`
(`GREPPA_RESUME_WINDOW_MS`, default 5 min); it is set at enqueue (`routes/chat.ts:60`).

The workflow **re-sets the meta TTL on every meta write, including the terminal
`done`/`error` status write** (`routes/workflows/chat.ts`). Without this the gate is
anchored at enqueue while the log is anchored at the last token, so a slow generation
silently eats the resume window (3 min of generation in a 5 min window leaves ~2 min of
real resumability). With it, both keys expire `resumeWindowMs` after last activity.

### 5. Stream handler — gap-free resume

Replace the current 50 ms poll loop with a subscribe-then-snapshot sequence:

1. Load meta. If missing or `conversationId` mismatch, emit `not_found` and return
   (unchanged gate; see item 6 for why these two cases share one signal).
2. Subscribe to Realtime with `history: false`, buffering incoming live events.
3. Snapshot the ZSET: `ZRANGEBYSCORE msg:<id>:events (cursor +inf` — or the full log
   if the cursor is stale or unparseable (see item 7). Emit each snapshot event as SSE.
4. Flush buffered live events whose `seq` is greater than the snapshot's max seq.
5. Tail live events until a terminal `done`/`error` is forwarded, then close.
6. **Liveness bound:** if no event arrives for `resumeWindowMs` (the workflow died
   without a terminal event and QStash exhausted retries), emit `error`
   (`code: stalled`) and close rather than tailing silently forever.

Forwarding dedupes by `seq` (skip `seq <= lastForwardedSeq`). This closes the race where
generation finishes between the meta read and the subscribe.

### 6. Past the window

Once the meta hash has TTL'd out, the server cannot distinguish "expired" from "never
existed" — the state is identical. And it must not distinguish either from a
`conversationId` mismatch, or the response pair would tell a prober that a messageId
exists but belongs to someone else. So there is **one signal, `not_found`, for all three
cases**, and the client owns the fallback: on `not_found`, render from the existing
conversation history load (`routes/chat/history.ts`, 2-day `sessionTtlMs`). The client
needs that history fallback anyway, so no `expired` signal, no tombstone key, no extra
retention. This is the "reconstruct for already finished" path: nothing to resume,
nothing lost.

### 7. Retry safety (minimal)

QStash may redeliver the workflow. Handling stays deliberately light:

- **Fresh workflow invocation:** if `meta.status` is already terminal (`done`/`error`),
  no-op return. A redelivery after success cannot double-write.
- **Otherwise:** `DEL msg:<id>:events` at the start of the run so a re-run streams one
  clean attempt rather than interleaving a stale attempt's events.
- **Stale-cursor guard:** if the client's cursor `seq` exceeds the log's current max seq
  (the log was reset by a retry) or does not parse as an integer (legacy ULID cursor),
  replay the full current log instead of ranging past it.
- `remember` keeps its content-hash idempotency; `search_knowledge` is read-only. No
  general per-tool checkpoint mechanism — out of scope.

**Known limitation:** if a client holds a cursor from attempt 1 and reconnects after a
rare mid-flight retry has already streamed past that seq, a few tokens can interleave.
Bounded and low-probability; not worth epoch bookkeeping for this workload.

## Files touched

- `lib/config.ts` — rename `messageTtlMs` -> `resumeWindowMs` (`GREPPA_RESUME_WINDOW_MS`,
  default 5 min).
- `lib/emit.ts` — drop per-event ULID for `seq`; dual-write (ZADD first) to
  `msg:<id>:events` ZSET with window TTL.
- `lib/realtime.ts` — `expireAfterSecs` = 60 s transport buffer.
- `routes/chat.ts` — meta TTL = window (via renamed config).
- `routes/chat/stream.ts` — seq cursor with unparseable-cursor fallback;
  subscribe-then-snapshot replay; no `id` on control frames; stalled-stream timeout.
- `routes/workflows/chat.ts` — terminal-status no-op guard; `DEL` events log at run
  start; re-set meta TTL on every meta write.
- `tests/server/config.test.ts` — follows the config rename.
- `.env.example` — document `GREPPA_RESUME_WINDOW_MS`.

## Testing

- Sub-ms ordering: emit many tokens in the same millisecond; assert seq-ordered replay
  with no drops or dups (regression for the ULID bug).
- In-flight resume: disconnect mid-stream, reconnect with `last-event-id`, assert
  continuation from the next seq with no gap and no repeat.
- Just-finished resume: reconnect after the terminal event within the window, assert the
  full log including `done` replays and the stream closes.
- Expired: reconnect after the window, assert `not_found` (not silence), and that it is
  byte-identical to the unknown-id and mismatched-conversation responses.
- Legacy cursor: reconnect with a ULID (or garbage) `last-event-id`, assert a full replay
  rather than an error or empty range.
- Slow generation: with a generation that spans most of the window, assert meta and log
  expire together `resumeWindowMs` after the terminal event (TTL re-anchoring).
- Stalled stream: no events and no terminal within the bound, assert the `stalled` error
  frame and stream close.
- Retry no-op: re-invoke the workflow with terminal meta, assert no second write to the
  events log or memory.
- Retry reset + stale cursor: reset the log mid-flight, reconnect with an out-of-range
  cursor, assert a full replay of the current attempt.

## Out of scope

- Durable retention beyond the resume window (the finished answer already lives in the
  2-day conversation history).
- General per-tool checkpoint/partial-progress recovery.
- Epoch/attempt bookkeeping for cross-retry cursor precision.
