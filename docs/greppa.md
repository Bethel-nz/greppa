# Greppa — Reliable AI Chat Protocol & Server

**Greppa** is an **async-first AI chat protocol and server** for building conversational systems that remember. Instead of traditional synchronous LLM calls, it treats inference as a durable, observable, resumable message bus.

## Workspace Overview

```
greppa/
├── sumi.config.ts          # Server config (port, basePath, CORS, OpenAPI, Scalar docs)
├── routes/                 # File-based API routes (chat, knowledge, session, orgs, auth, workflows)
├── middleware/             # CORS, session-auth, user-auth, chat-auth, rate-limit
├── lib/                    # Core: config, auth, db, redis, realtime, emit, hmac, security, groq, workflow
│   ├── memory/             # Memory layer: service, ACL, scoped service, queue, R2 sync, memvid, stats
│   ├── knowledge/          # Ingestion pipeline: parsers (text, HTML), routing, progress tracking
│   └── chat/               # LLM tool definitions (search_knowledge, remember)
├── db/schema/              # Drizzle ORM: auth (users, sessions, api keys) + tenant (orgs, docs, jobs, scopes)
├── packages/
│   └── greppa-sdk/         # @greppa/sdk — first-party client SDK (browser, React, server)
├── utils/checkpoint/       # Per-key cached file gateway with snapshot isolation, ETag concurrency, LRU eviction
├── tests/server/           # Server integration + unit tests
├── docs/                   # Architecture docs, design notes, critical thinking pieces
├── public/                 # Static files (currently only a favicon)
├── Dockerfile + docker-compose.yml
└── drizzle/                # Generated SQL migrations
```

**Runtime:** Bun only. **No frontend exists** — the `public/` directory contains only a favicon. The server exposes Scalar API docs at `/api/v1/docs`. There is no UI application, no Next.js, no Vite, nothing. Building the UI is greenfield.

---

## SDK Surface (`@greppa/sdk`)

This is the **entire contract** a UI developer has to work with.

### Entry Point (`src/index.ts`)

```typescript
class Greppa {
  readonly chat: ChatNamespace    // Chat + streaming
  readonly knowledge: KnowledgeNamespace  // CRUD + upload
  readonly stats: StatsNamespace  // Storage stats
}
```

### Types (`src/types.ts`)

| Type | What It Is |
|------|-----------|
| `Cue` | Union of 11 progress statuses: `idle`, `scanning_input`, `building_context`, `thinking`, `searching_knowledge`, `reading_sources`, `generating`, `done`, `error`, `rate_limited` |
| `Token` | `{ token: string }` — single streamed text chunk |
| `Source` | `{ title: string; snippet: string; score: number }` — RAG source |
| `ChatEvent` | Union: `cue`, `token`, `sources`, `done`, `error` — each with `id` + typed `data` |
| `ChatResult` | Final: `{ messageId, message, sources?, usage?, model, at }` |
| `StoredMessage` | Persisted message: `user` (id, content, context?, at) or `assistant` (id, content, at, sources?, usage?, model, finishedAt) |
| `ChatHistory` | `{ sessionId, messages: StoredMessage[], lastActivityAt }` |
| `SendInput` | `string \| { message: string; model?: string; context?: Context }` |
| `GreppaConfig` | `{ baseUrl, deployerKey?, fetch?, onProtocolMismatch?, sessionStore? }` |
| `SessionRecord` | `{ sessionId, sig, mintedAt }` |
| `SessionStore` | Interface: `get(scope)`, `set(scope, rec)`, `delete(scope)` |

### Chat API (`src/chat.ts`)

```typescript
class ChatNamespace {
  scope(name: string): ChatNamespace     // Create scoped conversation
  send(input: SendInput): ChatHandle     // Enqueue message (returns immediately)
  ask(input: SendInput): Promise<ChatResult>  // Send + drain (blocking convenience)
  resume(messageId: string): ChatHandle  // Reconnect to in-flight message
  history(): Promise<ChatHistory>        // Load conversation history
  reset(): Promise<void>                 // Clear session + server history
}

class ChatHandle {
  readonly events: AsyncIterable<ChatEvent>  // Raw event stream
  readonly cues: AsyncIterable<Cue>          // Progress cues only
  readonly tokens: AsyncIterable<Token>      // Text tokens only
  readonly sourcesStream: AsyncIterable<Source[]>  // Sources only
  readonly done: Promise<ChatResult>         // Final result
  abort(): void                              // Cancel stream
}
```

