# Greppa SDK + Resumable Protocol Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor the Greppa server to a Redis-backed resumable chat protocol (Upstash Redis + Realtime + Workflow) and ship a typed TypeScript SDK (`@greppa/sdk`) that works in browser and server with scope-based session namespacing, async iterables for tokens/cues/sources, and HMAC-signed sessions. Support for "Highlight Context" via optional `context` object in `/chat` requests.

**Architecture:** `POST /chat` enqueues an Upstash Workflow that runs the Groq+memvid pipeline and emits typed events to a per-message Redis ZSET (durable replay) and a Realtime channel (live tail). `GET /chat/stream?messageId=` replays the ZSET and tails the channel — resume is `last-event-id` + replay-from-index. Browser sessions are HMAC-signed ULIDs in `sessionStorage`, namespaced by an SDK-side scope string. Conversation history lives in `history:<sessionId>` with a sliding 2-day TTL.

**Tech Stack:** Bun, Sumi (file-based Hono framework), Upstash Redis + Realtime + Workflow, Groq, memvid, Zod v4, ULID. SDK is zero-dep TypeScript with React peer-dep for the `/react` entry. Tests with `bun test`.

**Spec:** `docs/superpowers/specs/2026-04-25-greppa-sdk-and-protocol-design.md`

---

## Task 0: Workspace + new dependencies (DONE)
## Task 1: `lib/config.ts` — typed greppa config (DONE)
## Task 2: `lib/hmac.ts` — sign/verify sessionId (DONE)
## Task 3: `lib/security.ts` — extract injection patterns + scan retrieved snippets (DONE)
## Task 4: `lib/redis.ts`, `lib/realtime.ts`, `lib/workflow.ts` — Upstash clients (DONE)
## Task 5: `lib/emit.ts` — dual-write emitter (DONE)
## Task 6: `middleware/session-auth.ts` + `middleware/deployer-auth.ts` (DONE)
## Task 7: Replace `middleware/rate-limit.ts` with Redis-backed limiter (DONE)
## Task 8: `middleware/_index.ts` — CORS allowlist + logging (DONE)
## Task 9: `routes/session.ts` — POST /session, DELETE /session (DONE)
## Task 10: `routes/workflows/chat.ts` — Upstash Workflow chat generator (DONE)
## Task 11: Replace `routes/chat.ts` + add `routes/chat/stream.ts` + `routes/chat/history.ts` (DONE)
## Task 12: Knowledge + stats route auth wiring (DONE)
## Task 13: Server integration test — chat happy path (DONE)
## Task 14: SDK skeleton — `packages/sdk/src/types.ts` (DONE)
## Task 15: SDK transport — `packages/sdk/src/transport.ts` (DONE)
## Task 16: SDK session adapters (DONE)
## Task 17: SDK chat namespace + ChatHandle (DONE)
## Task 18: SDK knowledge + stats (DONE)
## Task 19: SDK React entry — `useChat`, `useKnowledge`, `GreppaProvider` (DONE)

---

## Task 20: Theming & Visual Surface (NEW)

**Goal:** Implement the CSS variable surface and the logic for injecting scoped styles into the page.

- [ ] **Step 1: Create `packages/sdk/src/react/theme.ts`**
  - Define `GreppaTheme` type.
  - Add `generateCssVars` helper.
  - Add default theme constants.
- [ ] **Step 2: Create `packages/sdk/src/react/theme.css`**
  - Define the base CSS variable surface (`--greppa-*`).
  - Add dark mode support via `[data-theme="dark"]`.
  - Add reduced-motion and mobile media queries.
- [ ] **Step 3: Update `GreppaProvider` in `packages/sdk/src/react/index.tsx`**
  - Add `theme` and `instanceId` props.
  - Inject a `<style>` block scoped by `data-greppa-root`.
  - Update context to include theme state.
- [ ] **Step 4: Verify style injection in a smoke test**

---

## Task 21: Final Integration & Verification

- [ ] **Step 1: Run all tests (Server + SDK)**
- [ ] **Step 2: Final README update with theming documentation**
- [ ] **Step 3: Commit all server changes**
- [ ] **Step 4: Verify SDK files are ready for separate repo**
