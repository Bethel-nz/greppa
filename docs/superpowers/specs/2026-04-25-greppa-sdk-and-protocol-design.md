# Greppa SDK and Protocol — Design

**Date:** 2026-04-25
**Status:** Draft, approved for implementation
**Audience:** Implementer (likely Gemini) + future contributors

---

## 1. Summary

Greppa is a self-hosted personal knowledge brain (memvid + Groq) currently exposed as REST + SSE over Sumi (Bun + Hono + file-based routing). This spec adds:

1. A **durable, resumable chat protocol** built on Upstash Redis + Realtime + Workflow. Streams survive tab close, refresh, and device switch within the bounds of a browser session.
2. A **typed TypeScript SDK** (`@greppa/sdk`) that works client-side and server-side from the same API surface. Adds a `cues` primitive so consumers can render their own UI against AI lifecycle states.
3. A **clear security posture** suited to a self-hosted single-tenant tool: CORS allowlist, server-issued HMAC-signed sessionIds, rate limiting, and an optional deployer key for destructive server-side ops.

Wire format stays SSE end-to-end. No WebSockets. No multi-user/auth concept.

## 2. Goals and non-goals

### Goals
- Anyone can deploy their own Greppa server and use the SDK against it with `{ baseUrl }` only.
- Chat sessions resume after tab close, refresh, or transient network drops within the same browser session.
- Conversations are scoped (per-article, per-route, etc.) so two contexts on the same site do not share history.
- The SDK exposes typed iterables for `tokens`, `cues`, `sources`, plus a multiplexed `events` stream.
- Deployers can ingest documents and chat from both browser and server.
- Destructive operations (DELETE on knowledge, stats) require a deployer key.

### Non-goals
- Multi-user authentication or accounts.
- Long-term conversation archive (a sidebar of past chats). History dies with the browser session, plus a Redis TTL.
- Cross-device sync of in-flight streams without explicit sessionId sharing.
- Node version of the SDK supporting all browser features (sessionStorage). Node uses an in-memory or file-backed session.
- Server runtimes other than Bun. Cloudflare Workers via `sumi build --target cloudflare` is a downstream concern.

## 3. Architecture

```
┌─ greppa-server (sumi/hono on bun) ─────────────────┐
│   routes/                                          │
│     session.ts          POST   /session            │
│     session/index.ts    DELETE /session            │
│     chat.ts             POST   /chat               │
│     chat/stream.ts      GET    /chat/stream        │
│     chat/history.ts     GET    /chat/history       │
│                         DELETE /chat/history       │
│     knowledge.ts        GET POST PUT  /knowledge   │
│     knowledge/[id].ts   GET PATCH DELETE           │
│     stats.ts            GET    /stats              │
│     workflows/                                     │
│       chat.ts           POST   /workflows/chat     │
│   middleware/                                      │
│     _index.ts           cors + rate-limit + log    │
│     session-auth.ts     verify HMAC(sessionId)     │
│     deployer-auth.ts    verify deployer key        │
│   lib/                                             │
│     redis.ts            Upstash Redis client       │
│     realtime.ts         Upstash Realtime client    │
│     workflow.ts         Upstash Workflow client    │
│     hmac.ts             sign/verify sessionId      │
│     emit.ts             dual-write ZSET + Realtime │
│     memory.ts           memvid (existing)          │
│     groq.ts             groq (existing)            │
│     security.ts         injection patterns + scan  │
└────────────────────────────────────────────────────┘
                          │
                          ▼ HTTPS + SSE
┌─ @greppa/sdk (universal TS, multi-entry) ──────────┐
│   src/                                             │
│     index.ts            Greppa class (universal)   │
│     transport.ts        fetch + SSE iterator       │
│     session/                                       │
│       browser.ts        sessionStorage adapter     │
│       server.ts         in-memory / file adapter   │
│     chat.ts             ChatHandle, scope, send,   │
│                         resume, reset, history     │
│     knowledge.ts        ingest, list, get, ...     │
│     cues.ts             Cue type union, helpers    │
│     types.ts            shared protocol types      │
│   react/                                           │
│     index.ts            GreppaProvider, useChat,   │
│                         useKnowledge, useCue       │
└────────────────────────────────────────────────────┘
```