### Knowledge API (`src/knowledge.ts`)

```typescript
class KnowledgeNamespace {
  list(): Promise<{ articles: Article[]; total: number }>
  ingest(input: { title: string; content: string; tags?: string[] }): Promise<{ frameId, title, wordCount, message }>
  upload(input: { file: Blob; title: string; tags?: string[] }): Promise<{ frameId, title, wordCount | null, message }>
  get(frameId: string): Promise<Article>
  update(frameId: string, patch: Partial<{ title: string; tags: string[] }>): Promise<Article>
  delete(frameId: string): Promise<{ deleted: boolean }>
}
```

### React SDK (`src/react/index.tsx`)

```typescript
// Provider — wraps app with Greppa instance
<GreppaProvider baseUrl="..." scope="..." deployerKey?="...">
  <Chat />
</GreppaProvider>

// Hook — full chat state
function useChat(): {
  messages: StoredMessage[]     // Full conversation history
  send: (input: SendInput) => Promise<void>  // Send + auto-drain
  reset: () => Promise<void>    // Clear everything
  cue: Cue | null               // Current progress cue
  streaming: { content: string; sources: Source[] } | null  // In-progress response
  error: string | null
  isStreaming: boolean
}

// Hook — knowledge base CRUD
function useKnowledge(): {
  articles: Article[]
  isLoading: boolean
  error: string | null
  ingest: (input) => Promise<...>
  upload: (input) => Promise<...>
  refresh: () => Promise<void>
}
```

### Session Stores (`src/session/`)

- **`BrowserSession`** — stores sessions in `sessionStorage` (scoped by prefix `greppa:session:<scope>`)
- **`ServerSession`** — stores sessions in a `Map` (in-memory, not suitable for production server-side use)
- **`autoSessionStore()`** — auto-detects browser vs server environment

### Transport (`src/transport.ts`)

- **`sseIterator(opts)`** — async generator parsing SSE from `fetch()` + `ReadableStream`, with retry + backoff + `last-event-id` replay
- **`httpJson<T>(opts)`** — typed JSON fetch wrapper with error extraction

---

## Core Philosophy

Rather than POST-and-hold, Greppa uses a three-phase flow:

1. **Enqueue** — POST a message to `/chat`, get a job ID immediately (HTTP 202).
2. **Stream** — Subscribe via SSE at `/chat/stream`. If the connection drops, reconnect with `last-event-id` and resume exactly where you left off.
3. **Remember** — Every session is HMAC-signed, scoped, and retrievable. Conversations survive browser refreshes, network failures, and tab closures.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Web Framework | **Hono** via **Sumi** (file-based routing) |
| Validation | **Zod** + **hono-openapi** |
| API Docs | **Scalar** |
| Database | **PostgreSQL** via **Drizzle ORM** |
| Cache/Sessions | **Upstash Redis** |
| Pub/Sub | **Upstash Realtime** (SSE replay via retention) |
| Async Workflow | **Upstash QStash Workflow** (retries, idempotency, step checkpoints) |
| LLM Provider | **Groq** (Llama 3.3 70B, tool-use, streaming) |
| AI SDK | **Vercel AI SDK** (`streamText`) |
| Vector Store | **memvid** (`@memvid/sdk`) — local file-based `.mv2` with hybrid lexical + semantic search |
| Object Storage | **Cloudflare R2** (presigned uploads, memory snapshots) |
| Auth | **Better Auth** (email/password, Google OAuth, API keys, JWT) |

## Key Features

- **Async Chat Pipeline** — LLM generation runs via QStash Workflows, not inline handlers. Automatic retries and idempotency.
- **Resumable SSE Streaming** — All streams carry `last-event-id`. Dropped connections replay missed events from Realtime's 1-hour retention window.
- **HMAC-Signed Sessions** — Cryptographically signed with HMAC-SHA256, verified with `timingSafeEqual`. TTL-based, stored in Redis.
- **Knowledge Ingestion & RAG** — Ingest text articles via JSON, upload files via presigned R2 URLs, automated document parsing (text, HTML), hybrid lexical + semantic search via memvid.
- **LLM Tool-Use** — The chat agent uses `search_knowledge` and `remember` tools powered by Groq.
- **Prompt Injection Defense** — Two-layer: input blocks jailbreak patterns, retrieval redacts injection in knowledge sources.
- **Rate Limiting** — Two-tier: IP-level and session-level via Redis sliding windows.
- **Multi-Tenant Primitives** — Organizations, memberships, ACL-scoped memory (storage is still single-tenant).
- **First-Party SDK** — `@greppa/sdk` with Browser, React, and Server variants.

