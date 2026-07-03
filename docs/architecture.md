# Greppa Architecture

> A reliable AI chat protocol for building systems that remember.

## Overview

Greppa is not a chatbot. It is a protocol that turns fragile synchronous LLM calls into a durable, observable, resumable message bus. The core insight: LLM inference should be asynchronous, recoverable, and observable — like a workflow, not a function call.

This document describes the architecture as of the current codebase, the design principles that shaped it, and the technical decisions that enable its roadmap from single-tenant personal API to multi-tenant protocol.

---

## Table of Contents

1. [Design Principles](#design-principles)
2. [System Architecture](#system-architecture)
3. [Data Flow](#data-flow)
4. [Async Pipeline](#async-pipeline)
5. [Session Management](#session-management)
6. [Knowledge & RAG](#knowledge--rag)
7. [Realtime & Streaming](#realtime--streaming)
8. [Security Model](#security-model)
9. [Testing Strategy](#testing-strategy)
10. [Technology Decisions](#technology-decisions)
11. [Known Limitations](#known-limitations)
12. [Roadmap Implications](#roadmap-implications)

---

## Design Principles

### 1. Async Over Sync

Most chat APIs are synchronous: you POST a message and hold the connection open while the LLM thinks. If the connection drops, the context is lost. Greppa treats chat generation as an async workflow: enqueue the job, return immediately, stream results via SSE. The client can reconnect and resume at any time.

### 2. Resumable By Default

Every SSE stream carries `last-event-id`. Drop the connection, reconnect, and the server replays events from where you left off. This is not an optional feature — it is the fundamental transport model.

### 3. Session-Scoped Everything

Conversations, rate limits, context windows, and knowledge scopes are all bound to cryptographically signed sessions. There is no global state that leaks between users.

### 4. Observable Progress

The client should never wonder "is it working?" Each step of the generation pipeline emits typed cues: `scanning_input`, `building_context`, `thinking`, `searching_knowledge`, `generating`, `done`. The UI can show meaningful progress.

### 5. Protocol-First, Product-Second

The API contract, SDK, and session model are designed as a reusable protocol. The current implementation is a single-tenant personal API, but the primitives (session isolation, scoped contexts, rate limits, protocol versioning) are production-ready for multi-tenancy.

---

## System Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                         CLIENT                              │
│  ┌──────────────┐  ┌──────────────┐  ┌─────────────────┐  │
│  │   Browser    │  │    React     │  │   Server SDK    │  │
│  │   (Fetch +   │  │  (useChat)   │  │  (deployerKey)  │  │
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
│  │ • CORS      │  │ • chat.ts   │  │ • config.ts         │ │
│  │ • session-auth│ │ • chat/stream│ │• emit.ts           │ │
│  │ • rate-limit│  │ • knowledge │  │ • memory.ts         │ │
│  │ • deployer  │  │ • workflows/│  │ • realtime.ts       │ │
│  │   -auth     │  │   chat.ts   │  │ • redis.ts          │ │
│  └──────┬──────┘  └──────┬──────┘  │ • hmac.ts           │ │
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
│  │   Groq     │  │   memvid    │  │      Upstash         │ │
│  │  (LLM)     │  │  (.mv2 RAG) │  │  • Redis (sessions)  │ │
│  │            │  │             │  │  • Realtime (SSE)    │ │
│  │  tool_use  │  │  • ask()    │  │  • QStash (queues)   │ │
│  │  streaming │  │  • find()   │  │                      │ │
│  └────────────┘  └─────────────┘  └──────────────────────┘ │
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
  │           x-greppa-session-sig            │
  │  Body: { content: "What is Rust?" }       │
  │──────────────────────────────────────────>│
  │                                           │
  │                                           │ 1. session-auth middleware
  │                                           │    → verify HMAC signature
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
| `build-catalog` | `building_context` | Fetches article titles from memvid to build a knowledge catalog |
| `probe` | `thinking` | First Groq call with tool choice. The LLM decides if RAG is needed |
| `search` | `searching_knowledge` | If tool was called, runs `mem.ask()` or `mem.find()` |
| `generate` | `generating` | Final streaming completion with full context |

### Why This Matters

- **Timeout Immunity**: Groq calls can take 10-30s. An inline HTTP handler would risk gateway timeouts. The workflow runs in its own execution context.
- **Retry Safety**: If a step fails (e.g., Groq rate limit), QStash retries with backoff. The workflow checkpoints after each step.
- **Progress Visibility**: The client can show "Searching knowledge base..." because the workflow emits cues between steps.
- **Cost Transparency**: Each step is a distinct unit of work. Future analytics can track per-step latency.

### Event Emitter

The `lib/emit.ts` module creates a typed emitter for each message:

```typescript
const emitter = makeEmitter({ messageId: "msg_01H..." });

await emitter.cue("searching_knowledge");
await emitter.token({ token: "R" });
await emitter.sources([{ title: "The Rust Book", score: 0.92 }]);
await emitter.done({ message, sources });
```

Each event is a `StoredEvent` with:
- `id`: ULID (sortable, lexicographically ordered)
- `seq`: Monotonic sequence number for ordering
- `type`: `cue` | `token` | `sources` | `done` | `error`
- `data`: Payload

Events are published to an Upstash Realtime channel (`msg:{messageId}`) with 1-hour retention.

---

## Session Management

### Minting

```
POST /api/v1/session
→ Generates ULID
→ Signs with HMAC-SHA256(sessionSecret, sessionId)
→ Stores metadata in Redis with TTL
→ Returns { sessionId, signature }
```

### Validation

Every protected route checks:
1. `x-greppa-session` header exists
2. `x-greppa-session-sig` header exists
3. HMAC(sessionSecret, sessionId) === signature (via `timingSafeEqual`)
4. Session exists in Redis (not revoked)

### Scoping

The SDK supports scoped sessions:
```typescript
const chat = greppa.chat.scope("article:rust-ownership");
```

Each scope gets its own session in storage. This allows multiple parallel conversation contexts for the same user.

### Deployer Mode

Server-side operations use a `deployerKey` that bypasses session checks entirely. This is for ingestion, stats, and admin operations.

### Revocation

```
DELETE /api/v1/session
→ Deletes session key from Redis
→ Deletes associated history ZSET
→ Session becomes invalid immediately
```

---

## Knowledge & RAG

### Storage: memvid

Greppa uses `@memvid/sdk` — a local file-based vector store (`chatbot-memory.mv2`). It supports both lexical and semantic search.

**Important**: memvid requires a persistent filesystem. This makes Greppa incompatible with serverless platforms (Vercel, Netlify, Cloudflare Workers) unless a remote storage adapter (S3/R2) is added.

### Ingestion

- `POST /knowledge` — Plain text articles
- `PUT /knowledge` — Multipart file uploads (PDF, DOCX, XLSX, PPTX)
- memvid auto-extracts text, generates embeddings, and indexes

### Retrieval Flow

1. **Catalog Note**: A system message listing all article titles is prepended to the conversation. This guides the LLM's tool-use decision.
2. **Tool-Use Probe**: The LLM is given a `search_knowledge` function. The probe step lets it decide if RAG is needed.
3. **Semantic Search**: If tool is called, `mem.ask(query, { returnSources: true, k: 5 })` retrieves relevant context.
4. **Injection Scan**: Retrieved snippets are scanned for prompt injection patterns before being injected into the completion prompt.
5. **Streaming Generation**: The full context (conversation + sources) is sent to Groq for streaming completion.

### Security Layer

Two-layer prompt injection defense:
1. **Input Layer**: `isInjectionAttempt()` blocks known jailbreak patterns before processing
2. **Retrieval Layer**: `scanRetrievedSnippet()` redacts injection patterns found in knowledge base sources

---

## Realtime & Streaming

### Why Not Native EventSource?

The browser's native `EventSource` API does not support custom headers. Greppa requires:
- `x-greppa-session` — Session authentication
- `x-greppa-session-sig` — HMAC signature
- `last-event-id` — Resumability

### The Solution

The SDK uses `fetch()` + `ReadableStream` with manual SSE block parsing:

```typescript
const response = await fetch(`${baseUrl}/chat/stream`, {
  headers: {
    "x-greppa-session": sessionId,
    "x-greppa-session-sig": signature,
    "last-event-id": lastEventId || "",
  },
});

const reader = response.body!.getReader();
// Parse SSE blocks manually
```

### Resumability

When a client reconnects with `last-event-id`:
1. Server subscribes to the Realtime channel
2. Upstash Realtime replays historical events from the retention window
3. Server filters events, skipping those with `id <= last-event-id`
4. Client receives only missed events, then live events

This survives:
- Browser refreshes
- Network hiccups
- Laptop closures
- Tab switches

---

## Security Model

### Authentication Layers

| Layer | Mechanism | Use Case |
|-------|-----------|----------|
| Session | HMAC-SHA256 signed ULID | User chat, history |
| Deployer | Shared secret key | Admin ops, ingestion |
| Rate Limit | Redis sliding window | Abuse prevention |

### Rate Limiting

Two tiers:
- **IP-level**: `incr` + `pexpire` on Redis key `ratelimit:ip:{ip}`
- **Session-level**: `incr` + `pexpire` on Redis key `ratelimit:session:{sid}`

Deployer requests are exempt.

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
| `hmac.test.ts` | Unit | HMAC signing/verification |
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

### Why memvid?

- Local file-based (no network latency for search)
- Hybrid lexical + semantic search
- Auto-embedding with multiple providers
- Built-in document parsing (PDF, DOCX, etc.)

Tradeoff: Requires persistent filesystem, limiting deployment options.

### Why Groq?

- Fast inference (LLaMA 3, Mixtral)
- Tool-use support
- Streaming completions
- Competitive pricing

---

## Known Limitations

### Single-Tenant Storage

memvid uses a single `.mv2` file. There is no native user isolation. All sessions share the same knowledge base. Multi-tenancy requires either:
- Contributing isolation to memvid
- Adding a Postgres/pgvector adapter
- Using file-per-tenant with a storage backend (S3/R2)

### Persistent Filesystem Requirement

memvid requires disk. This rules out:
- Vercel
- Netlify
- Cloudflare Workers
- AWS Lambda (without EFS)

Deployment requires: Railway, Render, Fly.io, DigitalOcean, or any VPS.

### No Built-In Authentication

Session management is cryptographic (HMAC) but there is no user database, OAuth, or password system. The current model assumes:
- Sessions are minted by the client (first-visit)
- Sessions are scoped to a browser/device
- Deployer key is for admin ops only

A future auth layer would need to integrate with the session system.

### Limited Analytics

No built-in metrics, tracing, or usage analytics. The protocol emits events but does not aggregate them.

---

## Roadmap Implications

### v1 (Current): Personal Knowledge API

The architecture supports one user, one knowledge base, infinite sessions. All the protocol primitives are production-ready.

### v1.5 (Next): Power User

To support multiple knowledge bases per instance:
- Namespace isolation in memvid (or multiple `.mv2` files)
- Scoped knowledge ingestion (`/knowledge?namespace=work`)
- Export/import knowledge bundles

These changes are additive — the existing session and streaming model doesn't change.

### v2 (Future): Multi-Tenant Protocol

To support teams and organizations:
- **Storage Adapter**: Replace or augment memvid with a multi-tenant backend (Postgres + pgvector, or memvid with tenant isolation)
- **Organization Scoping**: Add `orgId` to sessions, rate limits, and knowledge bases
- **Permissions**: Role-based access to knowledge bases (read, write, admin)
- **Protocol Versioning**: The `GREPPA_PROTOCOL_VERSION` header exists but is not enforced. Formalize the contract.
- **Hosted Offering**: `greppa.cloud` — we host the protocol, customers bring knowledge

### What Doesn't Need to Change

The following architectural decisions are future-proof:
- Session model (HMAC-signed, scoped, TTL-based)
- Async pipeline (enqueue → queue → stream)
- Resumable SSE (`last-event-id`)
- Rate limiting (IP + session tiers)
- SDK design (Fetch + ReadableStream)
- Event schema (`cue`, `token`, `sources`, `done`)

### What Needs to Change

- **Storage layer**: memvid → multi-tenant adapter
- **Auth layer**: Session-only → optional OAuth/user system
- **Knowledge scoping**: Global → namespace/tenant-scoped
- **Analytics**: None → event aggregation and metrics

---

## Glossary

| Term | Definition |
|------|------------|
| **Cue** | A progress event indicating which step of the pipeline is active |
| **StoredEvent** | A typed event with ULID id, monotonic seq, and payload |
| **Message ID** | ULID identifying a single chat turn |
| **Session ID** | ULID identifying a user session |
| **Scope** | A namespace within a session (e.g., `article:slug`) |
| **Deployer Key** | A shared secret for admin operations |
| **Catalog Note** | System message listing available knowledge articles |
| **Probe** | The initial LLM call that decides if RAG is needed |

---

## References

- [Sumi Framework](https://github.com/bethel-nz/sumi)
- [memvid SDK](https://github.com/Bethel-nz/memvid)
- [Hono](https://hono.dev)
- [Upstash](https://upstash.com)
- [Groq](https://groq.com)