### New runtime deps on the server
- `@upstash/redis`
- `@upstash/realtime`
- `@upstash/workflow`

### SDK build
- Authored in TypeScript with strict types.
- Built to ESM + CJS + `.d.ts` via `bun build` with `tsc --emitDeclarationOnly` for types.
- Multi-entry `package.json` `exports`:
  - `.` — universal core
  - `./react` — React hooks (peer dep on `react` >= 18)
- Zero runtime deps in core. Optional peer dep on `react` for the `/react` entry.

## 4. Protocol

### 4.1 Headers

| Header                   | Direction | Purpose                                                     |
|--------------------------|-----------|-------------------------------------------------------------|
| `x-greppa-session`       | request   | sessionId (ULID)                                            |
| `x-greppa-session-sig`   | request   | hex(HMAC-SHA256(sessionId, GREPPA_SESSION_SECRET))          |
| `x-greppa-deployer-key`  | request   | Server-side only. Bypasses rate limit, unlocks DELETE/stats |
| `last-event-id`          | SSE GET   | Last ULID the client saw; server replays from there         |
| `x-greppa-version`       | response  | Protocol version (`1`). SDK warns on mismatch               |
| `retry-after-ms`         | 429       | Numeric ms until retry permitted                            |

### 4.2 Endpoints

#### POST /session
Mint or refresh a session. No body.
```json
{ "sessionId": "01H...", "sig": "<hex>", "ttlMs": 172800000 }
```

#### DELETE /session
Invalidate the current sessionId. Server deletes `session:<id>` and `history:<id>`. Used on explicit logout / "new chat across all scopes."

#### POST /chat
Kick off a generation. Returns immediately (HTTP 202).
```jsonc
// req
{
  "message": "your question",
  "model": "llama-3.3-70b-versatile",
  "context": {                                // optional
    "selection": "the highlighted text...",
    "source":    "https://example.com/article/raft",
    "title":     "Understanding Raft",
    "surrounding": "...optional ~200 chars around the selection..."
  }
}
// res 202
{ "messageId": "01H...", "channel": "msg:01H..." }
```
Server appends the user message (with `context` attached if provided) to `history:<sessionId>` immediately. The workflow injects `context` as a synthetic system message before the user message so the LLM grounds its answer in the highlighted region plus the KB.

#### GET /chat/stream?messageId=<id>
Open SSE for a message. Headers: session + sig (no deployer key needed unless used server-side). Optional `last-event-id` resumes from there.

The server validates that the message belongs to the calling sessionId, then:
1. Replays all events from `msg:<messageId>:events` ZSET (skipping anything before `last-event-id` if provided).
2. If the message status is not `done`/`error`, subscribes to the Realtime channel and forwards events live.
3. Closes cleanly on `done` or `error`.

#### GET /chat/history?sessionId=<id>
Load the full conversation for a session.
```jsonc
// res 200
{
  "sessionId": "01H...",
  "messages": [
    { "id": "01H...", "role": "user",      "content": "...", "at": 1714... },
    { "id": "01H...", "role": "assistant", "content": "...", "at": 1714...,
      "sources": [{ "title": "...", "snippet": "...", "score": 0.87 }],
      "model": "llama-3.3-70b-versatile" }
  ],
  "lastActivityAt": 1714...
}
```
Server validates that `sessionId` in query matches `x-greppa-session`. (Prevents trivially scraping any sessionId you can guess.)

#### DELETE /chat/history
Wipe `history:<sessionId>` and any in-flight `msg:*:events`/`msg:*:meta` for that session. Used by `chat.reset()` in the SDK.

