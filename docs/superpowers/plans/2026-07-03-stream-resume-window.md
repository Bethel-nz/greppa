# Streaming Resume Window Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give chat streaming an OpenAI-style resume window: leave a generating message, reconnect within ~5 minutes, and resume from the exact token where it stopped.

**Architecture:** `emit` dual-writes every event to a short-lived Redis ZSET (`msg:<id>:events`, scored by a monotonic `seq`) that is the authoritative replay source; Upstash Realtime stays the live-tail transport only. The stream handler snapshots the ZSET, replays from a `seq` cursor, then tails. A single time window governs the log TTL, meta TTL, and the stalled-stream bound. Past the window, the finished answer comes from the existing 2-day conversation history, not the stream.

**Tech Stack:** Bun test runner, Hono/Sumi router, `@upstash/redis`, `@upstash/realtime`, `@upstash/workflow`, Zod.

## Global Constraints

- No emoji anywhere — source, logs, comments, commit messages. Plain ASCII only.
- Clean, minimal implementations. Follow existing patterns in the file you touch; do not restructure unrelated code.
- Tests run with `bun test <path>`. Every test file's first import is `'./_mocks'` (before any module that pulls in `lib/redis` / `lib/realtime` / `lib/workflow`).
- Do not run `git commit` unless the executor is explicitly told to; the "Commit" steps are for the human/executor to run at their discretion.
- Resume window default: **5 minutes = 300000 ms**. Env var: `GREPPA_RESUME_WINDOW_MS`. Config field: `resumeWindowMs`.
- SSE control frames written directly by the handler (`bad_request`, `not_found`, `stalled`) carry **no `id`**. Only replayed/tailed events carry `id: String(seq)`.

---

## File Structure

- `lib/config.ts` — rename `messageTtlMs` -> `resumeWindowMs`; env `GREPPA_MESSAGE_TTL_MS` -> `GREPPA_RESUME_WINDOW_MS`, default 300000.
- `lib/emit.ts` — event `id` becomes `String(seq)`; dual-write ZADD-first (+ EXPIRE) to `msg:<id>:events` via pipeline; take `ttlMs`.
- `lib/realtime.ts` — `history.expireAfterSecs` -> 60 (transport buffer only).
- `lib/chat/lifecycle.ts` — **new.** `beginRun` (terminal-status no-op guard + reset events log) and `setMeta` (hset + re-anchored EXPIRE). Extracted so the logic is testable outside the untestable `serve()` wrapper and the meta-write pattern is not duplicated three times.
- `routes/chat.ts` — meta TTL from `resumeWindowMs`.
- `routes/chat/stream.ts` — seq cursor with unparseable/stale fallback; subscribe-then-snapshot replay; no-`id` control frames; stalled-stream bound.
- `routes/workflows/chat.ts` — use `beginRun` guard + `setMeta`; pass `ttlMs` to `makeEmitter`.
- `tests/server/_mocks.ts` — add `pipeline()` support to the redis mock.
- `tests/server/config.test.ts` — follow the config rename.
- `tests/server/chat-resume.test.ts` — **new.** Resume/replay/stalled coverage.
- `.env.example` — document `GREPPA_RESUME_WINDOW_MS`.

---

## Task 1: Config rename

**Files:**
- Modify: `lib/config.ts:4`, `lib/config.ts:40`
- Modify: `routes/chat.ts:60`
- Modify: `.env.example:25`
- Test: `tests/server/config.test.ts:9,24,32,38`

**Interfaces:**
- Produces: `GreppaConfig.resumeWindowMs: number` (default 300000), replacing `messageTtlMs`.

- [ ] **Step 1: Update the config test to the new field/env**

In `tests/server/config.test.ts`, replace the three `GREPPA_MESSAGE_TTL_MS` / `messageTtlMs` references:

Line 9: `delete process.env.GREPPA_MESSAGE_TTL_MS` -> `delete process.env.GREPPA_RESUME_WINDOW_MS`

Line 24: `expect(cfg.messageTtlMs).toBe(1000 * 60 * 60)` -> `expect(cfg.resumeWindowMs).toBe(300000)`