## Architecture (Data Flow)

```
Client → POST /chat (message + HMAC session header)
  → Middleware: session-auth → rate-limit → Redis history append
  → Returns 202 + messageId immediately
  → QStash Workflow triggers async:
    1. Scan for prompt injection
    2. Build context (org catalog + documents)
    3. Call Groq with tool-use (search_knowledge / remember)
    4. Stream tokens via Upstash Realtime channel
Client → GET /chat/stream?messageId=X (SSE)
  → Events: cue → token → sources → done
  → Reconnect with last-event-id → replay missed events
```

## Checkpoint System (`utils/checkpoint/`)

The Checkpoint system is Greppa's mechanism for providing **per-user vector memory databases** stored as binary `.mv2` files in Cloudflare R2. It acts as a **per-key, reference-counted, LRU-evicting, locally-cached, lock-managed file gateway** to object storage.

### Problem It Solves

Each user's memory is a single binary file (Memvid native vector store) stored in Cloudflare R2. The application needs to:
1. **Read** the file for semantic search / LLM question-answering (read-heavy, can take seconds).
2. **Write** new memories by opening the file, appending a record, sealing it, then uploading the new version back to R2.
3. **Not lose data** if two writes race — ETag-based optimistic concurrency prevents lost updates.
4. **Not serve torn reads** — a reader must never see a half-written file during a concurrent write.
5. **Keep the hot path fast** — recently accessed files cached locally on disk, not downloaded from R2 every time.
6. **Bound local disk usage** — evict cold entries when the cache grows too large.

### Architecture Overview

```
┌──────────────────────────────────────────────────────────────────────┐
│                         Checkpoint                                    │
│                                                                       │
│  ┌─────────────┐    ┌──────────────────┐    ┌────────────────────┐   │
│  │  read(key)   │    │  write(key, fn)  │    │  delete(key)      │   │
│  │  + snapshot  │    │  + etag-cond     │    │  + lock + cleanup │   │
│  │  isolation   │    │  upload + retry   │    │                   │   │
│  └──────┬──────┘    └────────┬─────────┘    └────────┬───────────┘   │
│         │                    │                        │               │
│         ▼                    ▼                        ▼               │
│  ┌──────────────────────────────────────────────────────────────┐    │
│  │                        Entry Cache                             │    │
│  │  (Map<string, {key, localPath, etag, refcount, lastUsed}>)    │    │
│  │  LRU eviction when open.size > maxOpen                        │    │
│  └──────────────────────────┬───────────────────────────────────┘    │
│                             │                                        │
│                             ▼                                        │
│  ┌──────────────────────────────────────────────────────────────┐    │
│  │                   Per-Key Mutex Locking                        │    │
│  │  (Mutex per key from async-mutex, serializes per-key ops)     │    │
│  └──────────────────────────┬───────────────────────────────────┘    │
│                             │                                        │
│                             ▼                                        │
│  ┌──────────────────────────────────────────────────────────────┐    │
│  │                   StorageBackend Interface                     │    │
│  │  head(key) | get(key) | putIfMatch(key, body, etag) |        │    │
│  │  delete(key) | list(prefix)                                   │    │
│  └────────────┬─────────────────────────────────┬───────────────┘    │
│               │                                  │                   │
│               ▼                                  ▼                   │
│  ┌────────────────────┐              ┌──────────────────────┐        │
│  │   R2Storage         │              │   MemoryStorage      │        │
│  │ (production: R2 S3) │              │  (testing: in-memory)│        │
│  └────────────────────┘              └──────────────────────┘        │
└──────────────────────────────────────────────────────────────────────┘
```

### Files

| File | Purpose |
|------|---------|
| `index.ts` | Barrel re-export |
| `checkpoint.ts` | Core `Checkpoint` class — 225 lines |
| `storage.ts` | `StorageBackend` interface + `MemoryStorage` test impl |
| `errors.ts` | `NotFoundError`, `ConflictError` |
| `client.ts` | `getCheckpoint()` singleton factory |
| `checkpoint.test.ts` | 228 lines, 12 test cases |

