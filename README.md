# greppa

A personal knowledge API. Ingest articles and documents, then chat with them via streaming AI powered by Groq.

Built with [Sumi](https://github.com/bethel-nz/sumi) (Bun + Hono), [memvid](https://github.com/Bethel-nz/memvid) for RAG, and [Groq](https://groq.com) for LLM inference.

## How it works

1. **Ingest** — POST an article or upload a file to `/knowledge`
2. **Chat** — POST to `/chat` and get a streaming SSE response
3. **Greppa** (the assistant) decides whether to search the knowledge base using tool-use, retrieves relevant context, then streams the answer

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

## Protocol + SDK

The chat protocol is documented in `docs/superpowers/specs/2026-04-25-greppa-sdk-and-protocol-design.md`. The SDK lives in `packages/sdk/`.

Required env: `GREPPA_SESSION_SECRET`, `GREPPA_PUBLIC_URL`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `QSTASH_TOKEN`, `GROQ_API_KEY`. See `.env.example`.

### Browser Usage

The SDK manages HMAC-signed sessions in `sessionStorage` automatically. It uses the modern **Fetch + ReadableStream** pattern to consume SSE.

> **Technical Note:** We avoid the native browser `EventSource` API because it does not support custom headers. The Fetch-based transport allows the SDK to pass critical `x-greppa-session` and `last-event-id` headers, enabling secure, resumable streams.

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

### React Integration

A full React layer is included in `@greppa/sdk/react`.

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

### Server Usage (Full Privileges)

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
| `MEMORY_PATH` | Path to the `.mv2` knowledge store (default: `chatbot-memory.mv2`) |
| `GREPPA_SESSION_SECRET` | Required. HMAC secret for sessions (32+ chars) |
| `GREPPA_PUBLIC_URL` | Required. Public URL of your Greppa server |
| `UPSTASH_REDIS_REST_URL` | Required. Upstash Redis URL |
| `UPSTASH_REDIS_REST_TOKEN` | Required. Upstash Redis Token |
| `QSTASH_TOKEN` | Required. Upstash QStash Token |

## Deployment

Requires a persistent filesystem for memvid — **not compatible with serverless platforms** (Vercel, Netlify, Cloudflare Workers).

Recommended: any VPS or platform with persistent disk support (Railway, Render, Fly.io, DigitalOcean).

### Docker

```bash
docker compose up -d
```

The knowledge store is persisted in a Docker volume (`greppa-data`). Set required environment variables in a `.env` file before starting.

## Commands

```bash
bun run dev     # development with hot reload
bun run build   # production build
bun run start   # start production server
```
