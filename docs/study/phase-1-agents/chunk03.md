### 2.3 Tool-calling agents

#### Definition

A **tool-calling agent** is a model that, under a schema-defined tool surface, emits structured tool invocations; a host runtime executes them and returns observations into the next context.

Anthropic’s compact definition: **LLMs autonomously using tools in a loop**.

#### Tool schema as ACI (agent–computer interface)

Anthropic’s production lesson: invest in tools like HCI.

- Clear names, non-overlapping responsibilities
- Parameters that are hard to misuse (absolute paths over relative; enums over free strings)
- Descriptions that encode when *not* to use the tool
- Token-efficient return payloads (summaries + pointers, not 50k-token dumps)

Their multi-agent research team used Claude to **rewrite bad MCP tool descriptions** after observing failures—about **40% faster task completion** after better descriptions.

#### Selection and discovery

- Static tool list in the API request (common)
- Dynamic discovery (MCP registries, skill catalogs)
- Routing: only expose tools relevant to the current mode

Bloated tool sets create **ambiguous decision points**—if a human engineer can’t pick the tool, the model won’t either.

#### Execution semantics

| Mode | Behavior | Use when |
| --- | --- | --- |
| Sequential | one tool, wait, observe | dependencies |
| Parallel | multiple independent calls | I/O-bound research (Anthropic cut research time up to ~90% with parallel tools + subagents) |
| Batched programmatic | host code loops; model doesn’t see every intermediate | large data without flooding context |

#### Reliability primitives

- **Validation:** schema-validate args *before* side effects.
- **Timeouts:** per-tool and per-run budgets.
- **Retries:** only on idempotent / safely-retryable errors; exponential backoff + jitter.
- **Idempotency keys:** for payments, ticket creates, deploys.
- **Partial failure:** N parallel tools → some fail; return structured per-call status.
- **Permissions:** capability tokens, least privilege, human approval for irreversible actions.

#### Observability

Log: tool name, args (redacted), latency, status, bytes returned, token impact, correlation IDs. Anthropic’s Research debugging required **full production tracing** of decision patterns—“agent didn’t find obvious info” is undiagnosable without traces.

### 2.4 Structured / typed agents

#### Stack of constraints (often confused)

1. **JSON mode** — valid JSON syntax; schema not enforced.
2. **Function/tool calling** — named calls + JSON args.
3. **Structured outputs / constrained decoding** — generation masked to match a JSON Schema (OpenAI Structured Outputs; libraries like Outlines).
4. **Application validation** — Pydantic/Zod + business rules after parse.
5. **Repair loops** — on validation failure, re-prompt with errors (or deterministic fixers).

#### Why it exists

Agents are only production-safe if **boundaries are typed**: tool args, handoff contracts, plan nodes, approval payloads. Free-form text is a human interface, not a reliable machine interface.

#### Schema design principles

- Prefer enums and closed sets over open strings for control flow.
- Separate *user-facing prose* from *machine actions*.
- Version schemas (`plan.v2`); dual-read during rollout.
- Avoid formats that force awkward tokenizations (Anthropic’s SWE-bench lesson: diffs/line counts and JSON-escaped code are harder than natural formats).

#### Streaming structured data

- Stream prose; buffer structured final
- Stream NDJSON events with typed envelopes
- Incremental schema-aware parsers with safe incomplete states

#### Schema evolution

Treat agent schemas like public APIs: additive changes first, deprecation windows, contract tests between orchestrator and workers.

### 2.5 Long-horizon agents

#### Problem

Tasks exceed one context window and one process lifetime: migrations, multi-day research, infrastructure change programs.

#### Planning structures

- **Goal decomposition:** goal → milestones → tasks → tool actions
- **DAG planning:** tasks with dependencies; parallelize independent nodes
- **Hierarchical planning:** high-level plan stable; low-level replan often
- **Plan mutation:** observe → revise DAG (don’t freeze a wrong plan)

#### Durability theory: checkpoint ≠ durable execution

