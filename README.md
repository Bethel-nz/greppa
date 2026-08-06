# greppa

Greppa is a context and delivery layer for AI systems that need to remember
across requests without making one browser connection or one server process part
of correctness.

It separates three concerns that are usually collapsed into a chat request:

- **Execution:** accepted work continues when the initiating request disappears.
- **Delivery:** generated output is recorded before it is broadcast and can be
  resumed from a sequence cursor.
- **Memory:** retrieval begins inside a resolved user or organization scope,
  backed by a memory file owned by that scope.

Two of those three are reusable, and it is worth being explicit about which:

| layer | what it is | reusable |
| --- | --- | --- |
| Transport | A **protocol** — enqueue, durable log, resumable stream, versioned events. Specified in [PROTOCOL.md](./docs/PROTOCOL.md). | Yes |
| **Checkpoint** | **Infrastructure** — serve a file from object storage into a bounded local cache, with immutable reads and compare-and-set writes. Its whole contract is `read(key, fn(localPath))`; it does not know what is in the file. | Yes |
| Scope store | **greppa's memory product** — schema, chunking, hybrid retrieval, per-document ACL. Opinionated, and increasingly so. | No |

The boundary is load-bearing: no product vocabulary enters `utils/checkpoint/`.
That discipline is why replacing the memory engine in July 2026 required zero
changes to it.

> **Status: active development.** Greppa is a working reference implementation,
> not a finished hosted product. The protocol, browser and React SDKs, scoped
> memory store, and Checkpoint lifecycle are implemented. End-to-end and
> operational hardening are ongoing.

