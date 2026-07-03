# Why You Don't Need WebSockets for Fast Agentic Workflows

## A Response to OpenAI's WebSocket-First Approach

**TL;DR:** WebSockets solve the wrong problem. The bottleneck in agentic loops isn't connection overhead — it's treating inference as a synchronous blocking call. Greppa's architecture proves you can get sub-second agent iterations with plain HTTP + SSE, while gaining reliability, observability, and infrastructure compatibility that WebSockets sacrifice.

---

## The OpenAI Argument (Summarized)

OpenAI's Codex team observed that as inference speeds hit 1,000+ TPS, API overhead became the bottleneck. Their solution:

1. **Persistent WebSocket connections** — Keep TCP open, avoid TLS handshakes
2. **In-memory state caching** — Cache rendered tokens, conversation history, tool definitions
3. **Overlapped execution** — Run billing/safety checks while the next request starts
4. **Result:** 40% faster agent rollouts

This is a real optimization. But it's optimizing the wrong abstraction.

---

## The Real Problem: Synchronous Agent Loops

OpenAI's WebSocket fix assumes this architecture:

```
Client                    API Server
  │                         │
  │  POST /v1/responses    │
  │  (full conversation)   │
  │────────────────────────>│
  │                         │
  │  [server validates]    │
  │  [re-tokenizes everything]
  │  [runs safety classifiers]
  │  [runs inference]      │
  │                         │
  │  response + tool_call  │
  │<────────────────────────│
  │                         │
  │  [client runs tool]    │
  │                         │
  │  POST /v1/responses    │
  │  (full conversation +  │
  │   tool result)         │
  │────────────────────────>│
  │  [repeat from top]     │
```

**The problem:** Each turn re-sends the full conversation, re-validates everything, re-tokenizes from scratch. The API treats each request as independent.

**OpenAI's fix:** Keep the connection open and cache state server-side.

**Greppa's approach:** Don't treat agent steps as independent API calls. Treat them as an async workflow.

---

## Greppa's Architecture: The Async Message Bus

```
Client                    Server                   Queue
  │                         │                        │
  │  POST /chat             │                        │
  │  { message }            │                        │
  │────────────────────────>│                        │
  │                         │  trigger workflow ────>│
  │  202 { messageId }      │                        │
  │<────────────────────────│                        │
  │                         │                        │
  │  GET /chat/stream       │                        │
  │  (SSE)                  │                        │
  │<════════════════════════│                        │
  │  cue: scanning_input    │                        │
  │  cue: thinking          │                        │
  │  token: "L"             │                        │
  │  token: "e"             │                        │
  │  token: "t"             │                        │
  │  ...                    │                        │
  │                         │                        │
  │                         │<───────────────────────│
  │                         │  QStash executes       │
  │                         │  workflow steps        │
  │                         │                        │
```

**Key difference:** The client makes **one request** to enqueue the job, then **streams results**. The agent loop runs server-side, not client-side. There's no "send full conversation back and forth" because the server already has the state.

---

## Why HTTP + SSE Beats WebSockets for Agents

### 1. State Lives in Redis, Not in Memory

OpenAI caches state "in-memory for the lifetime of the connection." This means:
- If the WebSocket drops, state is lost
- If the server restarts, state is lost
- Horizontal scaling requires sticky sessions or shared state anyway

Greppa stores everything in Upstash Redis:
- Conversation history: `history:{sessionId}` (Redis ZSET)
- Message metadata: `msg:{messageId}:meta` (Redis Hash)
- Session state: HMAC-signed, TTL-based

**Result:** The connection can drop, the server can restart, the client can switch devices — the conversation continues exactly where it left off.

### 2. Resumable by Default

WebSockets break, and when they do, you replay from scratch or implement complex resume logic.

Greppa's SSE streams support `last-event-id`:
```http
GET /chat/stream
last-event-id: msg_01H...seq_42
```

The server replays missed events from Upstash Realtime's 1-hour retention window. This isn't an optional feature — it's the fundamental transport model.

**WebSocket equivalent:** Would require custom heartbeat protocols, sequence tracking, and buffer management. SSE gives you this for free.

### 3. Firewalls, Proxies, and Infrastructure

WebSockets require:
- Upgrade headers
- Long-lived TCP connections
- Proxy support (not all corporate proxies handle WebSockets)
- Load balancer sticky sessions

HTTP + SSE requires:
- Regular HTTP
- Works through every proxy and firewall
- No connection upgrades
- Stateless load balancing

**Production reality:** Many enterprise environments block WebSockets. HTTP always works.

### 4. Observability and Debugging

With WebSockets:
- Binary frames are opaque
- Hard to inspect with `curl`
- Custom framing protocols

With HTTP + SSE:
```bash
curl -N https://api.greppa.com/chat/stream \
  -H "x-greppa-session: $SESSION" \
  -H "last-event-id: $LAST_ID"
```

Every event is plain text. Every tool can inspect it. Debugging is trivial.

### 5. The Async Workflow Advantage

OpenAI's WebSocket approach still assumes the client drives the loop:
1. Client sends request
2. Server generates + returns tool call
3. Client executes tool
4. Client sends result
5. Repeat

**The client is the orchestrator.** This is the real bottleneck — network round-trips between tool execution and model continuation.