Line 32: `process.env.GREPPA_MESSAGE_TTL_MS = '5000'` -> `process.env.GREPPA_RESUME_WINDOW_MS = '5000'`

Line 38: `expect(cfg.messageTtlMs).toBe(5000)` -> `expect(cfg.resumeWindowMs).toBe(5000)`

- [ ] **Step 2: Run the config test to verify it fails**

Run: `bun test tests/server/config.test.ts`
Expected: FAIL — `cfg.resumeWindowMs` is undefined / `messageTtlMs` still expected elsewhere.

- [ ] **Step 3: Rename the field and env in config.ts**

In `lib/config.ts`, line 4 (in the `GreppaConfig` type):

```typescript
  resumeWindowMs: number
```

Line 40 (in the returned object):

```typescript
    resumeWindowMs: num('GREPPA_RESUME_WINDOW_MS', 5 * 60 * 1000),
```

- [ ] **Step 4: Update the one consumer**

In `routes/chat.ts`, line 60:

```typescript
      await redis.expire(`msg:${messageId}:meta`, Math.floor(cfg.resumeWindowMs / 1000))
```

- [ ] **Step 5: Update .env.example**

In `.env.example`, replace line 25:

```
GREPPA_RESUME_WINDOW_MS=300000
```

- [ ] **Step 6: Run config + chat-flow tests to verify pass**

Run: `bun test tests/server/config.test.ts tests/server/chat-flow.test.ts`
Expected: PASS (both files).

- [ ] **Step 7: Commit**

```bash
git add lib/config.ts routes/chat.ts .env.example tests/server/config.test.ts
git commit -m "refactor: rename messageTtlMs to resumeWindowMs (5m default)"
```

---

## Task 2: Redis mock pipeline support

The emit dual-write (Task 3) issues `redis.pipeline().zadd(...).expire(...).exec()`. The mock in `_mocks.ts` has no `pipeline`. Add a minimal chainable pipeline that replays onto the existing mock methods, so Task 3's tests can run.

**Files:**
- Modify: `tests/server/_mocks.ts:16-40`

**Interfaces:**
- Produces: `redisMock.pipeline()` returning a chainable object with `zadd`, `expire`, and `async exec()`.

- [ ] **Step 1: Add pipeline to the redis mock**

In `tests/server/_mocks.ts`, inside the `redisMock` object literal, add a `pipeline` method after `incr` (keep the trailing comma correct):

```typescript
  incr: async (k: string) => { fakeRedis[k] = (Number(fakeRedis[k]) || 0) + 1; return fakeRedis[k] },
  pipeline: () => {
    const ops: Array<[string, any[]]> = []
    const api: any = {
      zadd: (...a: any[]) => { ops.push(['zadd', a]); return api },
      expire: (...a: any[]) => { ops.push(['expire', a]); return api },
      exec: async () => {
        const out = []
        for (const [m, a] of ops) out.push(await (redisMock as any)[m](...a))
        return out
      },
    }
    return api
  },
```

- [ ] **Step 2: Verify the mock still type-checks and existing tests pass**

Run: `bun test tests/server/chat-flow.test.ts`
Expected: PASS (no behavior change yet; only an additive mock method).

- [ ] **Step 3: Commit**

```bash
git add tests/server/_mocks.ts
git commit -m "test: add pipeline support to redis mock"
```

---

## Task 3: emit dual-write with seq id

Replace the random per-event ULID with the monotonic `seq` as the event `id`, and dual-write each event to the durable ZSET (ZADD first, then Realtime emit) with the window TTL.

**Files:**
- Modify: `lib/emit.ts` (whole file)
- Modify: `routes/workflows/chat.ts:43-44` (makeEmitter call site only)
- Test: `tests/server/emit.test.ts` (new)

