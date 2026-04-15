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
| `POST` | `/chat` | Stream chat (SSE) |
| `GET` | `/stats` | Knowledge base storage stats |

Full interactive docs available at `/api/v1/docs` when running.

## Chat SSE events

The `/chat` endpoint streams Server-Sent Events in this sequence:

```
event: sources   # articles retrieved (may be empty)
event: token     # one per streamed token
event: done      # stream complete
```

## Getting started

```bash
cp .env.example .env   # add your GROQ_API_KEY
bun install
bun run dev
```

## Environment variables

| Variable | Description |
|----------|-------------|
| `GROQ_API_KEY` | Required. Get one at console.groq.com |
| `MEMORY_PATH` | Path to the `.mv2` knowledge store (default: `chatbot-memory.mv2`) |

## Deployment

Requires a persistent filesystem — **not compatible with serverless platforms** (Vercel, Netlify, Cloudflare Workers).

Recommended: any VPS or platform with persistent disk support (Railway, Render, Fly.io, DigitalOcean).

### Docker

```bash
docker compose up -d
```

The knowledge store is persisted in a Docker volume (`greppa-data`). Set `GROQ_API_KEY` in a `.env` file before starting.

## Commands

```bash
bun run dev     # development with hot reload
bun run build   # production build
bun run start   # start production server
```
