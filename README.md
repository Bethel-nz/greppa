# greppa

A reliable AI chat protocol for building systems that remember. Built on an async, resumable, session-scoped architecture that turns LLM inference into a robust message bus — not a fragile blocking call.

**Current release:** Personal knowledge API (single-tenant)  
**Ambition:** Multi-tenant AI memory protocol

Built with [Sumi](https://github.com/bethel-nz/sumi) (Bun + Hono), [memvid](https://github.com/Bethel-nz/memvid) for RAG, and [Groq](https://groq.com) for LLM inference.

## Why greppa?

Most chat APIs are synchronous request/response: you POST a message and pray the connection holds while the LLM thinks. If the tab refreshes, the network hiccups, or the user closes the laptop — the context is gone.

greppa treats chat as an **async workflow**:

1. **Enqueue** — POST your message to `/chat`. It returns immediately with a job ID.
2. **Stream** — Subscribe to `/chat/stream` via SSE. If the connection drops, reconnect with `last-event-id` and resume exactly where you left off.
3. **Remember** — Every session is HMAC-signed, scoped, and retrievable. Conversations survive browser refreshes, network failures, and tab closures.

The assistant (Greppa) uses tool-use to decide whether to search your knowledge base, retrieve relevant context, and stream the answer — or just chat.

## How it works

1. **Ingest** — POST an article or upload a file to `/knowledge`
2. **Chat** — POST to `/chat` and stream via `/chat/stream`
3. **Search** — Greppa decides when to query the knowledge base using tool-use

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

| Variable | Description |
|----------|-------------|
| `GROQ_API_KEY` | Required. Get one at console.groq.com |
| `GREPPA_SESSION_SECRET` | Required. HMAC secret for sessions (32+ chars) |
| `GREPPA_PUBLIC_URL` | Required. Public URL of your Greppa server |
| `UPSTASH_REDIS_REST_URL` | Required. Upstash Redis URL |
| `UPSTASH_REDIS_REST_TOKEN` | Required. Upstash Redis Token |
| `QSTASH_TOKEN` | Required. Upstash QStash Token |
| `MEMORY_PATH` | Path to the `.mv2` knowledge store (default: `chatbot-memory.mv2`) |

## Deployment

Requires a persistent filesystem for memvid — **not compatible with serverless platforms** (Vercel, Netlify, Cloudflare Workers).

Recommended: any VPS or platform with persistent disk support (Railway, Render, Fly.io, DigitalOcean).

### Docker

```bash
docker compose up -d
```

The knowledge store is persisted in a Docker volume (`greppa-data`). Set required environment variables in a `.env` file before starting.

## Current Limitations

greppa is a **single-tenant personal knowledge API** today. The architecture supports multi-tenancy (session isolation, scoped contexts, rate limits), but the underlying storage — [memvid](https://github.com/Bethel-nz/memvid) — uses a single `.mv2` file per instance with no native user isolation.

This means:
- ✅ Perfect for personal use or single-user deployments
- ✅ All the protocol primitives (sessions, resumable streams, async workflows) are production-ready
- ❌ Not yet suitable for multi-user SaaS without storage-layer work

## Roadmap

### Now — v1 (Personal)
- [x] Async chat pipeline with QStash
- [x] Resumable SSE streams with `last-event-id`
- [x] HMAC-signed session management
- [x] Knowledge ingestion + RAG tool-use
- [x] Browser + React SDK
- [x] Rate limiting (IP + session scoped)

### Next — v1.5 (Power User)
- [ ] Multiple knowledge bases per instance (namespace isolation in memvid)
- [ ] Export/import knowledge bundles
- [ ] Document parsing pipeline (PDF, Markdown, HTML)
- [ ] Webhook integrations for knowledge ingestion

### Future — v2 (Protocol)
- [ ] **Multi-tenant storage adapter** — either contribute isolation to memvid or add a Postgres/pgvector backend
- [ ] **Organization scoping** — teams, shared knowledge bases, permissions
- [ ] **Protocol versioning** — the `GREPPA_PROTOCOL_VERSION` header already exists; formalize the contract
- [ ] **Hosted offering** — greppa.cloud: we host the protocol, you bring the knowledge

The long-term bet is that reliable AI chat — with memory, resumability, and tool-use — should be a protocol, not a product you rebuild from scratch every time.

## Commands

```bash
bun run dev     # development with hot reload
bun run build   # production build
bun run start   # start production server
bun test        # run tests
```

## License

MIT