#### Knowledge endpoints
Same shapes as today (`POST` text, `PUT` file, `GET` list, `GET /[id]`, `PATCH /[id]`, `DELETE /[id]`). Routed through the same session-auth middleware.

`DELETE /knowledge/[id]` and `GET /stats` additionally require `x-greppa-deployer-key`. (Configurable via `allowPublicDelete: true`.)

### 4.3 SSE event taxonomy on /chat/stream

```
id: 01H...
event: cue
data: {"status":"thinking","at":1714123456789}

id: 01H...
event: sources
data: [{"title":"...","snippet":"...","score":0.87}, ...]

id: 01H...
event: token
data: {"token":"Rust"}

id: 01H...
event: done
data: {
  "messageId":"01H...",
  "message":"...full assistant reply...",
  "sources":[...],
  "usage": {"tokens": 1234},
  "model": "llama-3.3-70b-versatile",
  "at":1714...
}
```

Every event has an `id` (ULID) and a deterministic `seq` (per-message monotonic, used as ZSET score). Cues, sources, tokens, and done share the same channel/ZSET.

Sources are emitted as a single batch event (after search completes). The `done` event carries the full assistant reply so consumers can surface the result without re-assembling tokens.

### 4.4 Cue taxonomy

```ts
type Cue =
  | { status: 'idle';                at: number }
  | { status: 'scanning_input';      at: number }
  | { status: 'building_context';    at: number }
  | { status: 'thinking';            at: number; step?: number }
  | { status: 'searching_knowledge'; at: number; query: string; step?: number }
  | { status: 'reading_sources';     at: number; count: number }
  | { status: 'generating';          at: number }
  | { status: 'done';                at: number; messageId: string }
  | { status: 'error';               at: number; code: string; reason: string }
  | { status: 'rate_limited';        at: number; retryAfterMs: number }
```

Reserved for future use: `tool_calling`, `multi_step`, `summarizing`. Adding new statuses is non-breaking; consumers should default-case unknown statuses gracefully.

### 4.5 Errors

A typed `event: error` SSE event terminates the stream:
```json
{ "code": "rate_limited" | "groq_error" | "memvid_error" | "session_invalid" | "not_found" | "internal", "reason": "human-readable" }
```
HTTP-level errors (`401 session_invalid`, `403 forbidden`, `429 rate_limited`) only appear before the SSE upgrades. Once streaming, errors come as in-stream events so reconnect logic stays uniform.

### 4.6 Versioning

Every response carries `x-greppa-version: 1`. SDK exports `PROTOCOL_VERSION = 1`. Mismatch is logged at warn level, not fatal. Bumping the protocol = SDK major version.

## 5. Storage

### 5.1 Redis keyspace

| Key                        | Type    | Purpose                                          | TTL                                     |
|----------------------------|---------|--------------------------------------------------|-----------------------------------------|
| `session:<sessionId>`      | string (JSON: `{mintedAt, lastSeenAt}`) | Validates session existence              | 2 days, slid on every request           |
| `history:<sessionId>`      | ZSET (score=at_ms, member=JSON message)  | Conversation log                          | 2 days, slid on every write             |
| `msg:<messageId>:events`   | ZSET (score=seq, member=JSON event)      | Per-message replay log                    | 1 hour after last write                 |
| `msg:<messageId>:meta`     | hash (`sessionId`, `status`, `startedAt`, `finishedAt`, `model`) | Lookup + ownership check | 1 hour                                   |
| `rate:<scope>:<bucket>`    | counter | Rate limit counter (scope=ip\|sessionId)         | window length                           |

Realtime channel: `msg:<messageId>` — for live tailing only. ZSET is source of truth.

### 5.2 Stored message shape

```ts
type StoredMessage =
  | { id: string; role: 'user';      content: string; at: number }
  | { id: string; role: 'assistant'; content: string; at: number;
      sources?: Array<{ title: string; snippet: string; score: number }>;
      model: string;
      finishedAt: number }
```

### 5.3 Stored event shape