**Interfaces:**
- Consumes: `redisMock.pipeline()` (Task 2); `GreppaConfig.resumeWindowMs` (Task 1).
- Produces: `makeEmitter({ messageId, ttlMs }): (type, data) => Promise<StoredEvent>` where `StoredEvent = { id: string; seq: number; type: EmitType; data: unknown }` and `id === String(seq)`. Durable log key: `msg:<messageId>:events`, ZSET score `seq`, member `JSON.stringify(StoredEvent)`.

- [ ] **Step 1: Write the failing test**

Create `tests/server/emit.test.ts`:

```typescript
import './_mocks'
import { describe, expect, test, beforeEach } from 'bun:test'
import { zsets, clearRedisState, clearRealtimeState, realtimeHistory } from './_mocks'
import { makeEmitter } from '~/lib/emit'

describe('emit durable log', () => {
  beforeEach(() => { clearRedisState(); clearRealtimeState() })

  test('writes events to the ZSET scored by seq with id = String(seq)', async () => {
    const emit = makeEmitter({ messageId: 'm1', ttlMs: 300000 })
    const a = await emit('cue', { status: 'thinking' })
    const b = await emit('token', { token: 'hi' })

    expect(a.seq).toBe(1)
    expect(a.id).toBe('1')
    expect(b.seq).toBe(2)
    expect(b.id).toBe('2')

    const log = (zsets['msg:m1:events'] ?? []).map((e) => JSON.parse(e.member))
    expect(log.map((e) => e.seq)).toEqual([1, 2])
    expect(log.map((e) => e.type)).toEqual(['cue', 'token'])
    expect(zsets['msg:m1:events'].map((e) => e.score)).toEqual([1, 2])
  })

  test('also emits to realtime for live tailing', async () => {
    const emit = makeEmitter({ messageId: 'm2', ttlMs: 300000 })
    await emit('token', { token: 'x' })
    expect(realtimeHistory['m2']?.map((e) => e.event)).toEqual(['msg.token'])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/server/emit.test.ts`
Expected: FAIL — current `makeEmitter` takes no `ttlMs`, ids are ULIDs, nothing written to `zsets`.

- [ ] **Step 3: Rewrite emit.ts**

Replace the entire contents of `lib/emit.ts`:

```typescript
import { redis } from './redis'
import { realtime } from './realtime'
import type { EmitEvent } from './realtime'

export type EmitType = 'cue' | 'sources' | 'token' | 'done' | 'error'

export type StoredEvent = {
  id: string
  seq: number
  type: EmitType
  data: unknown
}

// Each event is durable-before-live: the ZSET write (authoritative replay source)
// happens before the Realtime emit (live transport). If the Realtime emit fails,
// live subscribers miss a frame but every resume replays it from the log. The event
// `id` is the monotonic `seq` rendered as a string, so resumption never depends on
// sub-millisecond ULID ordering. The log TTL is re-anchored on every write so it
// expires `ttlMs` after the last event, not the first.
export function makeEmitter({ messageId, ttlMs }: { messageId: string; ttlMs: number }) {
  const channel = realtime.channel(messageId)
  const eventsKey = `msg:${messageId}:events`
  const ttlSecs = Math.floor(ttlMs / 1000)
  let seq = 0

  return async function emit(type: EmitType, data: unknown): Promise<StoredEvent> {
    seq += 1
    const event: StoredEvent = { id: String(seq), seq, type, data }

    await redis
      .pipeline()
      .zadd(eventsKey, { score: seq, member: JSON.stringify(event) })
      .expire(eventsKey, ttlSecs)
      .exec()

    await channel.emit(`msg.${type}` as EmitEvent, event as any)
    return event
  }
}
```

- [ ] **Step 4: Update the workflow's makeEmitter call site**

In `routes/workflows/chat.ts`, `cfg` is already loaded at line 43. Change line 44:

```typescript
  const emit = makeEmitter({ messageId, ttlMs: cfg.resumeWindowMs })
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test tests/server/emit.test.ts`
Expected: PASS (both tests).

- [ ] **Step 6: Run the broader suite to confirm no regressions**

Run: `bun test tests/server/chat-flow.test.ts tests/server/config.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add lib/emit.ts routes/workflows/chat.ts tests/server/emit.test.ts
git commit -m "feat: dual-write chat events to durable seq-scored log"
```

