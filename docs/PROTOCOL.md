# The greppa protocol

greppa treats an LLM chat turn as a **durable workflow**, not a blocking HTTP call. A message is enqueued, generated out of band, streamed from a durable log, and can be resumed from the exact token where a connection dropped. Conversations and knowledge are session-scoped and survive refreshes, network failures, and tab closures.

This document describes the protocol in terms of the capabilities it needs, then shows the concrete choices greppa makes as one reference implementation. Where a choice is swappable, it says so. If you want to build your own, section 7 is the checklist.

---

## 1. The core problem

Most chat APIs are synchronous request/response: you `POST` a message and hope the connection survives while the model thinks. It usually does not survive everything. A refreshed tab, a flaky network, a closed laptop, a load-balancer timeout, a cold serverless function — any of these ends the request, and with it the generation. The user is left with half an answer and no way back to it.

The naive fixes do not hold:

- **Just retry the request.** The model starts over. You pay twice and the user waits twice, and a long answer may never finish inside one connection's lifetime.
- **Just use a longer timeout.** You are still betting the entire generation on a single unbroken connection. The bet gets more expensive as answers get longer.
- **Just use `EventSource`.** It reconnects and resends `Last-Event-ID` for free, but it is `GET`-only: it cannot carry a request body or an auth header, so it cannot start a chat. (See section 6.)

The real requirement is to decouple three things that blocking chat welds together: **accepting the request**, **doing the work**, and **delivering the output**. Once they are separate, a dropped connection is a delivery problem, not a lost-work problem.

---

## 2. Mental model

Three moves:

1. **Enqueue** — accept the message, return an id immediately, run the generation out of band.
2. **Stream** — deliver events from a durable log; on reconnect, replay from a cursor, then tail live.
3. **Remember** — session state and knowledge outlive any single request.

The spine of the whole design is a **durable, ordered event log** per message. Everything else is how you fill it and how you read from it.

---

## 3. Layer 1 — Resumable streaming

This is the core of the protocol.

### 3.1 Two components with different jobs

Streaming needs two capabilities that look similar but are not:

- **A durable executor** — runs the slow, failable generation reliably, off the request path, with retries.
- **A durable log** — records every event the generation produces, in order, so any reader (including one that reconnects) can catch up.

greppa uses **QStash** (Upstash Workflow) for the first and **Redis** (Upstash Redis) for the second. They are not redundant. The one-liner:

> QStash *runs the work*; Redis *holds the state the work produces*.

**QStash — the durable executor.** `POST /chat` does not run the model. It writes a little meta, tells QStash to call back a `/workflows/chat` endpoint with the payload, and returns `202` with a `messageId` right away. QStash then delivers that call over HTTP (it pushes to your endpoint; you do not run a polling worker), retries on failure, and checkpoints each workflow step so a retry does not redo completed work.

> Requires: a queue / durable-execution service that pushes to an HTTP endpoint with retries.
> greppa uses: Upstash Workflow (QStash), triggering `${PUBLIC_URL}/api/v1/workflows/chat`.
> Swap in: any durable job runner (Inngest, Temporal, a Redis-backed worker you own).

**Redis — the durable log.** As the workflow runs, each event (`cue`, `sources`, `token`, `done`, `error`) is written to a sorted set `msg:<id>:events`, scored by a monotonic `seq`. That set is the authoritative replay source. The message's `meta` (status, model, conversation) lives in a hash beside it. A live-tail transport carries the same events to already-connected clients so they see tokens with no polling.

> Requires: a store with ordered, scored entries and a TTL, plus a live pub/sub transport.
> greppa uses: Upstash Redis ZSET scored by `seq` (+ EXPIRE), Upstash Realtime for the live tail.
> Swap in: any sorted-set KV (Redis, KeyDB) + any pub/sub (Realtime, Pusher, raw WebSocket).

### 3.2 The flow

```
POST /chat ──enqueue──▶ QStash (durable executor)
   │  (returns messageId now)      │ retries, checkpoints steps
   ▼                               ▼
Redis: msg:<id>:meta     calls /workflows/chat ──runs the model──▶ emit(event)
                                                                     │
                         Redis ZSET msg:<id>:events  ◀── durable ────┤
                         (scored by seq)                 log         │
                                                                     └─▶ live tail
   ▲
GET /chat/stream ── snapshot ZSET + replay from seq cursor, then tail ──▶ client
```