```ts
type StoredEvent = {
  id: string                                         // ULID, used as last-event-id
  seq: number                                        // monotonic per-message
  type: 'cue' | 'source' | 'token' | 'done' | 'error'
  data: unknown                                      // matches the SSE data field exactly
}
```

### 5.4 Workflow

Generation runs inside `@upstash/workflow`. `POST /chat` only enqueues; the workflow is the one component that calls Groq and memvid.

`routes/workflows/chat.ts`:
```ts
import { serve } from '@upstash/workflow/hono'
import { realtime } from '@/lib/realtime'
import { redis } from '@/lib/redis'
import { makeEmitter } from '@/lib/emit'
import { isInjectionAttempt, scanRetrievedSnippet } from '@/lib/security'
import { getGroq } from '@/lib/groq'
import { getReader } from '@/lib/memory'

export const { POST } = serve(async (workflow) => {
  const { sessionId, messageId, message, model } = workflow.requestPayload as {
    sessionId: string; messageId: string; message: string; model: string
  }
  const emit = makeEmitter({ messageId })

  await emit('cue', { status: 'scanning_input', at: Date.now() })
  if (isInjectionAttempt(message)) {
    await emit('error', { at: Date.now(), code: 'injection_blocked',
      reason: 'I can only help with the knowledge base.' })
    return
  }

  await emit('cue', { status: 'building_context', at: Date.now() })
  const catalogNote = await workflow.run('build-catalog', () => buildCatalog())

  await emit('cue', { status: 'thinking', at: Date.now() })
  const probe = await workflow.run('probe', () => groqProbe({ model, message, catalogNote }))

  let sources: Array<{ title: string; snippet: string; score: number }> = []
  let toolMessages: any[] = []
  if (probe.toolCall) {
    const { query } = probe.toolCall
    await emit('cue', { status: 'searching_knowledge', at: Date.now(), query })
    const result = await workflow.run('search', () => getReader().then((m) => m.ask(query, { returnSources: true, k: 5 })))
    sources = (result.sources ?? []).map((s: any) => ({ title: s.title, snippet: s.snippet, score: s.score }))
    await emit('cue', { status: 'reading_sources', at: Date.now(), count: sources.length })
    for (const src of sources) await emit('source', src)
    const safeContext = scanRetrievedSnippet(result.context ?? '')
    toolMessages = [
      probe.assistantMessage,
      { role: 'tool', tool_call_id: probe.toolCall.id, content: safeContext },
    ]
  }

  await emit('cue', { status: 'generating', at: Date.now() })
  const groq = getGroq()
  const completion = await groq.chat.completions.create({
    model,
    messages: [...probe.baseMessages, ...toolMessages],
    stream: true,
  })

  let content = ''
  for await (const chunk of completion) {
    const token = chunk.choices[0]?.delta?.content ?? ''
    if (token) { content += token; await emit('token', { token }) }
  }

  const finalMsg = {
    id: messageId, role: 'assistant', content, at: Date.now(),
    sources: sources.length ? sources : undefined, model, finishedAt: Date.now(),
  }
  await redis.zadd(`history:${sessionId}`, { score: finalMsg.at, member: JSON.stringify(finalMsg) })
  await redis.expire(`history:${sessionId}`, 60 * 60 * 24 * 2)

  await redis.hset(`msg:${messageId}:meta`, { status: 'done', finishedAt: Date.now() })
  await emit('done', { messageId, at: Date.now() })
})
```

### 5.5 Realtime schema and emit() — sole writer of the wire format

Upstash Realtime is schema-typed. Define a `msg` namespace with one event per SSE event type:

`lib/realtime.ts`:
```ts
import { Realtime, InferRealtimeEvents } from '@upstash/realtime'
import { z } from 'zod'
import { redis } from './redis'

const storedEvent = z.object({
  id: z.string(), seq: z.number(),
  type: z.enum(['cue', 'source', 'token', 'done', 'error']),
  data: z.any(),
})

export const schema = {
  msg: {
    cue:    storedEvent,
    source: storedEvent,
    token:  storedEvent,
    done:   storedEvent,
    error:  storedEvent,
  },
}

export const realtime = new Realtime({ schema, redis })
export type RealtimeEvents = InferRealtimeEvents<typeof realtime>
```

