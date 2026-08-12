# Greppa Architecture

> A reliable AI chat protocol for building systems that remember.

## Overview

Greppa is not a chatbot. It is a protocol that turns fragile synchronous LLM calls into a durable, observable, resumable message bus. The core insight: LLM inference should be asynchronous, recoverable, and observable — like a workflow, not a function call.

This document describes the architecture as of the current codebase, the design principles that shaped it, and the technical decisions behind it. Note which layers claim to be reusable and which are deliberately greppa-shaped — see Design Principle 5.

---

## Table of Contents

1. [Design Principles](#design-principles)
2. [System Architecture](#system-architecture)
3. [Data Flow](#data-flow)
4. [Async Pipeline](#async-pipeline)
5. [Identity & Sessions](#identity--sessions)
6. [Knowledge & Retrieval](#knowledge--retrieval)
7. [The Memory Graph](#the-memory-graph)
8. [Placement](#placement)
9. [Realtime & Streaming](#realtime--streaming)
10. [Errors](#errors)
11. [Security Model](#security-model)
12. [Testing Strategy](#testing-strategy)
13. [Technology Decisions](#technology-decisions)
14. [Known Limitations](#known-limitations)
15. [Roadmap Implications](#roadmap-implications)

---

## Design Principles

### 1. Async Over Sync

Most chat APIs are synchronous: you POST a message and hold the connection open while the LLM thinks. If the connection drops, the context is lost. Greppa treats chat generation as an async workflow: enqueue the job, return immediately, stream results via SSE. The client can reconnect and resume at any time.

### 2. Resumable By Default

Every SSE stream carries `last-event-id`. Drop the connection, reconnect, and the server replays events from where you left off. This is not an optional feature — it is the fundamental transport model.

### 3. Scoped Everything

Conversations, rate limits, and context windows are bound to a session; knowledge
is bound to an identity and, inside that, to a workspace or folder. Isolation is
physical where it can be — one database file per scope — rather than a filter
every query has to remember. There is no global state that leaks between users.

### 4. Observable Progress

The client should never wonder "is it working?" Each step of the generation pipeline emits typed cues: `scanning_input`, `building_context`, `thinking`, `searching_knowledge`, `reading_sources`, `generating`, `done`. The UI can show meaningful progress.

### 5. Protocol Where It Is a Protocol

Three layers, and only two of them are reusable. Being precise about which is which is deliberate — the alternative is infrastructure that quietly accretes product features until it is neither.

| layer | what it is | reusable |
| --- | --- | --- |
| Transport — enqueue, durable log, resumable stream | A **protocol**: a client-server contract with a versioned event schema and a resume cursor. Specified in [PROTOCOL.md](./PROTOCOL.md); section 7 is a build-your-own checklist. | Yes |
| [Checkpoint](./memory-architecture.md) | **Infrastructure**: serve a file from object storage into a bounded local cache, with immutable reads and compare-and-set writes. Knows nothing about memory, embeddings, scopes, or greppa. | Yes |
| Scope store and memory services | **greppa's product**: schema, chunking, three-leg retrieval, the entity graph, per-document ACL, placement. Opinionated on purpose. | No |

The rule that keeps this honest: **no product vocabulary enters `utils/checkpoint/`.** It deals in keys and local paths. The day `scope`, `folder`, or `tenant` appears in it, the reusable middle layer is gone — and that property is why replacing the memory engine cost zero changes there.

---

## System Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                         CLIENT                              │
│  ┌──────────────┐  ┌──────────────┐  ┌─────────────────┐  │
│  │   Browser    │  │    React     │  │   Server SDK    │  │
│  │   (Fetch +   │  │  (useChat)   │  │    (API key)    │  │
│  │  ReadableStream│ │              │  │                 │  │
│  └──────┬───────┘  └──────┬───────┘  └────────┬────────┘  │
└─────────┼──────────────────┼───────────────────┼───────────┘
          │                  │                   │
          │  POST /chat      │                   │
          │  GET /chat/stream│                   │
          │  (SSE + last-event-id)               │
          ▼                  ▼                   ▼
┌─────────────────────────────────────────────────────────────┐
│                        SERVER (Bun + Hono)                  │
│                                                             │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐ │
│  │  Middleware │  │   Routes    │  │      lib/           │ │
│  │             │  │             │  │                     │ │
│  │ • CORS      │  │ • chat.ts   │  │ • auth.ts           │ │
│  │   (_index)  │  │ • chat/     │  │ • chat/tools.ts     │ │
│  │ • session   │  │ • knowledge/│  │ • config.ts         │ │
│  │   -auth     │  │ • orgs/     │  │ • db.ts · emit.ts   │ │
│  │ • user-auth │  │ • me/       │  │ • errors.ts         │ │
│  │ • rate-limit│  │ • auth/     │  │ • memory/           │ │
│  └──────┬──────┘  │ • workflows/│  │ • realtime.ts       │ │
│         │         └──────┬──────┘  │ • redis.ts          │ │
│         │                │          │ • security.ts       │ │
│         └────────────────┘          │ • workflow.ts       │ │
│                                     └─────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
          │
          │  QStash Workflow (async)
          ▼
┌─────────────────────────────────────────────────────────────┐
│                     EXTERNAL SERVICES                       │
│                                                             │
│  ┌────────────┐  ┌─────────────┐  ┌──────────────────────┐ │
│  │   Groq     │  │ Cloudflare  │  │      Upstash         │ │
│  │  (LLM)     │  │     R2      │  │  • Redis (sessions,  │ │
│  │            │  │             │  │    history, limits)  │ │
│  │  tool_use  │  │ scope .sqlite│ │  • Realtime (SSE)    │ │
│  │  streaming │  │ + assets    │  │  • QStash (queues)   │ │
│  └────────────┘  └─────────────┘  └──────────────────────┘ │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ Postgres (Drizzle) — users, orgs, memberships,       │  │
│  │ document rows, job progress. Identity and catalog    │  │
│  │ live here; passage content lives in the scope store. │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                             │
│  Retrieval itself is in-process: SQLite + sqlite-vec + FTS5 │
│  runs inside the Bun process against a hydrated local file. │
└─────────────────────────────────────────────────────────────┘
```

---

## Data Flow

### A Complete Chat Turn

```
Client                                      Server
  │                                           │
  │  POST /api/v1/chat                        │
  │  Headers: x-greppa-session,               │
  │           cookie or x-api-key (optional)  │
  │  Body: { content: "What is Rust?" }       │
  │──────────────────────────────────────────>│
  │                                           │
  │                                           │ 1. session-auth middleware
  │                                           │    → bind conversation id,
  │                                           │      resolve identity if present
  │                                           │
  │                                           │ 2. rate-limit middleware
  │                                           │    → Redis INCR + PEXPIRE
  │                                           │
  │                                           │ 3. Write user message
  │                                           │    → Redis ZADD history:{sid}
  │                                           │
  │                                           │ 4. Write message metadata
  │                                           │    → Redis HSET msg:{mid}:meta
  │                                           │
  │                                           │ 5. Trigger QStash workflow
  │                                           │    → POST workflows/chat
  │                                           │    → with session + message payload
  │                                           │
  │         202 Accepted                      │
  │         { messageId }                     │
  │<──────────────────────────────────────────│
  │                                           │
  │  GET /api/v1/chat/stream?messageId=xxx    │
  │  Headers: last-event-id (optional)        │
  │──────────────────────────────────────────>│
  │                                           │
  │         [SSE] msg.cue: "scanning_input"   │
  │         [SSE] msg.cue: "thinking"         │
  │         [SSE] msg.token: { token: "R" }   │
  │         [SSE] msg.token: { token: "u" }   │
  │         [SSE] msg.sources: [...]          │
  │         [SSE] msg.done: { ... }           │
  │<──────────────────────────────────────────│
  │                                           │
  │  [Connection drops]                       │
  │                                           │
  │  GET /api/v1/chat/stream?messageId=xxx    │
  │  Headers: last-event-id: <last_seen>      │
  │──────────────────────────────────────────>│
  │                                           │
  │         [SSE] Replay from last-event-id   │
  │         [SSE] ...remaining tokens...      │
  │         [SSE] msg.done                    │
  │<──────────────────────────────────────────│
```

---

## Async Pipeline

The chat generation is handled by a QStash Workflow, not inline. This provides automatic retries, idempotency, and resilience against timeouts.

### Workflow Steps

| Step | Cue Emitted | Description |
|------|-------------|-------------|
| build context | `building_context` | Assembles the system prompt: the catalog of document titles from Postgres, the user's stored facts, and the active workspace or folder note |
| agent loop | `thinking` · `searching_knowledge` · `reading_sources` | One `streamText` call bounded by `stopWhen: stepCountIs(5)`. The model calls tools and continues until it answers or exhausts its steps |
| stream | `generating` | Tokens are emitted as they arrive; sources are emitted when a search resolves |

There is no separate probe call. An earlier design ran one completion to decide
whether retrieval was needed and a second to answer; the tool loop subsumes both,
and the model can now search more than once, or search after reading what the
first search returned.

### Tools

The tool set is built per request by `lib/chat/tools.ts` and depends on identity
and placement — an unauthenticated caller gets none, and `search_workspace`
appears only inside a folder.

| Tool | Returns | Used when |
|------|---------|-----------|
| `search_knowledge` | Document passages, plus the relationships that justified them | The answer may depend on something stored |
| `list_edges` | Relationships only, never document text | The relationships *are* the answer, or to discover entities before searching |
| `remember` | Confirmation, naming the entities the fact is now reachable from | The user states something durable |
| `search_workspace` | Passages from the wider workspace | Inside a folder, when the answer lives outside it |

Every tool returns a string the model can act on, including on failure. An empty
result says whether to retry and with what — an unresolved entity name comes back
with the stored spellings closest to it, and a query nothing resembles says so,
which is what stops a reword-and-search-again loop.

### Why This Matters

- **Timeout Immunity**: Groq calls can take 10-30s. An inline HTTP handler would risk gateway timeouts. The workflow runs in its own execution context.
- **Retry Safety**: If a step fails (e.g., Groq rate limit), QStash retries with backoff. The workflow checkpoints after each step.
- **Progress Visibility**: The client can show "Searching knowledge base..." because the workflow emits cues between steps.
- **Cost Transparency**: Each step is a distinct unit of work. Future analytics can track per-step latency.

### Event Emitter

The `lib/emit.ts` module creates a typed emitter for each message:

```typescript
const emit = makeEmitter({ messageId: "01HXXX...", ttlMs });

await emit("cue", { status: "searching_knowledge" });
await emit("token", { token: "R" });
await emit("sources", [{ title: "The Rust Book", score: 0.92 }]);
await emit("done", { message, sources });
```

Each event is a `StoredEvent` with:
- `seq`: a counter starting at 1, incremented per event, scoped to one message
- `id`: `String(seq)` — the same number, as the SSE event id
- `type`: `cue` | `token` | `sources` | `done` | `error`
- `data`: Payload

**Event ids are sequence numbers, not ULIDs.** ULIDs identify sessions and
messages, where the value is a globally unique name. A resume cursor needs
neither uniqueness nor global ordering — it needs to be comparable against a
per-message counter, and `ev.seq > cursor` is that comparison. The stream route
enforces the shape: `last-event-id` must match `/^\d+$/` or the cursor is
discarded and the log replays from the start.

Every event is written to a Redis sorted set (`msg:{messageId}:events`, scored by
`seq`, TTL'd) *and* published to an Upstash Realtime channel. The ZSET is the
durable log; the channel is the live tap.

---

## Identity & Sessions

These are two different things, and conflating them was the old design's mistake.
A **session** identifies a conversation. **Identity** identifies a person. A
conversation can exist without a person attached to it.

### Sessions are conversations

```
POST /api/v1/session
→ Generates ULID
→ Stores metadata in Redis with TTL
→ Returns { sessionId, ttlMs }
```

The id travels in `x-greppa-session` and keys the message history, the rate-limit
bucket, and the resumable event stream. It is not signed and carries no
authority: knowing a session id lets you continue that conversation, nothing
more. `DELETE /api/v1/session` removes the key and its history ZSET.

> An earlier version signed session ids with HMAC-SHA256 and required an
> `x-greppa-session-sig` header. That is gone. `lib/hmac.ts` survives with no
> callers outside its own test.

### Identity is Better Auth

Users, accounts, and API keys live in Postgres behind
[better-auth](https://better-auth.com), mounted wholesale at
`routes/auth/[...path].ts`. Two middleware read it:

| Middleware | Behaviour | Applied to |
|---|---|---|
| `session-auth` | Requires `x-greppa-session`. Resolves identity if the request carries it, and sets `isAnonymous` when it does not. Never rejects for being anonymous. | Chat surface |
| `user-auth` | Requires a resolved user. 401 otherwise. | `/me`, org routes, knowledge management |

`session-auth` also warms a Redis cache of the user's org memberships (`user:{id}:orgs`, 1h)
so ACL resolution does not hit Postgres on every turn.

### What anonymity costs

An anonymous conversation streams, resumes, and rate-limits normally. It gets no
tools — no search, no memory, no graph — because every one of them resolves a
personal scope from a user id. The catalog note degrades to
`"Knowledge base access requires authentication."` and the model answers from the
conversation alone.

### Org context

`x-greppa-org-id` selects the tenant for a request. Membership is verified
against Postgres before the org's object key is derived, so an org id in a header
cannot reach a scope the caller is not a member of.

---

## Knowledge & Retrieval

### Storage: the scope store

Greppa no longer uses Memvid. Memory is a store we wrote: **SQLite + `sqlite-vec` + FTS5**, one database file per scope, kept in Cloudflare R2 and checked out to local disk on demand by the Checkpoint layer.

```
scopes/{scopeId}/memory.sqlite     personal scope   (compare-and-set published)
scopes/{scopeId}/assets/{sha256}   image blobs      (immutable, write-once)
orgs/{orgId}/memory.sqlite         org scope        (+ per-document ACL)
```

Retrieval is hybrid over three legs — a `vec0` vector index, an FTS5 BM25 index, and a walk of the entity graph, all over the same rows and merged by reciprocal rank fusion. Embeddings come from a pluggable provider whose identity is pinned in the file, so a model change is a loud error rather than silently wrong distances.

> **Full detail:** [memory-architecture.md](./memory-architecture.md) — layering, read/write paths, conflict resolution, cache budgets, ACL enforcement, failure modes.
> **Why it exists:** [why-own-memory.md](./why-own-memory.md) · **Limitations:** [MEMORY.md](./MEMORY.md)

**Important**: the scope store still requires a persistent filesystem for the Checkpoint cache. This makes Greppa incompatible with serverless platforms (Vercel, Netlify, Cloudflare Workers) unless `CHECKPOINT_CACHE_DIR` is mounted on durable storage. The R2 adapter exists; the local cache is what needs the disk.

### Ingestion

| Route | Purpose |
|---|---|
| `POST /knowledge` | Plain text articles |
| `PUT /knowledge` | Multipart file uploads (PDF, DOCX, XLSX, PPTX) |
| `POST /knowledge/presign` | Hand back an R2 upload URL for large files |
| `POST /knowledge/ingest` | Commit a presigned upload into memory |
| `POST /knowledge/move` | Re-place up to 200 documents in one call |
| `GET · PATCH · DELETE /knowledge/:documentId` | Read, amend, remove a document |

Text is chunked (~1000 chars, 150 overlap), embedded, and written with its vector
and BM25 row — and any relationships the write declared — in a single transaction.

### Retrieval Flow

1. **Catalog note** — a system message listing document titles from Postgres, so the model knows what exists before deciding to search.
2. **Tool call** — the model calls `search_knowledge` with a query. There is no separate probe step; the decision and the search are the same call.
3. **Three-leg retrieval** — `retrieveScopedContext()` embeds the query, then runs vector search, BM25, and an entity-graph walk over the eligible scope, fusing all three ranked lists by RRF.
4. **Filtering after fusion** — the fused chunk ids pass through one `select` carrying the ACL predicate and the placement clauses. Because filtering happens after fusion rather than per leg, a graph-reached chunk is subject to exactly the same visibility rules as a vector hit; there is no side door.
5. **Injection scan** — retrieved snippets are scanned for prompt injection patterns before entering the prompt.
6. **Relationship block** — the edges backing the winning documents are appended as `## Relationships backed by these memories`, so the model sees *why* a passage was retrieved.
7. **Streaming generation** — conversation plus sources go to Groq for streaming completion.

### Security Layer

Two-layer prompt injection defense:
1. **Input Layer**: `isInjectionAttempt()` blocks known jailbreak patterns before processing
2. **Retrieval Layer**: `scanRetrievedSnippet()` redacts injection patterns found in knowledge base sources

---

## The Memory Graph

Two tables sit beside the chunks in every scope file:

```sql
memory_nodes(id, label, created_at)
memory_edges(id, source_node_id, target_node_id, relation,
             weight, document_id, created_at,
             unique(source_node_id, target_node_id, relation, document_id))
```

Nodes are entities, keyed by `node:${sha256(normalizeEntity(label))}` — so
`Helios`, `helios`, and `  HELIOS  ` are one node. Edges are typed relations
supplied by the model through the `remember` tool, and each carries the
`document_id` that asserted it. The graph is semantic, not structural: it records
*that Marcy owns the Helios cutover*, not *that this document contains this section*.

### The graph decides what gets retrieved

This is the part worth being precise about, because it changed. The graph used to
run *after* retrieval — hybrid search picked the winners, then their edges were
formatted into the prompt as context. It enriched answers but never influenced
which documents were found.

Now it is a retrieval leg of its own, inside `hybridSearch`:

```
question ──┬─→ vector search ──┐
           ├─→ BM25 ───────────┼─→ RRF ─→ ACL + placement filter ─→ passages
           └─→ graph walk ─────┘
```

1. **Seed** — the query is sliced into 1–3 word n-grams, stopwords dropped, each run through the *same* `normalizeEntity` + `stableId` used at write time and looked up against `memory_nodes` by primary key. No embeddings, no fuzzy matching: a seed resolves exactly when the writer would have created it.
2. **Walk** — breadth-first over `memory_edges` for two hops, deduplicated by edge id so a hub entity is not counted twice on the return hop. Each edge credits its document with `weight / hop`.
3. **Rank** — documents by accumulated score, expanded to their chunks in ordinal order, capped at the same candidate depth as the other legs.
4. **Fuse** — as a third list, weighted 2 against 1 for vector and BM25.

The weight is not a tuning knob left at a lucky value. Unweighted RRF
structurally pins any single-list result below everything appearing in two lists,
so a graph-only document could never outrank lexical noise that happened to match
twice. Weight 2 states the claim plainly: an explicitly asserted relation to an
entity named in the question is worth about as much as matching both semantically
and lexically.

### Why it lives in the store

`hybridSearch` is the single chokepoint every retrieval path already passes
through. Putting the walk there means personal search, org search, workspace
search, and the chat tools all gained graph retrieval without opting in, and a
future caller cannot forget it. When no entity resolves it costs one indexed
lookup that returns nothing.

### What it buys

A question naming a known entity reaches documents that share no wording and no
semantic similarity with it, provided something asserted a relation. The boundary
is the exact-normalized seed match: if a memory recorded `Project Helios` and the
question says only "helios", the unigram will not resolve — which is why the
system prompt and the tool descriptions both instruct the model to name entities
whole and unparaphrased, and why a failed lookup answers with the stored
spellings closest to what was asked.

---

## Placement

Documents carry two nullable columns — `workspace_id` and `folder_id` — in both
Postgres and every scope file. Every read and write that can be scoped takes a
`MemoryScope`, and its three-way semantics are the whole design:

| value | meaning |
|---|---|
| `undefined` | no constraint — match anything |
| `null` | explicitly unplaced — match only documents with no placement |
| a string | that placement exactly |

The distinction between "don't care" and "explicitly nowhere" is what lets one
type serve both filtering and moving. `moveToPlacement` writes only the columns
that are not `undefined`, so a move can set a workspace without disturbing a
folder, and can unplace by passing `null`.

The wire convention is defined once, in `lib/memory/placement.ts`, and shared by
the query parsers and the body schemas — an absent parameter is `undefined`, an
empty one is `null`. `POST /knowledge/move` rejects a request carrying neither
placement, because a move with nothing to set would silently succeed while
changing nothing.

---

## Realtime & Streaming

### Why Not Native EventSource?

The browser's native `EventSource` API does not support custom headers. Greppa requires:
- `x-greppa-session` — Conversation binding
- `x-greppa-org-id` — Tenant selection
- `last-event-id` — Resumability

Authentication rides a cookie or `x-api-key`, which `EventSource` also cannot set
on a cross-origin request.

### The Solution

The SDK uses `fetch()` + `ReadableStream` with manual SSE block parsing:

```typescript
const response = await fetch(`${baseUrl}/chat/stream`, {
  headers: {
    "x-greppa-session": sessionId,
    "last-event-id": lastEventId || "",
  },
});

const reader = response.body!.getReader();
// Parse SSE blocks manually
```

### Resumability

Replay comes from the Redis log, not from the Realtime retention window — the
subscription is opened with `history: false` precisely so the two cannot both
deliver the same event. The order of operations is what closes the gap:

1. **Subscribe first**, buffering anything that arrives, before reading anything
2. **Read the durable log** — `zrange` over `msg:{messageId}:events`
3. **Forward** every logged event with `seq > cursor`
4. **Drain the buffer** — events that landed while step 2 was in flight
5. **Go live**, forwarding straight through

Subscribing before snapshotting is the whole trick. Reversed, an event emitted
between the `zrange` and the subscribe would be in neither the log the client got
nor the live feed, and would vanish silently. A `lastSeq` guard makes the overlap
harmless: an event delivered by both paths is forwarded once.

If the client sends a cursor beyond the end of the log, it is treated as
unusable and the log replays from the start rather than skipping to a position
that does not exist.

This survives:
- Browser refreshes
- Network hiccups
- Laptop closures
- Tab switches

---

## Errors

Every failure a client can see is declared in one place. `lib/errors.ts` builds
[evlog](https://www.npmjs.com/package/evlog) catalogs — `authErrors`,
`requestErrors` and friends — where each entry fixes a status, a message, and
optionally a `why`, a `fix`, and a `link`. Routes throw `requestErrors.TOO_LARGE({ size, limit })`
rather than composing a response, and `jsonError()` renders whatever reaches the
handler.

The catalog is a closed set on purpose: a status code cannot be invented at a call
site, and a message cannot drift between two routes that mean the same thing.
Where a structured error needs machine-readable fields the catalog cannot express,
`withDetail()` attaches them under a symbol key that `jsonError` merges at the
edge — the payload widens without the catalog's shape being negotiable per route.

---

## Security Model

### Authentication Layers

| Layer | Mechanism | Use Case |
|-------|-----------|----------|
| Session | Unsigned ULID in `x-greppa-session` | Conversation continuity, history, resume |
| User | Better Auth cookie or API key | Memory, knowledge, org routes |
| Org | `x-greppa-org-id` + membership check in Postgres | Tenant selection |
| Document | `acl_read_roles` · `acl_read_groups` · `acl_read_principals` | Per-document visibility, enforced as a SQL predicate |
| Rate Limit | Redis sliding window | Abuse prevention |

### Rate Limiting

Two tiers:
- **IP-level**: `incr` + `pexpire` on Redis key `rate:ip:{ip}` — always applied
- **Session-level**: `incr` + `pexpire` on Redis key `rate:session:{sid}` — applied once a session id is bound

Both tiers apply to every caller; there is no exempt key.

### Prompt Injection Defense

`lib/security.ts` provides:
- `isInjectionAttempt(query)`: Regex-based detection of jailbreak patterns
- `scanRetrievedSnippet(snippet)`: Redacts injection attempts in retrieved knowledge

Patterns detected include:
- "ignore previous instructions"
- "system prompt"
- "DAN mode"
- Roleplay injection attempts

---

## Testing Strategy

### Test Runner

Bun's built-in test runner (`bun:test`).

### Mocking Strategy

`tests/server/_mocks.ts` uses `mock.module()` at the process level to replace:
- `lib/redis` → In-memory Redis
- `lib/realtime` → In-memory Realtime
- `lib/workflow` → In-memory Workflow

This avoids network calls and prevents test races.

### Test Types

| Test File | Type | Scope |
|-----------|------|-------|
| `hmac.test.ts` | Unit | HMAC signing/verification — covers `lib/hmac.ts`, which has no other callers |
| `placement.test.ts` | Unit | Placement wire convention (absent vs empty vs value) |
| `store.test.ts` | Unit | Scope store: retrieval, ACL, placement, graph walk, entity resolution |
| `placement-e2e.test.ts` | E2E | Placement across routes, services, and the store |
| `security.test.ts` | Unit | Injection detection |
| `config.test.ts` | Unit | Config loading |
| `emit.test.ts` | Unit | Event emission |
| `session-auth.test.ts` | Middleware | Hono middleware with fresh app |
| `chat-flow.test.ts` | Integration | Full route with mocked deps |
| `interop.test.ts` | E2E | SDK client ↔ mocked server |

### State Reset

`beforeEach` clears:
- Redis mock state
- Realtime mock state
- Config cache

---

## Technology Decisions

### Why Bun?

- Native TypeScript support (no build step for dev)
- Built-in test runner
- Fast startup (critical for workflow handlers)
- Excellent fetch() implementation

### Why Hono?

- Lightweight (~14KB)
- Web Standard APIs (Request/Response)
- Excellent middleware composition
- File-based routing via Sumi

### Why Sumi?

Sumi (`@bethel-nz/sumi`) is a file-based router for Hono, similar to Next.js App Router:
- Routes map to files in `routes/`
- Middleware auto-registers by filename
- `sumi.d.ts` auto-generates type-safe middleware names

### Why Upstash?

**Redis**: Serverless-compatible Redis (REST API, no connection pooling needed).

**Realtime**: Serverless-compatible pub/sub with message retention and replay.

**QStash**: Serverless-compatible queue with workflow primitives (retries, delays, scheduling).

All three share the same Upstash account and region, minimizing latency.

### Why SQLite + sqlite-vec + FTS5?

- **One file per scope** — isolation is physical, not a filter every query must remember
- **In-process** — no server to run so a user's assistant can recall a fact
- **`bun:sqlite` ships inside Bun** — the driver is not an N-API addon
- **Hybrid retrieval in one transaction** — vectors and BM25 over the same rows, so they cannot drift
- **Exact vector search** — 100% recall, where HNSW engines are approximate
- **Openable by anyone** — a user's memory is a file any SQLite tool can read

Tradeoffs: every write republishes the whole scope file, vector search is brute
force, and a persistent filesystem is still required for the Checkpoint cache.
See [MEMORY.md](./MEMORY.md) for the full list; [why-own-memory.md](./why-own-memory.md)
for why this replaced Memvid.

### Why Groq?

- Fast inference (LLaMA 3, Mixtral)
- Tool-use support
- Streaming completions
- Competitive pricing

---

## Known Limitations

### Write Amplification

Checkpoint publishes whole objects under a compare-and-set, so appending a 2 KB
note to a 16 MiB scope uploads 16 MiB. Local insertion takes ~0.5 ms; the upload
takes seconds. Write coalescing — batching appends per scope behind a short
debounce inside one `Checkpoint.write` — is the highest-value outstanding
optimisation and is not yet built.

### Brute-Force Vector Search

`sqlite-vec` scans every vector. That is a recall *advantage* (exact, not
approximate) but cost grows linearly: ~3.4 ms at 350 vectors, ~100 ms at 10k,
~1 s at 100k **within a single scope**. Personal-scale memory sits comfortably
inside this; a single scope with 100k+ chunks does not.

### Persistent Filesystem Requirement

The Checkpoint cache requires disk. This rules out:
- Vercel
- Netlify
- Cloudflare Workers
- AWS Lambda (without EFS)

Deployment requires: Railway, Render, Fly.io, DigitalOcean, or any VPS.

### Graph Recall Depends on Naming

A graph seed resolves by exact normalized match, which is what makes retrieval
deterministic and makes a hit provable — and also means a question phrased around
an entity the memory spells differently reaches nothing through the graph. The
system prompt and tool descriptions push the model toward whole, unparaphrased
names, and a missed lookup answers with the closest stored spellings, but nothing
resolves `Project Helios` from the single word "helios" today. Aliasing — one node
carrying several labels — is the fix, and is not built.

### Org Retrieval Is Not Graph-Aware

The graph lives in the scope file. Org search runs against Postgres and fuses its
hits with the personal scope's afterwards, so an org-only document is reachable by
vector and keyword but never by a walk. This is a consequence of where the graph
is stored, not an oversight in the retrieval path.

### Anonymous Conversations Have No Memory

By design, but worth stating plainly: without an identity there is no personal
scope to resolve, so an anonymous session gets no tools at all. The transport,
resume, and rate-limit guarantees hold; the assistant simply has nothing to
remember with.

### Limited Analytics

No built-in metrics, tracing, or usage analytics. The protocol emits events but does not aggregate them.

---

## Roadmap Implications

### v1 (Current): Personal Knowledge API

The architecture supports one user, one knowledge base, infinite sessions. All the protocol primitives are production-ready.

### v1.5 (Next): Power User

Per-scope isolation is **done** — every user and org already gets its own
database file, so the original plan here (namespacing inside a shared index) is
obsolete. What remains:
- Export/import knowledge bundles (a scope is one file plus its assets, so this is now mostly packaging)
- ~~Multiple named scopes per user~~ — **done**, as placement. Workspaces and folders partition one scope file rather than multiplying files, so a move is an UPDATE and not a migration.
- Entity aliasing, so one node can answer to several spellings

These changes are additive — the existing session and streaming model doesn't change.

### v2 (Future): Multi-Tenant Protocol

To support teams and organizations:
- ~~**Storage Adapter**~~ — **done.** One scope store per tenant, served through Checkpoint.
- ~~**Organization Scoping**~~ — **done.** `orgs/{orgId}/memory.sqlite`, with membership resolved before the object key is derived.
- **Permissions** — partially done. Documents carry `acl_read_roles`, `acl_read_groups` and `acl_read_principals`, enforced as a SQL predicate during retrieval. Not yet surfaced as an admin-facing API.
- **Protocol Versioning**: The `GREPPA_PROTOCOL_VERSION` header exists but is not enforced. Formalize the contract.
- **Hosted Offering**: `greppa.cloud` — we host the protocol, customers bring knowledge

### What Doesn't Need to Change

The following architectural decisions are future-proof:
- Session model (conversation-scoped, TTL-based, identity resolved separately)
- Async pipeline (enqueue → queue → stream)
- Resumable SSE (`last-event-id`)
- Rate limiting (IP + session tiers)
- SDK design (Fetch + ReadableStream)
- Event schema (`cue`, `token`, `sources`, `done`)

### What Needs to Change

- ~~**Storage layer**~~: done — per-scope SQLite store behind Checkpoint
- ~~**Auth layer**~~: done — Better Auth over Postgres, with API keys, sessions decoupled from identity
- ~~**Knowledge scoping**~~: done — per-scope files, plus workspace/folder placement within a scope
- **Analytics**: None → event aggregation and metrics

---

## Glossary

| Term | Definition |
|------|------------|
| **Cue** | A progress event indicating which step of the pipeline is active |
| **StoredEvent** | A typed event with a per-message sequence number, type, and payload |
| **Message ID** | ULID identifying a single chat turn |
| **Cursor** | `last-event-id` — a sequence number, not a ULID |
| **Session ID** | ULID identifying a conversation, not a person |
| **Scope** | One memory database file — a user's personal store or an org's |
| **Placement** | A document's `workspaceId` / `folderId` pair, where `undefined`, `null`, and a value mean three different things |
| **Node** | An entity in the memory graph, keyed by the hash of its normalized label |
| **Edge** | A typed relation between two entities, carrying the document that asserted it |
| **Seed** | An entity node a question resolved to, from which the graph walk starts |
| **Catalog Note** | System message listing available knowledge articles |

---

## References

- [Sumi Framework](https://github.com/bethel-nz/sumi)
- [sqlite-vec](https://github.com/asg017/sqlite-vec)
- [SQLite FTS5](https://www.sqlite.org/fts5.html)
- [Hono](https://hono.dev)
- [Upstash](https://upstash.com)
- [Groq](https://groq.com)