### 3.3 Reading the log: subscribe, snapshot, replay, tail

The stream handler must never miss an event that arrives between "read the log so far" and "start listening live." So the order is deliberate:

1. **Subscribe first** to the live tail and buffer anything that arrives.
2. **Snapshot** the ZSET (the durable log up to now).
3. **Replay** every event with `seq` greater than the client's cursor.
4. **Drain** the buffered live events (as a queue), then flip to tailing directly.
5. **Tail** live events until a terminal event (`done` / `error`) or the stall bound.

Subscribing before snapshotting closes the gap where a freshly produced event could fall between the two.

### 3.4 Resume via `last-event-id`

Every replayed or tailed event carries `id: <seq>`. A client that drops reconnects with the `Last-Event-ID` header set to the last `seq` it saw. The handler parses it (strictly — a non-numeric legacy id triggers a full replay rather than a partial parse), and replays only events after that cursor. Because `seq` is monotonic and the log is the source of truth, resume is just "re-read the tape from where you were." A forward guard (`event.seq <= lastSeq` is dropped) makes replay-then-tail safe against a duplicate at the boundary.

Control frames the handler writes directly — `bad_request`, `not_found`, `stalled`, `incomplete` — carry **no `id`**, so they never advance a client's cursor. Only real log events do.

### 3.5 One time window

A single duration governs three things at once:

- the TTL of the event log,
- the TTL of the message meta,
- the bound on a stalled stream (a producer that stops emitting).

greppa calls this the **resume window** (`resumeWindowMs`, default 5 minutes). Inside the window, a reconnecting client resumes from the live log. Past it, the log is gone by design, and the finished answer is served from the longer-lived conversation history instead of the stream. Collapsing these into one number means there is one thing to reason about, not three that can drift out of sync.

---

## 4. Layer 2 — Session-scoped memory

> **This layer is not part of the protocol.** Sections 1–3 describe a
> client-server contract you could reimplement from the spec. Memory is an
> implementation greppa happens to have. The *requirement* is protocol-shaped —
> retrieval must resolve to an isolated scope before it runs — but the schema,
> retrieval strategy, and access model below are product decisions, and greppa's
> get more opinionated over time. Take the requirement; ignore the choices.

A chat that forgets is a demo. greppa gives every conversation durable history and an optional knowledge base to ground answers.

- **History** — each turn is appended to a per-conversation log with its own (longer) TTL, so a conversation survives well past any single stream's resume window.
- **Knowledge** — documents are ingested, chunked, and embedded; at chat time the assistant decides via tool-use whether to search the knowledge base and ground its answer, or just talk.

The interesting part is where the knowledge store lives. A native memory file (one blob per scope) is not something you want to re-download on every read or corrupt with concurrent writes. So greppa fronts object storage with a **checkpoint layer**:

- a local cache of the memory blob, hydrated from object storage on first use,
- a per-key mutex so writes to one scope serialize,
- reads pinned to an immutable local generation, so RAG queries do not copy the complete memory file and never observe an in-progress write,
- writes built and sealed in a separate generation, then published only after an `etag` compare-and-set succeeds,
- conflicting writes discarded and rerun against a freshly hydrated generation instead of overwriting the winner,
- refcounting plus idle/LRU eviction so the set of open blobs stays bounded.

> Requires: an object store for the blob + a local durability/concurrency layer over it.
> greppa uses: Cloudflare R2 behind Checkpoint, with a SQLite + FTS5 + sqlite-vec
> store inside each scope file. (Memvid filled this role until July 2026 — see
> [why-own-memory.md](./why-own-memory.md).)
> Swap in: any object store (S3, GCS) + the same cache discipline.

Checkpoint itself is the reusable piece here, and deliberately so: its entire
contract is `read(key, fn(localPath))`. It hands a callback a file path and has
no idea what is in the file. Replacing the memory engine underneath it required
zero changes to it. Everything above it — schema, retrieval, ACL, folders — is
greppa's product, not a specification.

---

## 5. Layer 3 — Multi-tenant access

greppa has two auth paths on purpose, because it serves two different callers.