---

## Task 4: Stream handler resume from seq cursor

Rewrite the stream handler to replay from the durable log with a `seq` cursor, fall back to a full replay for unparseable/stale cursors, tail live events, and bound a stalled stream. Control frames lose their `id`.

**Files:**
- Modify: `routes/chat/stream.ts` (whole file)
- Test: `tests/server/chat-resume.test.ts` (new)

**Interfaces:**
- Consumes: durable log `msg:<id>:events` (Task 3); `GreppaConfig.resumeWindowMs` (Task 1); `redis.zrange(key, 0, -1)` and `realtime.channel(id).subscribe({ history: false })` (existing mocks).
- Produces: SSE stream. Replayed/tailed frames: `id: String(seq)`, `event: <type>`, `data: <json>`. Control frames (`bad_request`, `not_found`, `stalled`): no `id`.

- [ ] **Step 1: Write the failing tests**

Create `tests/server/chat-resume.test.ts`:

```typescript
import './_mocks'
import { describe, expect, test, beforeAll, beforeEach } from 'bun:test'
import { fakeRedis, zsets, clearRedisState, clearRealtimeState } from './_mocks'
import { _resetGreppaConfigForTests } from '~/lib/config'

const SECRET = 'e'.repeat(48)
const { createMockApp } = await import('@bethel-nz/sumi/testing')

function setEnv() {
  process.env.GREPPA_SESSION_SECRET = SECRET
  process.env.GREPPA_PUBLIC_URL = 'http://localhost:3000'
  process.env.DATABASE_URL = 'postgres://postgres:postgres@localhost:5432/greppa'
  process.env.BETTER_AUTH_SECRET = 'test-secret-1234567890123456789012345678'
  process.env.UPSTASH_REDIS_REST_URL = 'http://localhost:1'
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fake'
  delete process.env.GREPPA_RESUME_WINDOW_MS
}

let request: Awaited<ReturnType<typeof createMockApp>>['request']

beforeAll(async () => {
  setEnv()
  ;({ request } = await createMockApp({ routesDir: 'routes', middlewareDir: 'middleware', basePath: '/api/v1' }))
})

beforeEach(() => {
  _resetGreppaConfigForTests()
  setEnv()
  clearRedisState()
  clearRealtimeState()
})

// Seed a durable log. Each event carries a unique token letter so we can assert
// which events were replayed.
function seedLog(sid: string, messageId: string, includeDone = true) {
  fakeRedis[`msg:${messageId}:meta`] = { conversationId: sid, status: includeDone ? 'done' : 'generating' }
  const events = [
    { id: '1', seq: 1, type: 'cue', data: { status: 'thinking' } },
    { id: '2', seq: 2, type: 'token', data: { token: 'AAA' } },
    { id: '3', seq: 3, type: 'token', data: { token: 'BBB' } },
    { id: '4', seq: 4, type: 'token', data: { token: 'CCC' } },
  ]
  if (includeDone) events.push({ id: '5', seq: 5, type: 'done', data: { messageId } } as any)
  zsets[`msg:${messageId}:events`] = events.map((e) => ({ score: e.seq, member: JSON.stringify(e) }))
}

async function stream(sid: string, messageId: string, lastEventId?: string) {
  const headers: Record<string, string> = { 'x-greppa-session': sid }
  if (lastEventId !== undefined) headers['last-event-id'] = lastEventId
  const res = await request(`/chat/stream?messageId=${messageId}`, { method: 'GET', headers })
  return { status: res.status, text: await res.text() }
}

describe('chat stream resume', () => {
  const sid = '01HXXXRESUMEXXXXXXXXXXXXXX1'
  const mid = '01HXXXRMSGXXXXXXXXXXXXXXXX1'

  test('resumes from cursor: replays only events after last-event-id', async () => {
    seedLog(sid, mid)
    const { text } = await stream(sid, mid, '3')
    expect(text).not.toContain('AAA')
    expect(text).not.toContain('BBB')
    expect(text).toContain('CCC')
    expect(text).toContain('id: 4')
    expect(text).toContain('event: done')
  })

  test('no cursor replays the full log and closes on done', async () => {
    seedLog(sid, mid)
    const { text } = await stream(sid, mid)
    expect(text).toContain('AAA')
    expect(text).toContain('CCC')
    expect(text).toContain('event: done')
  })

  test('unparseable (legacy ULID) cursor triggers a full replay', async () => {
    seedLog(sid, mid)
    const { text } = await stream(sid, mid, '01HXXXOLDULIDXXXXXXXXXXXXX1')
    expect(text).toContain('AAA')
    expect(text).toContain('CCC')
  })

  test('stale cursor beyond max seq triggers a full replay', async () => {
    seedLog(sid, mid)
    const { text } = await stream(sid, mid, '99')
    expect(text).toContain('AAA')
    expect(text).toContain('CCC')
  })

  test('not_found for unknown message carries no id', async () => {
    const { text } = await stream(sid, '01HXXXUNKNOWNXXXXXXXXXXXXX1')
    expect(text).toContain('"code":"not_found"')
    expect(text).not.toMatch(/^id: /m)
  })

  test('stalled stream emits a stalled error within the bound', async () => {
    process.env.GREPPA_RESUME_WINDOW_MS = '150'
    _resetGreppaConfigForTests()
    seedLog(sid, mid, false) // no terminal event, no live producer
    const { text } = await stream(sid, mid)
    expect(text).toContain('event: cue')
    expect(text).toContain('"code":"stalled"')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/server/chat-resume.test.ts`