### Key Types

```typescript
type CheckpointConfig = {
  storage: StorageBackend
  cacheDir: string
  maxOpen: number
  idleMs: number
  now?: () => number
}

type ObjectMeta = { key: string; etag: string; size: number }

interface StorageBackend {
  head(key: string): Promise<ObjectMeta | null>
  get(key: string): Promise<{ body: Uint8Array; etag: string } | null>
  putIfMatch(key: string, body: Uint8Array, etag: string | null): Promise<string>
  delete(key: string): Promise<void>
  list(prefix: string): Promise<ObjectMeta[]>
}
```

### Write Flow

```
1. mutexFor(key).runExclusive() — acquire per-key Mutex
2. ensureOpen(key, create=true):
     a. Check Entry in this.open Map
     b. If miss → hydrate(key, true):
        - storage.get(key) → download from R2 (or null if new)
        - If null and create=true → return Entry with exists=false
        - If found → writeFile(localPath, body), return Entry with exists=true
3. Increment entry.refcount
4. evictIfNeeded(): if open.size > maxOpen, evict LRU idle entry
5. Call fn(localPath, exists):
     - exists=false → Memvid create() new store file
     - exists=true → Memvid use() existing store file
     - Caller appends data, then seal()s
6. flush(entry):
     - readFile(localPath) → bytes
     - storage.putIfMatch(key, body, entry.etag) → conditional upload
       - If ConflictError (ETag mismatch): re-head, retry once
     - Update entry.etag with new etag from storage
7. Set entry.exists = true
8. release(entry): decrement refcount, update lastUsed
9. Return fn's return value
```

### Read Flow (Snapshot Isolation)

```
1. mutexFor(key).runExclusive() — acquire per-key Mutex
2. ensureOpen(key, create=false):
     a. Check Entry in this.open Map
     b. If miss → hydrate(key, false):
        - storage.get(key) → download from R2
        - If null → throw NotFoundError
3. Increment entry.refcount
4. Snapshot isolation: copyFile(localPath → localPath + ".rd-" + uuid)
5. Release Mutex immediately (fn runs WITHOUT lock)
6. Call fn(snapshotPath) — reads snapshot while writes may happen in parallel
7. Finally: rm(snapshotPath), release(entry)
```

The snapshot isolation design means long LLM reads never block concurrent writes to the same memory file, and writes never cause torn reads.

### Singleton Factory (`client.ts`)

```typescript
getCheckpoint(): Checkpoint {
  // Creates with:
  //   storage: R2Storage.fromEnv()
  //   cacheDir: process.env.CHECKPOINT_CACHE_DIR ?? './.greppa/checkpoint'
  //   maxOpen: Number(process.env.CHECKPOINT_MAX_OPEN ?? 64)
  //   idleMs: Number(process.env.CHECKPOINT_IDLE_MS ?? 300_000)  // 5 min
  // Auto-starts periodic eviction in production
}
```

---

## Critical UX/UI Review (For the UI Builder)

Since you're building the UI from scratch, here is my honest assessment of what you're working with — what's good, what's questionable, and what's missing.

### What's Actually Good

**1. The event model (`Cue`) is well-designed for UI feedback.**

The 11 cue statuses (`scanning_input`, `building_context`, `thinking`, `searching_knowledge`, `reading_sources`, `generating`, `done`, `error`, `rate_limited`) give you granular, meaningful progress to show the user. You're not stuck guessing "is it working?" — you get structured statuses with timestamps and metadata (search queries, source counts, step numbers). This is genuinely better than most chat APIs.

**2. The fan-out pattern in `ChatHandle` is surprisingly good for UI.**

A `ChatHandle` gives you **five separate async iterables** (`events`, `cues`, `tokens`, `sourcesStream`, `done`) that all derive from the same SSE connection. The React SDK only uses `events` and `done`, but the architecture supports consuming only what you need. If you build a custom UI, you can render tokens incrementally while separately displaying sources and cues — all from a single connection.

**3. The React `useChat` hook gives you a sane baseline.**

`messages`, `send`, `reset`, `cue`, `streaming`, `error`, `isStreaming` — this is exactly the surface you need. It loads history on mount, appends user messages instantly, drains events, and commits the final assistant message. The hook handles the lifecycle correctly. It's a solid foundation.