| Concept | What is saved | Survives process death? | Re-entry |
| --- | --- | --- | --- |
| **Checkpoint** (e.g. LangGraph checkpointer) | Graph/agent *state snapshot* | State yes; *run* only if something restarts it | App/orchestrator must resume |
| **Durable execution** (e.g. Temporal) | Event history + workflow progress | Yes—runtime resumes automatically | Built-in |

Temporal’s engineering point: checkpoints are durable *data*, not automatically durable *execution*. Production still needs orchestration for restarts, timers, human waits, and worker failover.

Also: checkpointers typically save state *between* nodes, not *inside* a long node loop. A crash mid-node loses intermediate work unless you design finer-grained activities.

#### Idempotency and replay

On resume, steps may re-execute. Side-effecting tools must be **idempotent** or guarded by durable “already done” markers. Nondeterministic LLM calls must be recorded so replay doesn’t diverge.

### 2.6 Multi-agent systems

#### When multi-agent is real, not theater

Anthropic Research: multi-agent helped most on **breadth-first, parallelizable** tasks; coding often has fewer independent subproblems. Multi-agent with Opus lead + Sonnet workers beat single Opus by **~90%** on their internal research eval—at large token cost.

#### Core patterns

1. **Coordinator / worker (orchestrator-workers)** — lead plans, spawns specialists, synthesizes.
2. **Supervisor / subagent** — subagents only report up.
3. **Agent teams** — peers share task list and message each other.
4. **Fan-out / fan-in** — parallel map, then reduce.
5. **Handoff** — ownership transfer with a contract (OpenAI Agents SDK style).

#### Coordination theory

- **Shared state:** single-writer lead vs locks vs CRDTs
- **Message passing:** async queues vs sync RPC (Anthropic Research used sync subagents early—simpler, bottlenecks)
- **Task ownership:** exactly-one worker claims a task (lease/heartbeat)
- **Quorums / voting:** high-stakes judgments
- **Failure propagation:** child fail → parent retry, replan, or degrade
- **Circuit breakers:** stop spawning if tool ecosystem is down
- **Telephone problem:** subagent → lead summarization loses detail; fix with **artifacts in object store + pass references** (Anthropic appendix)

#### Boundary tracing

Trace IDs must span: user request → lead → children → tools → memory writes.

### 2.7 Autonomous infrastructure agents

#### Loop

```
plan → act → observe → reflect → (replan | stop)
```

Same generic loop, but **actions mutate production systems**.

#### Safe side effects

- **Capability model:** tools map to least-privilege IAM roles
- **Dry-run / diff first:** terraform plan, kubectl diff, SQL EXPLAIN
- **Blast radius limits:** max resources touched per step
- **Rollbacks:** reverse ops or snapshots per mutation class
- **Human approval boundaries:** irreversible / high-cost / compliance-sensitive
- **Auditability:** append-only log of intent, args, result, actor (agent version + model)

Guardrails are not only content filters—they are **control-plane policy** around the actuator.

### 2.8 Browser agents

#### Observation modalities

| Observation | Token cost | Robustness | Failure mode |
| --- | --- | --- | --- |
| Raw DOM/HTML | high | brittle | noise, scripts |
| **Accessibility tree** | low–med | often best | incomplete a11y |
| Screenshots / computer-use | high | flexible for novel UIs | coordinate hallucination, cost |
| Hybrid | med | production sweet spot | complex harness |

Emerging production consensus: **structured text (a11y) first, vision fallback**. Screenshots are compelling demos; economics and pixel→action mapping hurt reliability.

#### Control architecture

```
Agent ──tool calls──► Browser controller (Playwright/CDP)
                          │
                          ├─ session (cookies, storage, tabs)
                          ├─ navigation state
                          └─ snapshots (a11y / screenshot)
```

#### Hard problems

- **Selector drift:** prefer role/name from a11y over CSS/XPath
- **Dynamic DOMs:** wait strategies, network idle, mutation observers
- **Auth:** cookie jars, SSO, secret injection without leaking into prompts
- **Captchas / bot defense:** often human or specialized services
- **Long-running tasks:** session persistence, tab explosions, modal traps
- **Evaluation:** success rate, steps-to-success, flaky rate across site versions