Expected: FAIL — current handler uses ULID cursor comparison, Realtime history replay, and `id` on control frames.

- [ ] **Step 3: Rewrite stream.ts**

Replace the entire contents of `routes/chat/stream.ts`:

```typescript
import { z } from 'zod'
import { createRoute } from '@bethel-nz/sumi/router'
import { redis } from '~/lib/redis'
import { realtime } from '~/lib/realtime'
import { loadGreppaConfig } from '~/lib/config'

const querySchema = z.object({
  messageId: z.string().min(1).describe('The message ID to stream responses for'),
})

type StoredEvent = {
  id: string
  seq: number
  type: 'cue' | 'sources' | 'token' | 'done' | 'error'
  data: unknown
}

const TERMINAL = new Set(['done', 'error'])

export default createRoute({
  get: {
    schema: { query: querySchema },
    middleware: ['session-auth'],
    stream: async (stream, c) => {
      const messageId = c.req.query('messageId')
      if (!messageId) {
        await stream.writeSSE({ event: 'error', data: JSON.stringify({ code: 'bad_request', reason: 'messageId required' }) })
        return
      }

      const conversationId = c.get('conversationId')
      const cfg = loadGreppaConfig()

      const meta = (await redis.hgetall(`msg:${messageId}:meta`)) as
        | { conversationId?: string; status?: string }
        | null

      // One signal for expired / unknown / cross-conversation. Distinguishing them
      // would turn the endpoint into an existence oracle. The client falls back to the
      // conversation history load on not_found.
      if (!meta || meta.conversationId !== conversationId) {
        await stream.writeSSE({ event: 'error', data: JSON.stringify({ code: 'not_found', reason: 'unknown message' }) })
        return
      }

      const eventsKey = `msg:${messageId}:events`
      const cursor = Number.parseInt(c.req.header('last-event-id') ?? '', 10)

      let lastSeq = 0
      let terminated = false

      const forward = async (ev: StoredEvent) => {
        if (terminated || ev.seq <= lastSeq) return
        lastSeq = ev.seq
        await stream.writeSSE({ id: String(ev.seq), event: ev.type, data: JSON.stringify(ev.data) })
        if (TERMINAL.has(ev.type)) terminated = true
      }

      // Subscribe first (buffering) so nothing emitted between snapshot and tail is lost.
      const buffer: StoredEvent[] = []
      let snapshotDone = false
      const channel = realtime.channel(messageId)
      const unsubscribe = await channel.subscribe({
        events: ['msg.cue', 'msg.sources', 'msg.token', 'msg.done', 'msg.error'],
        history: false,
        onData: (envelope: any) => {
          const ev = envelope.data as StoredEvent
          if (!snapshotDone) buffer.push(ev)
          else void forward(ev)
        },
      })

      try {
        // Snapshot the durable log (bounded to one message; a full read is fine).
        const rawLog = (await redis.zrange(eventsKey, 0, -1)) as string[]
        const log: StoredEvent[] = rawLog.map((m) => JSON.parse(m) as StoredEvent)
        const maxSeq = log.length ? log[log.length - 1].seq : 0

        // Unparseable (legacy ULID) or stale (log reset by a retry) cursor -> full replay.
        const effectiveCursor = Number.isFinite(cursor) && cursor <= maxSeq ? cursor : 0

        for (const ev of log) {
          if (ev.seq > effectiveCursor) await forward(ev)
          if (terminated) break
        }

        snapshotDone = true
        for (const ev of buffer) {
          if (terminated) break
          await forward(ev)
        }
        if (terminated) return

        // Tail live events. Close on a terminal event, or on a stalled stream: if no
        // new event arrives within the resume window the workflow died without a
        // terminal frame (QStash retries exhausted), so stop rather than hang.
        let seen = lastSeq
        let lastActivity = Date.now()
        while (!terminated) {
          await new Promise((r) => setTimeout(r, 50))
          if (lastSeq !== seen) {
            seen = lastSeq
            lastActivity = Date.now()
          } else if (Date.now() - lastActivity > cfg.resumeWindowMs) {
            await stream.writeSSE({ event: 'error', data: JSON.stringify({ code: 'stalled', reason: 'stream stalled' }) })
            terminated = true
          }
        }
      } finally {
        unsubscribe()
      }
    },
    openapi: {
      summary: 'Subscribe to a chat message stream',
      description: 'Server-Sent Events stream. Replays the durable event log from the last-event-id seq cursor, then tails new events. Events: cue, sources, token, done, error.',
      tags: ['chat'],
      responses: {
        200: { description: 'SSE stream (text/event-stream)' },
        401: { description: 'Session header required' },
      },
    },
  },
})
```