Greppa's QStash Workflow inverts this:
1. Client sends message (one HTTP call)
2. Server-side workflow orchestrates the entire agent loop
3. Workflow can call tools, search knowledge, run safety checks — all server-side
4. Client just streams results

**The server is the orchestrator.** This eliminates client-side round-trips entirely.

### 6. Overlapped Execution Without WebSockets

OpenAI mentions "overlapping non-blocking postinference work like billing with subsequent requests."

Greppa achieves this naturally:
- Billing/metrics run asynchronously after the workflow step
- Safety checks run in parallel with token generation (streaming starts before safety finishes)
- Knowledge search runs in a separate workflow step, overlapped with model context building

No persistent connection needed — just proper async architecture.

---

## The Performance Comparison

Let's compare agent loop latency for a 5-turn agent task with 3 tool calls:

| Stage | OpenAI HTTP | OpenAI WebSocket | Greppa Async |
|-------|-------------|------------------|--------------|
| **Connection setup** | 5× TLS handshake | 1× WebSocket upgrade | 1× HTTP POST |
| **State transfer** | 5× full conversation | 1× cached | 0× (server already has it) |
| **Tokenization** | 5× from scratch | 1× cached | 1× (workflow persists state) |
| **Tool round-trips** | 3× client→server | 3× over WebSocket | 0× (server-side tools) |
| **Resumability** | None | Complex | Native (last-event-id) |
| **Total RTTs** | ~15 | ~6 | ~2 |

Greppa's approach requires **fewer round-trips than WebSockets** because the entire agent loop runs server-side.

---

## When WebSockets Make Sense

WebSockets are the right tool when:
- **True bidirectional streaming** — Client and server need to send data simultaneously without polling
- **Low-latency gaming/realtime collaboration** — Sub-100ms latency requirements
- **Binary protocols** — You need to send non-text data efficiently

For agentic workflows, none of these apply:
- The client mostly receives (streaming tokens), occasionally sends (user messages)
- Latency is dominated by inference, not transport
- All data is text (JSON, SSE events)

**WebSockets are overkill.** They're solving connection reuse for a problem that shouldn't require repeated connections in the first place.

---

## The Protocol-First Advantage

Greppa's transport is designed as a protocol, not an implementation detail:

```typescript
// Protocol primitives
interface ChatProtocol {
  // One-shot enqueue
  POST /chat → { messageId }
  
  // Resumable stream
  GET /chat/stream → SSE (with last-event-id)
  
  // Scoped sessions
  x-greppa-session: string
  x-greppa-session-sig: string
  
  // Typed events
  cue: { status: string }
  token: { token: string }
  sources: { hits: Source[] }
  done: { message: Message }
}
```

This protocol:
- Works over HTTP/1.1 (no upgrades needed)
- Works over HTTP/2 (multiplexed streams)
- Works over HTTP/3 (QUIC, no head-of-line blocking)
- Can be implemented by any client (browser, mobile, server)
- Can be cached by CDNs (for static content)
- Can be load-balanced by any reverse proxy

WebSockets lock you into a specific transport. Greppa's protocol is transport-agnostic.

---

## Countering Specific OpenAI Claims

### Claim: "WebSockets cache rendered tokens to skip re-tokenization"

**Greppa's counter:** Don't re-tokenize. The server-side workflow keeps the tokenized conversation in memory for the duration of the job. Redis stores the raw text. The workflow step loads once, tokenizes once, generates. No client-side state transfer needed.

### Claim: "WebSockets eliminate network hop latency"

**Greppa's counter:** The network hop exists because the client drives the loop. Move the loop server-side and there's nothing to hop. The client makes one POST, then watches the stream.

### Claim: "WebSockets overlap postinference work with subsequent requests"

**Greppa's counter:** This is trivial in an async architecture. Post a message to a queue, return immediately, process billing/metrics asynchronously. No persistent connection needed.

### Claim: "WebSocket mode is 40% faster"

**Greppa's counter:** 40% faster than their HTTP baseline, which was poorly optimized for agent loops. Greppa's architecture (server-side workflow + SSE streaming) would likely outperform both by eliminating client-side round-trips entirely.

---

## The Deeper Insight

OpenAI built WebSocket support because they couldn't change the fundamental API shape. Millions of developers use `POST /v1/chat/completions`. They had to optimize within that constraint.

Greppa was designed without that constraint. The API is the protocol. The protocol assumes:
- Generation is async
- State is server-side
- Clients are observers, not orchestrators
- Streams are resumable
- Connections are disposable

This isn't an optimization — it's a different paradigm.

---

## Conclusion

WebSockets are a band-aid for synchronous APIs. They solve connection reuse for a problem that shouldn't require repeated connections.

Greppa proves you can get faster agent rollouts with plain HTTP:
1. **Async workflows** eliminate client-side round-trips
2. **SSE streams** provide resumable, observable progress
3. **Redis state** survives connection drops and server restarts
4. **HTTP compatibility** works everywhere WebSockets don't

The future of agentic APIs isn't persistent connections. It's persistent workflows that don't care whether the client is connected.

---

## References

- [Greppa Architecture](./architecture.md)
- [OpenAI: Speeding up agentic workflows with WebSockets](https://openai.com/index/speeding-up-agentic-workflows-with-websockets/)
- [Server-Sent Events vs WebSockets](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events)
- [QStash Workflows](https://upstash.com/docs/qstash/workflows)