`lib/emit.ts`:
```ts
import { ulid } from 'ulid'
import { redis } from './redis'
import { realtime } from './realtime'

export type EmitType = 'cue' | 'source' | 'token' | 'done' | 'error'

export function makeEmitter({ messageId }: { messageId: string }) {
  const channel = realtime.channel(messageId)
  let seq = 0
  return async function emit(type: EmitType, data: unknown) {
    const id = ulid()
    seq += 1
    const event = { id, seq, type, data }
    await Promise.all([
      redis.zadd(`msg:${messageId}:events`, { score: seq, member: JSON.stringify(event) }),
      channel.emit(`msg.${type}`, event),
    ])
    await redis.expire(`msg:${messageId}:events`, 3600)
  }
}
```

Subscribers (`/chat/stream`) attach one listener per event type and resolve the outer promise when `done` or `error` fires:
```ts
await new Promise<void>((resolve) => {
  const forward = async (ev: any) => {
    await stream.writeSSE({ id: ev.id, event: ev.type, data: JSON.stringify(ev.data) })
  }
  channel.on('msg.cue', forward)
  channel.on('msg.source', forward)
  channel.on('msg.token', forward)
  channel.on('msg.done', async (ev) => { await forward(ev); resolve() })
  channel.on('msg.error', async (ev) => { await forward(ev); resolve() })
})
```

### 5.6 GET /chat/stream — replay then tail

```ts
stream: async (stream, c) => {
  const messageId = c.req.valid('query').messageId
  const lastEventId = c.req.header('last-event-id')
  const sessionId = c.get('sessionId')

  const meta = await redis.hgetall<{ sessionId: string; status: string }>(`msg:${messageId}:meta`)
  if (!meta || meta.sessionId !== sessionId) {
    await stream.writeSSE({ event: 'error', data: JSON.stringify({ code: 'not_found', reason: 'unknown message' }), id: ulid() })
    return
  }

  const raw = await redis.zrange(`msg:${messageId}:events`, 0, -1)
  let resumeIndex = 0
  if (lastEventId) {
    const idx = raw.findIndex((r) => JSON.parse(r as string).id === lastEventId)
    if (idx >= 0) resumeIndex = idx + 1
  }
  for (const r of raw.slice(resumeIndex)) {
    const ev = JSON.parse(r as string)
    await stream.writeSSE({ id: ev.id, event: ev.type, data: JSON.stringify(ev.data) })
  }

  if (meta.status !== 'done' && meta.status !== 'error') {
    const channel = realtime.channel(messageId)
    await channel.on('*', async (ev: any) => {
      await stream.writeSSE({ id: ev.id, event: ev.type, data: JSON.stringify(ev.data) })
      if (ev.type === 'done' || ev.type === 'error') {
        await stream.close()
      }
    })
  }
}
```

## 6. SDK

### 6.1 Universal core

`@greppa/sdk` exports a single `Greppa` class. The class auto-selects a session adapter at construction time:
- If `globalThis.window?.sessionStorage` exists → `BrowserSession`. Reads/writes `greppa:session:<scope>` in sessionStorage. `deployerKey` is rejected at construction (it should never ship to the browser).
- Else if `deployerKey` is provided → `ServerSession`. Maintains an in-memory `Map<scope, {sessionId, sig}>` and mints sessions via `POST /session` on first use. Sends `x-greppa-deployer-key` on every request, which bypasses rate limit and unlocks DELETE/stats. Chat still works (sessions are still required for chat history continuity), but with full deployer privileges.
- Else → throws. SDK requires either a browser environment or a `deployerKey`.