- [ ] **Step 4: Run the resume tests to verify they pass**

Run: `bun test tests/server/chat-resume.test.ts`
Expected: PASS (all six tests).

- [ ] **Step 5: Run the full server suite to confirm no regressions**

Run: `bun test tests/server/`
Expected: PASS. In particular `chat-flow.test.ts`'s "rejects cross-session access" still passes (still emits `not_found`).

- [ ] **Step 6: Commit**

```bash
git add routes/chat/stream.ts tests/server/chat-resume.test.ts
git commit -m "feat: resume chat stream from durable seq cursor"
```

---

## Task 5: Workflow retry safety and re-anchored meta TTL

Extract the meta-write and run-guard logic into a small testable module, then wire it into the workflow: skip terminal re-runs, reset the log on a fresh attempt, and re-anchor the meta TTL on every write.

**Files:**
- Create: `lib/chat/lifecycle.ts`
- Modify: `routes/workflows/chat.ts` (guard at top; replace the three `redis.hset(msg:meta, ...)` writes)
- Test: `tests/server/chat-lifecycle.test.ts` (new)

**Interfaces:**
- Consumes: `redis` (`hgetall`, `del`, `hset`, `expire`); `GreppaConfig.resumeWindowMs`.
- Produces:
  - `beginRun({ messageId, ttlMs }): Promise<{ skip: boolean }>` — returns `{ skip: true }` if `msg:<id>:meta` status is `done` or `error`; otherwise deletes `msg:<id>:events` and returns `{ skip: false }`.
  - `setMeta({ messageId, ttlMs, fields }): Promise<void>` — `hset` the meta hash and re-anchor its TTL to `ttlMs`.

- [ ] **Step 1: Write the failing test**

Create `tests/server/chat-lifecycle.test.ts`:

```typescript
import './_mocks'
import { describe, expect, test, beforeEach } from 'bun:test'
import { fakeRedis, zsets, clearRedisState } from './_mocks'
import { beginRun, setMeta } from '~/lib/chat/lifecycle'

describe('chat lifecycle', () => {
  beforeEach(() => clearRedisState())

  test('beginRun skips when meta status is terminal', async () => {
    fakeRedis['msg:m1:meta'] = { conversationId: 's', status: 'done' }
    zsets['msg:m1:events'] = [{ score: 1, member: '{}' }]
    const { skip } = await beginRun({ messageId: 'm1', ttlMs: 300000 })
    expect(skip).toBe(true)
    // A terminal re-run must not wipe the completed log.
    expect(zsets['msg:m1:events']).toBeDefined()
  })

  test('beginRun resets the events log on a fresh (non-terminal) run', async () => {
    fakeRedis['msg:m2:meta'] = { conversationId: 's', status: 'queued' }
    zsets['msg:m2:events'] = [{ score: 1, member: '{"seq":1}' }]
    const { skip } = await beginRun({ messageId: 'm2', ttlMs: 300000 })
    expect(skip).toBe(false)
    expect(zsets['msg:m2:events']).toBeUndefined()
  })

  test('beginRun proceeds when there is no meta yet', async () => {
    const { skip } = await beginRun({ messageId: 'm3', ttlMs: 300000 })
    expect(skip).toBe(false)
  })

  test('setMeta merges fields into the meta hash', async () => {
    fakeRedis['msg:m4:meta'] = { conversationId: 's', status: 'queued' }
    await setMeta({ messageId: 'm4', ttlMs: 300000, fields: { status: 'done', finishedAt: 123 } })
    expect(fakeRedis['msg:m4:meta']).toMatchObject({ conversationId: 's', status: 'done', finishedAt: 123 })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/server/chat-lifecycle.test.ts`
Expected: FAIL — `~/lib/chat/lifecycle` does not exist.

- [ ] **Step 3: Create lifecycle.ts**

Create `lib/chat/lifecycle.ts`:

```typescript
import { redis } from '~/lib/redis'

const TERMINAL_STATUS = new Set(['done', 'error'])

// Guards a workflow run against QStash redelivery. If the message already reached a
// terminal status, the run is a duplicate and must no-op (leaving the completed log
// intact). Otherwise it is a fresh attempt, so the events log is reset to a clean
// slate before this attempt starts streaming.
export async function beginRun({ messageId, ttlMs }: { messageId: string; ttlMs: number }): Promise<{ skip: boolean }> {
  const meta = (await redis.hgetall(`msg:${messageId}:meta`)) as { status?: string } | null
  if (meta?.status && TERMINAL_STATUS.has(meta.status)) return { skip: true }
  await redis.del(`msg:${messageId}:events`)
  await redis.expire(`msg:${messageId}:meta`, Math.floor(ttlMs / 1000))
  return { skip: false }
}

// Writes meta fields and re-anchors the meta TTL to ttlMs on every write, so the
// resume gate expires ttlMs after the last activity rather than at enqueue time.
export async function setMeta({
  messageId,
  ttlMs,
  fields,
}: {
  messageId: string
  ttlMs: number
  fields: Record<string, string | number>
}): Promise<void> {
  await redis.hset(`msg:${messageId}:meta`, fields)
  await redis.expire(`msg:${messageId}:meta`, Math.floor(ttlMs / 1000))
}
```

- [ ] **Step 4: Run the lifecycle test to verify it passes**

Run: `bun test tests/server/chat-lifecycle.test.ts`
Expected: PASS (all four tests).

- [ ] **Step 5: Wire the guard and setMeta into the workflow**

In `routes/workflows/chat.ts`:

Add to the imports near line 10:

```typescript
import { beginRun, setMeta } from '~/lib/chat/lifecycle'
```

After `const emit = makeEmitter({ messageId, ttlMs: cfg.resumeWindowMs })` (the `cfg`/`emit` setup block, ~line 44), add the guard before the first `emit('cue', ...)`:

```typescript
  const { skip } = await beginRun({ messageId, ttlMs: cfg.resumeWindowMs })
  if (skip) return
```

