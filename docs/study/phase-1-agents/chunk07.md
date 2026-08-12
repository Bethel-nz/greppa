---

## 6. Architecture Patterns

### Pattern A — Single-agent tool loop

```
Client → API Gateway → Agent Runtime ──► LLM API
                           │
                           ├── Tool Runtime (HTTP/DB/Browser)
                           ├── Context Assembler
                           └── Trace Store
```

**State ownership:** runtime owns message list; tools own external state.
**Failure boundary:** tool timeouts isolated; model call retried carefully.
**Scaling:** horizontal runtimes with sticky run IDs or externalized state.
**Choose when:** most products should start here (Anthropic: simple composable patterns win).

### Pattern B — Context + memory services

```
                ┌─ Memory Service (semantic/episodic)
Agent Runtime ──┼─ Retrieval Service
                └─ Artifact Store (S3)
```

**State ownership:** memory service is source of truth for durable facts; runtime is ephemeral.
**Failure boundary:** degraded mode = no memory write/read, still answer with session context.
**Scaling:** independent scaling of embedding/index workers.
**Choose when:** multi-session personalization or multi-tenant knowledge.

### Pattern C — Orchestrator-worker multi-agent (Anthropic Research)

```
User → Lead Agent (plan + memory of plan)
           │ spawns
           ├─ Worker A (clean context, tools)
           ├─ Worker B
           └─ Worker C
           │ returns summaries + artifact refs
           v
      Synthesis → Citation Agent → User
```

**State ownership:** lead owns plan; workers own local exploration; artifacts externalized.
**Failure boundary:** worker failure shouldn’t kill lead; lead replans.
**Scaling:** parallel workers; token cost ×N; sync vs async trade-off.
**Choose when:** high-value breadth-first research; not every chat query.

### Pattern D — Durable long-horizon runner

```
API → Workflow Engine (Temporal/etc)
         │ activities
         ├─ LLM step activity
         ├─ Tool activity (idempotent)
         ├─ Human approval (wait)
         └─ Memory write activity
```

**State ownership:** workflow event history is execution truth; business DBs for domain state.
**Failure boundary:** activities retry with policies; workflows continue after worker death.
**Scaling:** task queues, worker pools per activity type (browser pool ≠ LLM pool).
**Choose when:** hours/days, human waits, money/infra side effects.

### Pattern E — Browser agent isolation

```
Agent → Browser Orchestrator → Pooled headless browsers
                │
                ├─ Session store (encrypted cookies)
                ├─ Snapshot service (a11y/screenshot)
                └─ Network egress policy
```

**State ownership:** browser session per run/user; never share cookies across tenants.
**Failure boundary:** kill browser on runaway; don’t trust page content as instructions.
**Scaling:** browsers are the bottleneck (CPU/RAM), not the LLM.
**Choose when:** web UIs without APIs; RPA replacement with evaluation harness.

### Pattern F — Infrastructure agent with approval gates

```
Agent Planner → Diff/Dry-run Tool → Policy Engine → (auto | human queue) → Mutating Tool → Audit Log
```

**State ownership:** IaC/state backend remains source of truth; agent never “owns” cluster state alone.
**Failure boundary:** mutating path isolated; read tools broader.
**Scaling:** low QPS, high criticality—optimize safety over throughput.
**Choose when:** ops automation with compliance.

### Pattern G — Handoff multi-agent (OpenAI-style)

```
Triage Agent --handoff contract--> Specialist Agent --handoff--> Closer
                     shared: conversation id, user goals, tool results refs
```

**State ownership:** shared thread store; each agent has different tool permissions.
**Failure boundary:** handoff validation fails closed.
**Choose when:** domain specialization with different tool sets (support, sales).
