# 9. From Toy to Production, Failure Modes, Architecture Patterns

This file consolidates the systems progression that applies across all Phase 1 topics.

---

## 9.1 Stage progression

### Stage 1 — Proof of concept

**Shape:** one script, one model, few tools, in-memory history.

**Still required:** typed tool args, basic timeouts, printable traces.
If you skip schemas at PoC, you learn the wrong lesson (“it works!”) and pay later.

**Non-goals:** multi-tenant ACLs, durable workflows, elaborate memory.

### Stage 2 — Small application

Add:

- persisted threads;
- authn;
- simple preferences memory;
- cost counters;
- idempotency on the first write tools;
- a golden set of 20 tasks.

### Stage 3 — Production

Now these are real:

| Concern | Why agents force it |
| --- | --- |
| Concurrency | overlapping runs, rate limits |
| Persistence | users refresh mid-run; workers die |
| Idempotency | retries + unknown outcomes |
| Timeouts / retries | flaky tools |
| Partial failure | parallel tools/workers |
| Backpressure | queues when models slow |
| Consistency | memory write vs reply order |
| Caching | embeddings, schemas, retrieval |
| Observability | model↔tool traces, privacy |
| Security | injection via tools, secret redaction, sandbox |
| Multi-tenancy | memory and session isolation |
| Cost controls | 4×–15× token multipliers |
| Graceful degradation | read-only mode, smaller model, fewer workers |
| Deploy safety | rainbow deploys for in-flight runs |

### Stage 4 — High-scale / mission-critical

- durable execution for multi-hour work;
- hard isolation for code/browser execution;
- CI eval gates on prompt/tool changes;
- formal SLOs (success, latency, cost, safety incidents);
- multi-region considerations for runtimes and artifact stores;
- red-team for tool-result injection and confused deputy.

Browser/infra agents jump to Stage 4 concerns earlier because mistakes leave marks in the real world.

---

## 9.2 Failure modes catalog (cross-cutting)

Study each as: what / why / symptoms / diagnose / mitigate.

### F1 Context rot / mid-task collapse
**What:** later turns ignore goals; loops.
**Why:** low-signal tool dumps dominate attention.
**Symptoms:** tokens/turn↑, repeated searches, instruction misses.
**Diagnose:** section token histograms; ablations.
**Mitigate:** clearing, compaction, section budgets, subagents.

### F2 Retrieval pollution
**What:** confident wrong answers from junk sources.
**Why:** similarity ≠ authority (Anthropic Research human eval saw SEO farm bias).
**Mitigate:** source quality heuristics, allowlists, rerankers.

### F3 Stale or wrong memory
**What:** outdated facts drive action.
**Why:** no invalidation; bad conflicts; scope bugs.
**Mitigate:** TTLs, provenance, human gates, authz tests.

### F4 Tool ambiguity
**What:** wrong tool thrash.
**Why:** overlapping tools / bad descriptions.
**Mitigate:** minimal registries; rewrite descriptions from traces.

### F5 Double side effects
**What:** duplicate refunds/tickets.
**Why:** retry after unknown timeout without idempotency.
**Mitigate:** effect tables, idempotency keys.

### F6 Checkpoint without resume
**What:** state saved, run dead.
**Why:** checkpoint ≠ durable execution.
**Mitigate:** workers + leases or workflow engine; alerts on stuck runs.

### F7 Spawn storms / duplicate workers
**What:** cost explosion; redundant work.
**Why:** vague delegation; no effort scaling.
**Mitigate:** structured briefs; max width by complexity class.

### F8 Telephone summarization loss
**What:** lead drops worker details.
**Why:** NL-only returns.
**Mitigate:** artifacts + refs; citation pass.

### F9 Tool-result / web injection
**What:** untrusted content steers policy.
**Why:** data concatenated as instructions.
**Mitigate:** delimiters, allowlists, dual-channel designs, no secrets in context.

### F10 Browser drift / modal traps
**What:** flaky automation.
**Why:** CSS selectors; no recovery.
**Mitigate:** a11y locators; reset policies; site-versioned evals.

### F11 Partial success treated as full
**What:** incomplete data shipped as complete.
**Why:** host aggregation lies.
**Mitigate:** per-item status schemas; force replan on partials.

### F12 Deploy breaks in-flight agents
**What:** sudden error spike after release.
**Why:** schema/prompt version skew mid-run.
**Mitigate:** pin versions per run; rainbow deploys.

### F13 Cost runaway
**What:** bill shock.
**Why:** unbounded loops, fat payloads, multi-agent overuse.
**Mitigate:** hard budgets; circuit breakers; CPS dashboards.

---

## 9.3 Architecture patterns (expanded)

### Pattern A — Single-agent tool loop
Best default. Clear state ownership in runtime. Scale by externalizing checkpoints.

### Pattern B — Context + memory services
Split read models: assembler, memory, retrieval, artifacts. Degrade when memory down.

### Pattern C — Orchestrator-worker research
Anthropic Research shape. Artifact store mandatory. Budget fan-out. Citation stage optional but valuable.

### Pattern D — Durable long-horizon runner
Workflow engine owns control flow; activities wrap LLM/tool/human. Use for money/infra/day-long jobs.

### Pattern E — Browser isolation pool
Per-tenant contexts; separate autoscaling; egress controls; snapshot service.

### Pattern F — Infra agent with approval gate
Read-heavy tools open; mutators behind policy + human; audit is first-class.

### Pattern G — Handoff specialists
Support/billing/legal different tool sets; validated handoff contracts; shared thread store.

```
                    ┌──────────────┐
 User ──► API ──► │ Run Manager  │──► durable queue / workflow
                    └──────┬───────┘
           ┌───────────────┼────────────────┐
           v               v                v
      Agent runtime   Memory svc      Browser/tool pools
           │               │                │
           └──────────► Artifact + Trace stores
```

Choose patterns by **side-effect risk**, **parallelism**, and **duration**—not by blog hype.

Next: `10_evaluation_and_implementation.md`.