Replace the injection-blocked meta write (currently `await redis.hset(\`msg:${messageId}:meta\`, { status: 'error', finishedAt: Date.now() })`):

```typescript
    await setMeta({ messageId, ttlMs: cfg.resumeWindowMs, fields: { status: 'error', finishedAt: Date.now() } })
```

Replace the generation-failed meta write (the identical `hset` in the `catch`):

```typescript
    await setMeta({ messageId, ttlMs: cfg.resumeWindowMs, fields: { status: 'error', finishedAt: Date.now() } })
```

Replace the success meta write (currently `await redis.hset(\`msg:${messageId}:meta\`, { status: 'done', finishedAt })`):

```typescript
  await setMeta({ messageId, ttlMs: cfg.resumeWindowMs, fields: { status: 'done', finishedAt } })
```

If `redis` is now unused in `routes/workflows/chat.ts`, keep its import only if the `history:` ZADD/expire at lines 141-142 still uses it (it does) — leave that import in place.

- [ ] **Step 6: Run the full suite to confirm the wiring type-checks and nothing regressed**

Run: `bun test tests/server/`
Expected: PASS (all files, including `chat-flow.test.ts` and `chat-resume.test.ts`).

- [ ] **Step 7: Commit**

```bash
git add lib/chat/lifecycle.ts routes/workflows/chat.ts tests/server/chat-lifecycle.test.ts
git commit -m "feat: guard chat workflow retries and re-anchor meta ttl"
```

---

## Task 6: Align Realtime retention

Realtime history no longer has a reader (the stream handler subscribes with `history: false` and replays from the ZSET). Drop its retention to a small transport buffer so tokens are not stored twice for the full window.

**Files:**
- Modify: `lib/realtime.ts:28`

- [ ] **Step 1: Reduce the retention window**

In `lib/realtime.ts`, line 28:

```typescript
    history: { expireAfterSecs: 60 },
```

- [ ] **Step 2: Run the suite to confirm nothing depended on the old window**

Run: `bun test tests/server/`
Expected: PASS. (The stream handler uses `history: false`; the mock ignores retention. This is a production-config change with no test dependency, so a green suite confirms no code path read the old value.)

- [ ] **Step 3: Commit**

```bash
git add lib/realtime.ts
git commit -m "chore: shrink realtime history to a live-tail buffer"
```

---

## Self-Review

**Spec coverage:**
- Resume window knob (default 5m) — Task 1.
- Durable event log, ZADD-first, seq-scored, window TTL, re-anchored on write — Task 3.
- Swap ULID for `String(seq)` id + seq cursor — Tasks 3 (id) and 4 (cursor parse).
- Control frames carry no id — Task 4.
- Minimize Realtime retention (60s) — Task 6.
- Meta TTL to window, re-anchored on every write — Tasks 1 (enqueue) and 5 (`setMeta`).
- Subscribe-then-snapshot, seq dedupe, stalled bound — Task 4.
- One `not_found` signal for expired/unknown/mismatch — Task 4 (test asserts identical `not_found`, no id).
- Retry no-op guard + log reset on fresh attempt — Task 5.
- Stale/unparseable cursor -> full replay — Task 4.
- Tests enumerated in the spec's Testing section map to Task 4 (resume, full replay, legacy cursor, stale cursor, not_found, stalled) and Task 5 (retry no-op via `beginRun`); the sub-ms ordering regression is covered structurally by using `seq` scores in Task 3's test.

**Placeholder scan:** No TBD/TODO; every code and test step contains complete content.

**Type consistency:** `StoredEvent` shape (`{ id: string; seq: number; type; data }`) is identical in `lib/emit.ts` and `routes/chat/stream.ts`. `makeEmitter({ messageId, ttlMs })`, `beginRun({ messageId, ttlMs })`, and `setMeta({ messageId, ttlMs, fields })` signatures are consistent between their definitions and call sites. `resumeWindowMs` is used identically across config, chat.ts, stream.ts, emit call, and lifecycle calls.