The service is built with [Sumi](https://github.com/bethel-nz/sumi), Bun, Hono,
QStash, Redis, Cloudflare R2, SQLite, sqlite-vec, FTS5, and Groq.

## Why greppa?

Most chat APIs treat inference, delivery, and memory as one request. That is a
convenient interface until the tab refreshes, a worker is retried, or two users
must never retrieve from the same memory.

greppa treats chat as an **async workflow**:

1. **Enqueue:** `POST /chat` accepts the turn and returns a message ID.
2. **Record:** the worker writes sequenced events to a durable log before live
   delivery.
3. **Resume:** `/chat/stream` replays after `last-event-id`, then joins the live
   tail without skipping or reordering events.
4. **Remember:** the request resolves to an isolated memory scope before
   retrieval begins.

Memory is not a shared vector index with a tenant filter attached at query time.
Each scope owns a portable SQLite database containing documents, chunks, lexical
and vector indexes, a small provenance-backed relationship graph, and embedding
identity. Checkpoint hydrates that file from R2 on demand, gives readers
immutable generations, gives writers private copies, and publishes changes with
ETag compare-and-set.

## How it works

1. **Ingest** — POST an article or upload a file to `/knowledge`. Office files,
   PDFs, spreadsheets, EPUBs, and CSVs are converted to Markdown before chunking.
2. **Chat** — POST to `/chat` and stream via `/chat/stream`.
3. **Remember** — the agent can persist a fact with explicit entity edges, then
   ask for the relationships around a person, project, or decision later.
4. **Search** — Greppa decides when to query the knowledge base using tool-use.
   A conversation with a `workspaceId` gets an additional, folder-scoped search
   tool. Completed workspace exchanges are archived into that folder so the
   agent can recall a different conversation without searching the user's whole
   personal memory.

## Design notes

- [`docs/architecture.md`](./docs/architecture.md) defines the delivery
  contract, reconnect behavior, and execution boundaries.
- [`docs/memory-architecture.md`](./docs/memory-architecture.md) follows a scope
  through hydration, retrieval, mutation, conflict handling, and eviction.
- [`docs/why-own-memory.md`](./docs/why-own-memory.md) documents the measurements
  and trade-offs behind replacing the original memory engine.

## API

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/knowledge` | List all ingested articles |
| `POST` | `/knowledge` | Ingest a text article |
| `PUT` | `/knowledge` | Upload a document file (multipart) |
| `GET` | `/knowledge/:frameId` | Get article metadata |
| `PATCH` | `/knowledge/:frameId` | Update an article |
| `DELETE` | `/knowledge/:frameId` | Delete an article |
| `POST` | `/chat` | Enqueue chat generation |
| `GET` | `/chat/stream` | Subscribe to message SSE |
| `GET` | `/chat/history` | Load conversation history |
| `POST` | `/session` | Mint a new session |
| `GET` | `/stats` | Knowledge base storage stats |

Full interactive docs available at `/api/v1/docs` when running.

## SDK

### Browser (Fetch + ReadableStream)

The SDK manages HMAC-signed sessions in `sessionStorage` automatically. We avoid the native `EventSource` API because it doesn't support custom headers. The Fetch-based transport passes `x-greppa-session` and `last-event-id`, enabling secure, resumable streams.

```ts
import { Greppa } from '@greppa/sdk'

const greppa = new Greppa({ baseUrl: 'https://greppa.example.com' })

// scope is optional, default is 'default'
const chat = greppa.chat.scope(`article:${slug}`)

// 1. Load existing history (resumes session from sessionStorage)
const history = await chat.history()
console.log('Past messages:', history.messages)

// 2. Send a new message
const handle = chat.send('your question')

// 3. Stream tokens into the UI
const output = document.getElementById('ai-output')
for await (const t of handle.tokens) {
  output.textContent += t.token
}

// 4. Get final message details (sources, messageId)
const final = await handle.done
console.log('Finished. Sources:', final.sources)
```

### React

```tsx
import { GreppaProvider, useChat } from '@greppa/sdk/react'

function App() {
  return (
    <GreppaProvider baseUrl="..." scope="user-context">
      <Chat />
    </GreppaProvider>
  )
}

function Chat() {
  const { messages, send, streaming, isStreaming, cue } = useChat()
  return (
    <div>
      {messages.map(m => <p key={m.id}>{m.content}</p>)}
      {isStreaming && <p><i>{cue?.status}...</i> {streaming?.content}</p>}
      <button onClick={() => send("Hello!")}>Ask</button>
    </div>
  )
}
```

### Server (Full Privileges)

```ts
const greppa = new Greppa({ 
  baseUrl: 'https://greppa.example.com',
  deployerKey: process.env.GREPPA_KEY 
})

await greppa.knowledge.ingest({ 
  title: 'The Rust Book', 
  content: '...', 
  tags: ['rust'] 
})
```

## Getting started

```bash
cp .env.example .env   # add your keys
bun install
bun run dev
```

## Environment variables

See [`.env.example`](.env.example) for the full list. The ones you need to run it:

| Variable | Description |
|----------|-------------|
| `GROQ_API_KEY` | LLM inference (Groq, via the Vercel AI SDK). Get one at console.groq.com |
| `DATABASE_URL` | Postgres connection string |
| `GREPPA_SESSION_SECRET` | HMAC secret for SDK sessions (32+ chars) |
| `BETTER_AUTH_SECRET` | Secret for Better Auth (multi-tenant user login) |
| `BETTER_AUTH_URL` | Better Auth base URL |
| `GREPPA_PUBLIC_URL` | Public URL of your greppa server |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | Upstash Redis (event log + realtime) |
| `QSTASH_TOKEN` | Upstash QStash (async chat workflow) |
| `INTERNAL_API_KEY` | Worker-to-server auth |
| `R2_*` | Cloudflare R2 credentials and scope-memory bucket |
| `CHECKPOINT_CACHE_DIR` | Local directory for hydrated memory generations |
| `CHECKPOINT_MAX_OPEN` | Maximum number of scopes retained locally |
| `CHECKPOINT_MAX_CACHE_BYTES` | Byte budget for the local working set |
| `EMBEDDING_PROVIDER` | `google`, `openrouter`, `openai-compatible`, or deterministic development embeddings |

## Deployment

Greppa stores canonical scope files in R2 but opens them from a bounded local
Checkpoint cache. The runtime therefore needs a persistent, SSD-backed
filesystem. It is not designed for stateless serverless platforms unless that
cache is mounted on durable storage.

Recommended: any VPS or platform with persistent disk support (Railway, Render, Fly.io, DigitalOcean).

### Docker

```bash
docker compose up -d
```

The Checkpoint cache is persisted in a Docker volume (`greppa-data`). Set
required environment variables in a `.env` file before starting.

## Current limitations

- A memory write republishes the scope's complete SQLite file. That is a
  deliberate fit for bounded personal and team memory, not document-scale
  storage.
- The local cache is bounded by both scope count and bytes, but one scope larger
  than the byte budget may temporarily exceed it while in use.
- A conflicting write is re-run once against fresh state. Continued contention
  surfaces backpressure instead of spinning indefinitely.
- The protocol and memory primitives are implemented, but the hosted product
  still needs broader production exercise and operational tooling.

## Roadmap

- [x] Async chat execution with QStash
- [x] Durable, resumable SSE delivery
- [x] HMAC-signed session scopes
- [x] Per-scope SQLite memory with hybrid retrieval
- [x] Provenance-backed graph edges in scoped memory
- [x] Workspace-scoped retrieval across archived conversations
- [x] R2 hydration and conditional publishing through Checkpoint
- [x] Personal and organization memory boundaries
- [ ] Export and import for portable scope files
- [x] Document parsing for PDF, office files, Markdown, HTML, and CSV
- [ ] Protocol versioning and compatibility fixtures
- [ ] Production observability for memory hydration, conflicts, and retrieval

The long-term bet is that memory, delivery, and recovery should be reusable
protocol concerns rather than behavior rebuilt inside every AI feature.

## Commands

```bash
bun run dev     # development with hot reload
bun run build   # production build
bun run start   # start production server
bun test        # run tests
```

## License

MIT