- **Anonymous, HMAC-signed sessions.** The SDK mints a session and passes it as a header. This is the low-friction path for embedding chat on a site: no login, scoped conversation, rate-limited (anonymous callers get a small message cap per conversation). Good enough because a session id is an opaque, server-minted, TTL'd token — it is not an existence oracle for anything.
- **Authenticated users and organizations.** For multi-tenant knowledge with real ownership and ACLs, a full auth layer issues user sessions; org membership gates access to org-scoped memory.

The request middleware accepts the session header, then *upgrades* the request to an authenticated user if a valid user session is also present, otherwise treats it as anonymous. One code path, two trust levels.

> Requires: a cheap anonymous session primitive + a real user/org auth system for tenancy.
> greppa uses: HMAC sessions for the SDK path; Better Auth (users, orgs, API keys) for tenancy.
> Swap in: signed cookies/JWTs + any auth provider.

---

## 6. The client surface

The protocol is only as good as how trivial it is to consume. The reference SDK keeps the hard parts server-shaped and hands the client an async iterator.

- **Transport: `fetch` + `ReadableStream`, not `EventSource`.** `EventSource` gives reconnect and `Last-Event-ID` for free, but it is `GET`-only — it cannot send the auth header or the prompt body a chat needs. So the SDK reads the response body as a `ReadableStream`, parses SSE frames itself, and re-implements exactly the two things `EventSource` would have given: it tracks the last `seq` and re-sends it as `last-event-id` on reconnect, with backoff. You rebuild resume by hand precisely because you needed a real request.
- **Consumption: async iterators.** `send()` returns a handle *synchronously* (it wraps the pending POST), so the caller can start `for await`-ing tokens immediately. Events fan out into typed streams (`tokens`, `cues`, `sources`) and a `done` promise.
- **Framework bindings.** A `useChat`-style hook turns the streams into state (messages, streaming content, cue) so a UI is a few lines.

---

## 7. Replicate it

You do not need greppa's exact stack. You need these capabilities and these invariants.

**Capabilities**

1. A durable executor that runs the generation off the request path with retries (QStash / Inngest / Temporal / your own worker).
2. A store with ordered, scored, TTL'd entries for the event log (any sorted-set KV).
3. A live pub/sub transport for the tail (any WebSocket/pub-sub).
4. An object store plus a small concurrency-safe cache for memory (optional, only if you want knowledge).

**Invariants that actually matter**

- **Monotonic `seq` is the cursor.** The log is the source of truth; resume is "replay after `seq`." Never let a client's cursor advance on a control frame — control frames carry no id.
- **Subscribe before you snapshot.** Otherwise you drop events produced between the read and the tail.
- **Terminal-before-meta ordering.** A client should learn a stream ended from a terminal event in the log, not from meta racing ahead of the last token.
- **Emit must be safe under retries.** Because the executor retries, a replayed run must not double-write. Guard on terminal status; key idempotency on the message id.
- **One time window.** Log TTL, meta TTL, and stall bound are the same number. Do not let them drift.

**Failure modes to test (and the one that will fool you)**

- Disconnect mid-stream, reconnect, assert the answer stitches with no duplicates and no gap.
- A producer that stalls — assert the stall bound fires within the window.
- A conflicting concurrent write to the memory blob — assert the `etag` guard catches it.
- **Mocks that lie.** greppa's resume passed every unit test and broke against real infrastructure: the Upstash client auto-deserializes JSON, so the log read returned objects, but the replay code called `JSON.parse` on them and threw — only in production, because the test mock returned raw strings. If your mock is more convenient than reality, it will hide exactly this class of bug. Exercise the real thing at least once.

---

## 8. Design principles

- **Durability over cleverness.** The whole design is one durable log and disciplined reads over it. There is no clever in-memory state to lose.
- **Snapshot, then tail.** Reads work against an isolated view; live delivery is a separate, additive step. This keeps long reads from blocking writes and keeps a reader from seeing a half-written state.
- **One window to reason about.** A single duration governs the log, the meta, and the stall bound.
- **Return work to the queue, return state to the store.** The executor makes the work happen; the store records what it produced. Keeping those separate is what makes resume possible.
- **Run it to trust it.** Tests prove the logic you imagined. Only running the system against real infrastructure proves the system.