**4. Session resumability is real.**

`sessionStorage` persistence + `last-event-id` replay means conversations survive page refreshes, tab closes, and network drops. The SDK handles this transparently. This is a genuinely differentiated feature — most chat UIs lose context on refresh.

**5. The `scope()` API is clean for multi-context UIs.**

```typescript
greppa.chat.scope(`article:${slug}`)
```

Each scope gets its own session, history, and rate limit. If the UI supports multiple concurrent conversations (sidebar threads, document-specific chats), this maps naturally.

### What's Questionable

**1. The fan-out pattern uses a custom promise-based queue (`makeFanout()`) instead of native `async iterable` teeing.**

The implementation in `chat.ts:185-246` builds a manual buffer + resolver pattern for each iterable. It works, but it's 60 lines of hand-rolled async queue logic that could be replaced with native `ReadableStream.tee()` or a library like `it-pushable`. The risk is subtle bugs around edge cases — what happens when `cues` and `tokens` are consumed at different rates? The implementation pushes to all queues synchronously, so if one consumer is slow, buffer grows there. A faster `tokens` consumer might finish before `cues` has pushed its last item. For React's `useChat` which drains `events` sequentially, this isn't an issue. But **if you build a custom UI that consumes `cues` and `tokens` independently**, you need to test this carefully.

**2. `ChatHandle` methods (`events`, `cues`, `tokens`) are public properties but the connection starts in the constructor.**

This means you cannot attach event handlers before the SSE connection begins. The constructor immediately starts `_consume()`. If you need to set up listeners, you're racing against the constructor. The `wrapPendingHandle` pattern in `send()` mitigates this (it returns a proxy that lazily resolves), but `resume(messageId)` constructs a `ChatHandle` directly and starts consuming immediately. If the UI needs to pause or set up state before consuming, there's no way to do it.

**3. No way to get intermediate token counts or usage streaming.**

The `done` event includes `usage` (token counts), but it only arrives at the very end. For long generations, the UI cannot show "generated X tokens so far" unless you count them yourself from the token stream. The `Cue` types include `step` numbers but not cumulative metrics. This is a minor thing but noticeable for power users.

**4. The React `useChat` hook has a stale closure problem.**

```typescript
const send = React.useCallback(async (input: SendInput) => {
  // ...
  for await (const ev of handle.events) {
    if (ev.type === 'token')
      setStreaming((s) => s ? { ...s, content: s.content + ev.data.token } : s)
  }
  // ...
}, [chat])  // only depends on chat
```

The `useCallback` dependency is `[chat]`, which is correct since `chat` from `useMemo` is stable. But `crypto.randomUUID()` is called inside `send` for the user message ID — this creates a new ID on every render cycle when send is called, which is fine, but the user message is appended via `setMessages((prev) => [...prev, ...])` with a freshly generated UUID, not the message ID the server would return. The server doesn't return user message IDs. This means **user messages in the UI have client-generated UUIDs while assistant messages have server-generated ULIDs**. Not a bug, but the inconsistency might cause issues if you need to reference messages by ID.

**5. The `useKnowledge` hook is thin to the point of being almost placeholder.**

It loads articles on mount and exposes `ingest`, `upload`, `refresh`. No pagination, no search, no filtering, no optimistic updates, no retry. For a knowledge-heavy UI this is barely a starting point. You'll likely rewrite this.

**6. `ChatNamespace` exposes `_ensureSession()` and `_sessionHeaders()` as public** (TypeScript `private` keyword, but no `#` prefix). The `KnowledgeNamespace` and `StatsNamespace` reach into `ChatNamespace` via `(this.chatNs as any)._ensureSession()`. This is a design smell — knowledge and stats should either share a session store directly or Chat should expose a public session method. It works, but it's fragile and loses type safety. If you're modifying the SDK, this is worth fixing.

### What's Missing (UI-Specific)

**1. No abort controller integration in `useChat`.**

The `ChatHandle` has `abort()` which internally calls `this._abort.abort()`. But `useChat` doesn't expose it. Calls to `send` block until the stream ends because of `for await`. If the user sends a new message while one is streaming, there's no way to cancel the previous generation. The current hook just lets both run — the second `send` call creates a second handle, but both stream into the same state. This could cause race conditions where old tokens overwrite new ones. You need to handle this in the UI.