The `ServerSession`'s in-memory map is per-instance — a CLI script that wants stable sessions across runs should pass an explicit `sessionStore` adapter (file-backed, redis-backed, etc.) via the constructor's `sessionStore` option. Default in-memory is fine for short-lived scripts.

```ts
import { Greppa } from '@greppa/sdk'

const greppa = new Greppa({
  baseUrl: 'https://greppa.example.com',
  // optional
  deployerKey: process.env.GREPPA_KEY,
  fetch: globalThis.fetch,                 // override for testing
  onProtocolMismatch: (seen, expected) => console.warn(`v${seen} != v${expected}`),
})
```

### 6.2 Chat surface

```ts
// scope is optional, default is 'default'
const chat = greppa.chat.scope(`article:${slug}`)

// send accepts string OR object form; returns a ChatHandle (kicks off immediately)
const handle = chat.send('what about Rust ownership?')
const handle = chat.send({
  message: 'Explain this',
  context: {
    selection: '<highlighted text>',
    source: window.location.href,
    title: document.title,
  },
  model: 'llama-3.3-70b-versatile',
})

// non-streaming convenience — drains the handle and returns ChatResult
const res = await chat.ask('Explain Raft')
const res = await chat.ask({ message: 'Explain this', context: {...} })
// res: { message, sources, usage? }

// flat typed events on the handle (token/cue/sources/done/error)
for await (const ev of handle.events) {
  switch (ev.type) {
    case 'token':   appendText(ev.token); break
    case 'cue':     setStatus(ev.status); break          // ev.cue carries full Cue payload
    case 'sources': setSources(ev.sources); break        // batched once
    case 'done':    finalize(ev.result); break           // full ChatResult
    case 'error':   showError(ev); break
  }
}

// or filtered iterables
for await (const tok of handle.tokens)   appendText(tok.token)
for await (const cue of handle.cues)     setStatus(cue.status)
for await (const list of handle.sourcesStream) setSources(list)  // fires once

// promise that resolves with the full ChatResult
const result = await handle.done   // { message, sources, usage? }

// resume an existing message (e.g. after page reload)
const handle = chat.resume(messageId)

// load the conversation
const history = await chat.history()  // ChatHistory

// wipe this scope's session entirely (server + sessionStorage)
await chat.reset()

// abort the current generation (closes SSE, leaves Redis ZSET intact)
handle.abort()
```

### 6.3 Knowledge surface

Universal — works in both browser (rate-limited via session) and server (no rate limit via deployer key).

```ts
// list
const { articles, total } = await greppa.knowledge.list()

// ingest text
const { frameId } = await greppa.knowledge.ingest({
  title: 'The Rust Book',
  content: '...',
  tags: ['rust', 'book'],
})

// upload a file (browser File or server-side Blob path)
const { frameId } = await greppa.knowledge.upload({
  file,                            // File | Blob
  title: 'paper.pdf',
  tags: ['research'],
})

// single
const article = await greppa.knowledge.get(frameId)

// update
await greppa.knowledge.update(frameId, { tags: ['rust', 'advanced'] })

// delete (requires deployerKey unless allowPublicDelete is true)
await greppa.knowledge.delete(frameId)
```

### 6.4 Stats

```ts
const stats = await greppa.stats()  // requires deployerKey unless allowPublicStats
```

### 6.5 React entry

`@greppa/sdk/react`:
```tsx
import { GreppaProvider, useChat, useKnowledge } from '@greppa/sdk/react'

<GreppaProvider
  baseUrl="..."
  scope={`article:${slug}`}
  theme={{ mode: 'system', accent: '#7c3aed', radiusMd: '14px' }}
>
  <ChatWidget />
</GreppaProvider>

function ChatWidget() {
  const { send, reset, messages, status, sources, isStreaming } = useChat()
  // status is the latest cue
  // messages is the persisted history (auto-loaded on mount via /chat/history)
  // isStreaming reflects whether a handle is currently active
}

function KnowledgeBrowser() {
  const { articles, ingest, upload, isLoading } = useKnowledge()
}
```

