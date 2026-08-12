---

## 4. From Toy Implementation to Production

### Stage 1 — Proof of concept

**Shape:** single Python script, one model, 2–5 tools, in-memory history.

**Abstractions you do *not* need yet:** multi-tenant ACL, durable workflows, complex memory.

**You still need:** typed tool schemas, basic timeouts, printed traces. Skipping schemas at PoC teaches the wrong lessons.

**Risk:** demo success hides non-determinism and cost.

### Stage 2 — Small application

**Add:**

- Persisted threads (Postgres/SQLite messages)
- User auth
- Simple memory (preferences key-value)
- Structured final answers
- Token/cost counters per request
- Idempotency for the 1–2 write tools you have

**Why:** multi-user concurrency appears; “it worked on my machine” dies.

### Stage 3 — Production system

**Abstractions that become necessary:**

| Concern | Why now |
| --- | --- |
| **Concurrency** | many runs; tool backends rate-limit |
| **Persistence** | customers expect resume after refresh/crash |
| **Idempotency** | retries double-charge / double-ticket |
| **Retries + timeouts** | dependency flakiness |
| **Partial failure** | parallel tools, multi-agent |
| **Backpressure** | queue depth when models/tools slow |
| **Consistency** | memory writes vs conversation order |
| **Caching** | embeddings, tool catalogs, repeated retrieval |
| **Observability** | traces spanning model↔tools; privacy-safe |
| **Security** | tool sandboxing, secret redaction, prompt injection via tool results |
| **Multi-tenancy** | memory/tool scope isolation |
| **Cost controls** | per-tenant budgets, model routing |
| **Graceful degradation** | smaller model / fewer tools / read-only mode |
| **Recovery** | checkpoint + rehydrate |

**Anthropic production lessons that appear here:**

- Rainbow deployments so in-flight agents aren’t broken by prompt/tool version swaps
- Agents are stateful; errors compound—resume, don’t always restart
- Let the model adapt to tool failure messages *and* keep deterministic safeguards

### Stage 4 — High-scale / mission-critical

**Add:**

- Durable execution for multi-hour runs
- Hard isolation (per-tenant compute for browser/code tools)
- Formal evaluation gates in CI for prompt/tool changes
- Human approval workflows that wait days cheaply
- Multi-region failover of runtimes
- Capacity planning for 4×–15× token multipliers
- Red-team for tool-result injection and confused-deputy attacks
- SLO-based autoscaling of workers (not just HTTP pods)

**Browser/infra agents** jump to stage 4 concerns earlier because side effects are real.

### Mapping concerns to agent subsystems

```
Context assembler  → caching, budgets, redaction
Memory service     → tenancy, conflict, retention
Tool runtime       → authz, idempotency, timeouts, sandbox
Orchestrator       → backpressure, fan-out limits
Durable runner     → checkpoints, resume, timers
Eval/observability → regression gates, traces
```