**2. No connection state.**

There's no way to know if the SSE connection is currently open, reconnecting, or permanently failed. The `sseIterator` has a retry-with-backoff loop, but it's opaque to the consumer. If a user has a bad network, they just see nothing for 7 seconds (1+2+4s backoff) before an error surfaces. A `connectionStatus` observable in `ChatHandle` would let the UI show reconnecting indicators.

**3. No rate limit feedback in the React SDK.**

The `Cue` type includes `{ status: 'rate_limited', retryAfterMs: number }`, but `useChat` doesn't surface it differently from other cues. A rate-limited cue should probably set a special state so the UI can show "Slow down, try again in X seconds" rather than just another status message.

**4. The `StoredMessage` type doesn't carry the `messageId` from the server on user messages.**

User messages use `crypto.randomUUID()` on the client side. The server likely stores user messages with ULIDs. If you need to correlate UI messages with server records (e.g., for editing, deleting, or starring messages), you're missing the server ID for user messages.

**5. No file upload progress.**

`KnowledgeNamespace.upload()` uses `FormData` directly with `fetch`. There's no upload progress callback, no XHR-based progress tracking. For large file uploads, the UI cannot show a progress bar. You'd need to swap `fetch` for `XMLHttpRequest` or use `fetch` with a progress-tracking ReadableStream wrapper.

**6. No offline/fallback UI support.**

Everything requires network. If the server is unreachable, there's no offline queue, no cached responses, no stale-while-revalidate pattern. For a chat app this is understandable, but if you want to feel polished, you need to handle retry-after-reconnect gracefully rather than just showing an error.

**7. The SDK's `fetch` injection is not used by React hooks.**

`GreppaConfig` accepts a custom `fetch` implementation, which is important for testing (mocking network), React Native (which has a different fetch), or environments with custom auth interceptors. But the React hooks create the `Greppa` instance inside `GreppaProvider` and don't expose the ability to inject `fetch`. You'd need to lift this.

**8. No TypeScript generics on `useChat` for custom message types.**

If you want to extend `StoredMessage` with custom fields (e.g., message reactions, edit history, custom metadata), you're stuck with the union type. The SDK has no mechanism for augmentation.

---

## Database Schema

**Auth schema** (`db/schema/auth.ts`):
- `user` — Users with username, email, role, profile fields, soft-delete
- `session` — Browser/API sessions tied to users
- `account` — OAuth/linked accounts (Google, email)
- `verification` — Email verification records
- `apikey` — API keys with rate limiting, refill, expiration

**Tenant schema** (`db/schema/tenant.ts`):
- `organizations` — Multi-tenant orgs (id, name, slug)
- `memberships` — User-org membership with role (owner/admin/member) and group IDs
- `documents` — Ingested document records with status tracking (pending/processing/indexed/failed)
- `memoryEvents` — Audit trail for memory operations (ingest started/completed/failed)
- `ingestionJobs` — Async ingestion job tracking with progress, retries, error handling
- `ingestionJobEvents` — Granular event log per ingestion job step
- `memorySnapshots` — R2 snapshot history for the `.mv2` file
- `scopes` — Isolated memory scopes (personal/workspace/shared)
- `scopeMembers` — User access to scopes with roles (owner/editor/viewer)

---

## Notable Design Decisions

- **Lazy singleton pattern** — SDK clients (Redis, Groq, Realtime, Drizzle) are initialized via `Proxy` to avoid startup failures from missing env vars and to prevent Sumi from silently skipping routes.
- **Single-writer mutex** — Memory writes serialize through `p-queue` (concurrency 1) to prevent `.mv2` file corruption. The Checkpoint system has per-key locks, but the legacy `p-queue` path bypasses that — only works for single-tenant now.
- **Checkpoint snapshot isolation** — Read paths copy files under lock then release immediately, so long LLM reads never block concurrent writes.
- **Checkpoint ETag-based conditional writes** — Optimistic concurrency with single retry prevents lost updates.
- **Checkpoint LRU eviction** — Caps local disk usage by evicting least-recently-used idle entries.
- **Background R2 sync** — 5-minute interval snapshots the local `.mv2` to R2, keeping 24 snapshots, only when marked dirty.
- **Anonymous usage cap** — 5 messages per conversation for unauthenticated users.
- **Protocol versioning** — Every response carries `x-greppa-version` header.