`useChat` internally:
- Mints/loads sessionId for the provider's `scope` on mount.
- Calls `/chat/history` once on mount to hydrate `messages`.
- Manages a single active `ChatHandle` per render cycle.
- Reattaches to in-flight messages if `sessionStorage` has an unfinished `messageId` (set when `send` is called, cleared on `done`).

### 6.6 SSE consumer

The transport wraps `fetch` + `ReadableStream` into an `AsyncIterable<{id, event, data}>`. Reconnection logic:
- On network drop, retry up to 3 times with exponential backoff (1s, 2s, 4s).
- Each retry sends `last-event-id` so the server replays from there.
- After 3 failures, the handle's iterables throw a `GreppaStreamError`.

```ts
// transport.ts (sketched)
export async function* sseIterator(opts: { url: string; headers: Headers; signal: AbortSignal }): AsyncGenerator<SseEvent> {
  let lastId: string | undefined
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const headers = new Headers(opts.headers)
      if (lastId) headers.set('last-event-id', lastId)
      const res = await fetch(opts.url, { headers, signal: opts.signal })
      if (!res.body) throw new GreppaStreamError('no body')
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
      let buf = ''
      while (true) {
        const { value, done } = await reader.read()
        if (done) return
        buf += value
        let nl
        while ((nl = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, nl); buf = buf.slice(nl + 2)
          const ev = parseSseBlock(block)
          if (ev) {
            lastId = ev.id ?? lastId
            yield ev
            if (ev.event === 'done' || ev.event === 'error') return
          }
        }
      }
    } catch (err) {
      if (opts.signal.aborted) return
      if (attempt === 3) throw err
      await sleep([1000, 2000, 4000][attempt])
    }
  }
}
```

### 6.7 Theming

The Provider mounts a `<div data-greppa-root data-theme="light|dark">` and a scoped `<style>` with the user's CSS-variable overrides. Defaults ship in `theme.css`. Users override either by passing a `theme` prop:

```tsx
<GreppaProvider theme={{ mode: 'dark', accent: '#7c3aed', radiusMd: '14px' }} />
```

or by writing CSS against the variable surface:

```css
[data-greppa-root] { --greppa-accent: #7c3aed; }
```

`mode: 'system'` listens to `prefers-color-scheme`. `prefers-reduced-motion` collapses `--greppa-duration-*` to `1ms`. Below 640px width the panel goes full-screen via a media query — no JS branching needed.

`GreppaTheme` shape: see `packages/sdk/src/react/theme.ts`. Every visible style in the SDK references one of these tokens; users never need to touch class names to re-skin Greppa.

## 7. Security posture

| Concern                                  | Mechanism                                                          |
|------------------------------------------|--------------------------------------------------------------------|
| Cross-site abuse                         | CORS allowlist, deployer-configured. No `*` ever.                  |
| Session forgery                          | Server-issued HMAC-signed sessionId. `GREPPA_SESSION_SECRET` env.  |
| Bot abuse / cost drain                   | Rate limit by IP and by sessionId, deployer-configured.            |
| KB vandalism                             | DELETE/stats require deployer key. Configurable.                   |
| Prompt injection in user input           | `INJECTION_PATTERNS` regex scan (existing).                        |
| Prompt injection in retrieved snippets   | `scanRetrievedSnippet()` strips/neutralizes patterns before LLM.   |
| Replay of stale signed sessionId         | `mintedAt` checked; max age 7d hard cap.                           |
| Leakage via client-shipped secret        | No client secrets. Browser SDK config is `{ baseUrl }` only.       |

`scanRetrievedSnippet` walks each retrieved chunk against `INJECTION_PATTERNS`. If a pattern matches, the snippet is replaced with `[redacted: potential prompt injection in source]` (kept in context for transparency, but neutralized).

## 8. Configuration

`sumi.config.ts` gains a `greppa` section:

```ts
import { defineConfig } from '@bethel-nz/sumi'

export default defineConfig({
  port: 3000,
  basePath: '/api/v1',
  routesDir: './routes',
  middlewareDir: './middleware',

  cors: {
    origin: ['https://mysite.com'],   // required - no '*'
    credentials: true,
  },

  greppa: {
    sessionSecret: process.env.GREPPA_SESSION_SECRET!,   // required, 32+ bytes
    deployerKey: process.env.GREPPA_DEPLOYER_KEY,        // optional but recommended
    sessionTtlMs: 1000 * 60 * 60 * 24 * 2,               // 2 days
    messageTtlMs: 1000 * 60 * 60,                        // 1 hour
    rateLimit: {
      ip: { windowMs: 60_000, limit: 60 },
      session: { windowMs: 60_000, limit: 30 },
    },
    allowPublicDelete: false,
    allowPublicStats: false,
  },
})
```

## 9. Migration from existing code

The current single-shot `routes/chat.ts` is replaced by:
- `routes/chat.ts` (POST only, enqueues workflow)
- `routes/chat/stream.ts` (GET, replay + tail)
- `routes/chat/history.ts` (GET + DELETE)
- `routes/workflows/chat.ts` (the actual generator)
- `routes/session.ts` (POST + DELETE)

Knowledge routes keep their handlers but switch to using the new middleware pipeline. `lib/groq.ts` and `lib/memory.ts` stay as-is. New files: `lib/redis.ts`, `lib/realtime.ts`, `lib/workflow.ts`, `lib/hmac.ts`, `lib/emit.ts`, `lib/security.ts`.

The existing `INJECTION_PATTERNS` block in `routes/chat.ts` moves to `lib/security.ts`.

## 10. Testing

- **Unit:** `lib/hmac.ts` (sign/verify roundtrip), `lib/emit.ts` (mocks redis + realtime, asserts dual write), `lib/security.ts` (injection coverage).
- **Integration:** `createMockApp` (Sumi testing helper) with a real Upstash test instance OR an in-memory mock. Cover: full chat flow, resume after disconnect, scope isolation, session expiry, deployer key bypass.
- **SDK:** Vitest or Bun test with `mockFetch` + a fake SSE source. Cover: scope namespacing, sessionStorage adapter, reconnect/last-event-id replay, error propagation.
- **End-to-end:** A small browser harness that runs `/chat/history` + `chat.send` + tab-close + reattach in a single test.

## 11. Repo structure

Recommended monorepo (Bun workspaces) so types stay in lockstep:
```
greppa/
  apps/
    server/          # current sumi app (move existing code here)
  packages/
    sdk/             # @greppa/sdk
    sdk-react/       # @greppa/sdk/react (or as exports of sdk)
  package.json       # workspaces: ["apps/*", "packages/*"]
```

Acceptable alternative: keep `greppa` as the server repo, publish `@greppa/sdk` from a separate repo, share types via a published `@greppa/types` package. Slightly more friction; same end result.

## 12. Open questions

1. **Workflow latency tax.** Each `workflow.run()` step adds Upstash round-trips. ~5 steps = ~250ms baseline. If unacceptable, add a fast path that skips Workflow for short messages and writes events directly. Decision deferred to perf testing.
2. **Memvid concurrency.** memvid's reader/writer are not concurrency-tested under workflow-driven load. May need a queue if multiple workflows hit `mem.ask`/`mem.put` simultaneously.
3. **Realtime channel lifecycle.** Confirm Upstash Realtime auto-cleans channels with no subscribers + no recent emissions, or set explicit cleanup.
4. **React provider scope changes.** When `<GreppaProvider scope={...}>` re-renders with a new scope, `useChat` should swap sessionId without remounting. Implementation detail to validate.

## 13. Out of scope

- Authentication / multi-user.
- Conversation archive / sidebar.
- Cross-device session handoff (without explicit ID copy).
- Non-Bun server runtime.
- Analytics / observability beyond protocol versioning + structured logs.
