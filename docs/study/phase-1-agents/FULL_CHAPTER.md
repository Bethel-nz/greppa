# Phase 1 — Agents: How Intelligent Systems Actually Operate

**Study chapter · AI Engineering curriculum**
**Scope:** Context engineering · persistent memory · tool-calling · structured agents · long-horizon planning · multi-agent systems · infrastructure agents · browser agents
**Level:** Production engineering depth (not beginner, not interview prep)

---

## Primary sources (production systems)

This chapter is grounded in what companies building agents have published about production systems, not only framework tutorials:

- **Anthropic** — *Effective context engineering for AI agents* (2025): context as finite resource, compaction, note-taking, sub-agents
- **Anthropic** — *Building effective agents* (2024): workflows vs agents, composable patterns, tool ACI
- **Anthropic** — *How we built our multi-agent research system* (2025): orchestrator-worker at scale, token economics, evaluation
- **Anthropic** — Claude Code / context management cookbook: compaction, tool-result clearing, memory tools
- **OpenAI** — *A practical guide to building agents* + Agents SDK: orchestration, guardrails, multi-agent handoffs
- **OpenAI** — Structured Outputs / function calling docs: schema-constrained generation vs JSON mode
- **LangChain / LangGraph** — checkpointers, BaseStore, short-term vs long-term memory
- **Temporal** engineering writing — checkpoints vs durable execution; crash recovery for long-running agents
- Browser automation engineering literature (Playwright/CDP, accessibility trees, computer-use trade-offs)

Treat these as primary literature. Framework docs are secondary; they abstract mechanisms this chapter makes explicit.

---

## 1. Mental Model

### 1.1 The fundamental problem

An LLM is a **stateless next-token predictor** conditioned on a finite sequence of tokens called the **context**. Production agents exist because real work is not one-shot generation:

1. Goals span many steps (hours or days, not one completion).
2. Ground truth lives outside the model (APIs, databases, browsers, infrastructure).
3. Side effects must be safe, auditable, and recoverable.
4. Token windows fill, rot, and get expensive.
5. Partial failure is the normal case, not the exception.

The core engineering problem:

> **Given a goal, continuously assemble the highest-utility finite context, decide which tools to invoke, apply side effects safely, persist what must survive the next turn (or crash), and stop when done—under cost, latency, and reliability constraints.**

Everything in Phase 1 is a special case of that sentence.

### 1.2 Agent vs workflow (terminology industry overloads)

Anthropic’s distinction (widely adopted, often misused):

| Term | Control flow | Who decides the next step |
| --- | --- | --- |
| **Workflow** | Predefined graph / code path | Engineer + maybe a classifier |
| **Agent** | Dynamic loop | Model chooses tools/plan based on observations |
| **Agentic system** | Either or hybrid | Umbrella term |

Industry sloppiness to watch for:

- **"Agent"** used for a single tool-calling chat turn.
- **"Multi-agent"** used for two sequential prompts with no coordination protocol.
- **"Memory"** used for (a) conversation history, (b) vector RAG, (c) durable fact store, (d) checkpointed workflow state—four different systems.
- **"Context"** used for prompt text, product feature "context windows," and retrieval corpora.

When reading production posts, map each term to: *where does state live, who owns the control loop, what survives a process crash?*

### 1.3 The agent loop as a control system

```
                 ┌──────────────────────────────────────┐
                 │           Durable runtime            │
                 │  (checkpoint / workflow / queue)     │
                 └───────────────┬──────────────────────┘
                                 │ resume state
                                 v
Goal ──► Assemble context ──► Model step ──► Parse structured intent
              ▲                     │
              │                     ├─ final answer ──► done
              │                     │
              │                     └─ tool call(s) ──► execute
              │                                            │
              │                     observe / validate ◄───┘
              │                            │
              └──── write memory / logs ◄──┘
```

This is closer to a **closed-loop controller** than to a chatbot:

- **Actuators:** tools (APIs, shell, browser, infra).
- **Sensors:** tool results, logs, DOM/a11y snapshots, metrics.
- **Controller:** the model + your policies (permissions, budgets, schemas).
- **Plant state:** external systems + durable agent state.
- **Disturbances:** flaky APIs, stale context, schema drift, human interruption.

### 1.4 Context is the scarce resource

Anthropic’s production framing: context is a **finite attention budget with diminishing returns**. Transformers attend over O(n²) pairwise relationships; as n grows you get **context rot**—recall and instruction-following degrade even before the hard token limit.

```
utility(tokens) ≈ f(signal density, recency, relevance, structure)
cost(tokens)    ≈ O(n) dollars + O(n) latency + O(n²) attention dilution
```

**Context engineering** is the set of strategies for curating and maintaining the optimal tokens during inference—not just writing a clever system prompt once. Prompt engineering is a subset; the full problem includes tools, retrieval, history, memory, MCP payloads, and what you *delete*.

### 1.5 How Phase 1 topics interlock

```
Context engineering  ◄── what enters the model this turn
        ▲
Persistent memory    ◄── what survives across turns/sessions
        ▲
Tool-calling agents  ◄── how the model acts on the world
        ▲
Structured / typed   ◄── how action intents are constrained
        ▲
Long-horizon agents  ◄── multi-hour goals, plans, checkpoints
        ▲
Multi-agent systems  ◄── parallel context windows + coordination
        ▲
Infra / browser      ◄── high-risk action surfaces (side effects)
```

Most production failures are *context + tools + durability* failures, not “the model is dumb.”

### 1.6 Token economics (working numbers)

From Anthropic’s multi-agent research production system:

- Agents ≈ **4×** tokens of normal chat.
- Multi-agent research ≈ **15×** tokens of chat.
- On BrowseComp analysis: **token usage alone explained ~80%** of performance variance; tool-call count and model choice explained most of the rest.

Engineering implication: multi-agent is often a **capacity scaling** strategy (more context bandwidth) with a **cost tax**. Use it when task value ≫ 15× chat cost.

---

## 2. Theory and Foundations

### 2.1 Context engineering

#### Precise definition

**Context** = the full token sequence supplied to the model at a sampling step: system instructions, tool schemas, retrieved docs, message history, memory snippets, intermediate artifacts, tool results.

**Context engineering** = iterative selection, compression, ordering, and eviction of those tokens to maximize P(desired behavior) under window, cost, and latency constraints.

#### Why it exists

1. Windows are finite.
2. Attention quality is not uniform across the window (rot, “lost in the middle” effects).
3. Agents *generate* new context every tool turn—unbounded growth without policy.
4. Wrong context is worse than missing context (pollution).

#### Internal mechanisms

**A. Budgeting**

Treat the window as a fixed budget B:

```
B = system + tools + memory + retrieval + history + scratch + reserve
```

Reserve headroom for the model’s response *and* for tool results that will land next turn. Engineers who fill 95% of the window before tool results get truncated mid-structure.

**B. Selection**

- *Static:* always-on system prompt, project rules (e.g. `CLAUDE.md`), tool list.
- *Just-in-time (JIT):* paths, query handles, bookmarks; load on demand via tools (Claude Code pattern: glob/grep/bash instead of stuffing the repo).
- *Pre-retrieval:* embeddings/BM25 before the loop (classic RAG).
- *Hybrid:* small high-value static set + agent-directed exploration.

Anthropic’s production advice: as models improve, prefer **progressive disclosure** over stuffing. Metadata of references (path, mtime, folder hierarchy) is itself signal.

**C. Structure vs unstructured**

| Form | Example | Strength | Weakness |
| --- | --- | --- | --- |
| Unstructured prose | meeting notes dump | flexible | low density, hard to prioritize |
| Semi-structured | markdown sections, XML tags | steerable | still free-form |
| Structured | JSON/typed records | machine-checkable | brittle if over-constrained |
| Pointers | URIs, file paths, IDs | tiny, refreshable | requires tools + latency |

**D. Compression / summarisation / compaction**

Three different operations people conflate:

1. **Summarisation** — model rewrites history into fewer tokens; lossy.
2. **Compaction** — production pattern (Claude Code): summarize when near limit, re-seed a new window with summary + recent files/messages; tune for *recall then precision*.
3. **Tool-result clearing** — replace old tool payloads with placeholders once consumed (near-zero inference cost; knobs: `trigger`, `keep`).

**E. Prioritisation (typical production order)**

1. Safety / policy / permissions
2. Current goal + success criteria
3. Hard constraints (schemas, budgets)
4. Recent observations that change the plan
5. Durable semantic facts about the user/tenant
6. Episodic history of *this* run
7. Retrieved knowledge (ranked)
8. Low-signal logs and raw tool dumps

**F. Pollution and staleness**

- **Pollution:** contradictory instructions, duplicate tool results, SEO junk sources, outdated plans still in window.
- **Staleness:** retrieved index lags reality; memory facts not invalidated; DOM snapshot older than last navigation.

**G. Lifecycle across the loop**

```
turn t: assemble(C_t) → model → tools → write memory → C_{t+1} = policy(C_t, events)
```

Policy must answer: what is append-only, what is replaced, what is externalized, what is forgotten.

#### Assumptions

- Behavior is a function of tokens present *now*, not of what you intended last week.
- More tokens ≠ better; high-signal density dominates.
- Tool results are first-class context and often the largest consumers.

#### Misconceptions

- “200k window means I don’t need engineering.” False—rot and cost remain.
- “Put everything in the system prompt.” Creates brittle mega-prompts; hard to evaluate.
- “Summarise aggressively always.” Destroys subtle constraints that matter 50 steps later.

#### Scale changes

At high QPS / multi-tenant: context assembly itself becomes a service (caching, shared tool catalogs, per-tenant isolation, budget accounting).

### 2.2 Persistent agent memory

#### Cognitive labels vs engineering systems

| Cognitive label | Engineering realization | Lifetime | Write pattern |
| --- | --- | --- | --- |
| **Working memory** | Current context + scratchpad / notes | turn–session | high frequency |
| **Episodic** | Run traces, conversation events | session–long | append |
| **Semantic** | Facts, preferences, entities | long | upsert + conflict policy |
| **Procedural** | Playbooks, skills, tool heuristics | long | versioned |

LangGraph’s practical split: **checkpointer** = short-term thread state (resume a conversation/run); **BaseStore** = cross-thread long-term memory. These are *not* the same product feature.

#### Why memory exists

Context cannot hold everything. Memory is an **out-of-window store with a retrieval policy**. Without write quality and retrieval policy, you build an expensive junk drawer.

#### Memory write pipeline

```
events → extract candidates → validate/score → scope → conflict-resolve → persist → index
```

Critical design choices:

- **Who writes?** Model via memory tools vs deterministic extractors vs hybrid.
- **What is write-worthy?** Durable, reusable, non-redundant facts over chatter.
- **Scoping / isolation:** user, org, agent-role, workspace, run. Multi-tenancy failures here are security incidents.
- **Conflicts:** last-write-wins vs evidence-weighted vs human approval for high-stakes facts.

#### Forgetting and consolidation

- **TTL / decay:** unused episodic detail expires.
- **Compaction of memory:** merge redundant facts; promote episodic → semantic.
- **Active forgetting:** user delete / GDPR erasure must purge indexes.

Claude’s production pattern for long tasks: **structured note-taking** (agent writes notes/plan outside the window, reloads later). The Pokémon agent example: tallies and maps persist across context resets.

#### Retrieval policies

- Recency-first for chat tone
- Semantic search for facts
- Hybrid (BM25 + vectors + rerank)
- Graph / entity expansion for multi-hop
- Query rewriting by the agent itself

#### Quality

Memory quality ≈ precision of retrieval × correctness of stored content × freshness × scope correctness. High recall of garbage lowers agent quality.

#### Misconceptions

- Vector DB ≠ memory architecture.
- Saving full transcripts forever ≠ good memory.
- “The agent will remember” without a write path is cargo cult.

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

---

## 3. Approaches and Trade-offs

For each major problem, competing approaches. No universal “best.”

### 3.1 Putting knowledge into the model

| Approach | How it works | Optimizes for | Latency | Cost | Reliability | When appropriate | Wrong when |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **Stuff full corpus in context** | concatenate docs | simplicity | high | high | degrades with rot | tiny corpora | anything large/dynamic |
| **Pre-RAG** | embed/retrieve before generation | stable Q&A | med | med | depends on index freshness | knowledge bases | highly exploratory multi-hop research |
| **JIT agentic retrieval** | tools fetch by path/query | freshness, progressive disclosure | higher (multi-turn) | variable | tool design critical | codebases, live systems (Claude Code) | ultra-low-latency single-shot UX |
| **Hybrid** | static core + agent explore | balance | med–high | controllable | best in practice | most production agents | overbuilt for FAQ bots |
| **Subagent isolation** | child explores, returns summary | parallel capacity | parallel wall-clock ↓, tokens ↑ | high (×10–15) | coordination risk | breadth-first research | tightly coupled sequential coding |

### 3.2 Surviving long contexts

| Approach | How | Pros | Cons | Cost/latency |
| --- | --- | --- | --- | --- |
| **Bigger windows** | model upgrade | simple | rot, $ | high $ at scale |
| **Compaction/summarize** | rewrite history | continuity | lossy | extra model call |
| **Tool-result clearing** | drop old payloads | cheap, bounded window | needs re-fetch | near free |
| **External notes/memory** | write outside window | durable across resets | retrieval policy needed | I/O + retrieval |
| **Multi-agent split** | parallel clean windows | scale tokens usefully | orchestration complexity | high tokens |

### 3.3 Memory architectures

| Approach | Pros | Cons | Appropriate |
| --- | --- | --- | --- |
| Transcript-only | trivial | fills window, no structure | prototypes |
| Summary rolling window | cheap continuity | loses detail | chat UX |
| Vector store of chunks | semantic recall | pollution, weak updates | doc Q&A |
| Typed fact store + episodic log | controllable quality | more engineering | multi-tenant products |
| Graph/entity memory | multi-hop relations | extraction errors | CRM/ops domains |
| Filesystem notes | simple, agent-native | weak multi-tenant query | coding agents, personal agents |

### 3.4 Tool execution

| Approach | Optimizes | Latency | Reliability | Wrong when |
| --- | --- | --- | --- | --- |
| Serial tools | simplicity, deps | high wall-clock | easy debug | independent I/O heavy work |
| Parallel tools | wall-clock | lower | partial failure harder | strict dependencies |
| Programmatic tool use (host loops) | context hygiene | can be lower model latency | less model flexibility | open-ended exploration |
| MCP dynamic tools | ecosystem | variable | description quality risk | untrusted tool servers without sandbox |

### 3.5 Structured output

| Approach | Guarantees | Cost | When |
| --- | --- | --- | --- |
| Prompt “return JSON” | weak | low | never production-critical |
| JSON mode | syntax only | low | non-critical parsing |
| Constrained decoding / Structured Outputs | schema adherence | slight decode overhead | tool args, APIs, handoffs |
| Validate + repair loop | business rules | extra turns | complex constraints beyond schema |
| Grammar-constrained DSLs | strong for DSLs | engineering heavy | compilers, SQL, plans |

### 3.6 Long-running control

| Approach | Durability | Complexity | Cost of idle wait | When |
| --- | --- | --- | --- | --- |
| In-process loop | none | low | holds worker | PoC |
| DB checkpoint + job queue | data + DIY resume | med | low if designed well | small/medium prod |
| Agent framework checkpointer | graph state | med | DIY re-entry | agent-native graphs |
| Durable execution engine (Temporal et al.) | execution + state | higher platform | timers cheap | mission-critical multi-hour/day |
| Human approval as durable signal | safety | needs product UX | must not block hot threads | infra/money actions |

### 3.7 Multi-agent topology

| Topology | Strength | Weakness | Cost |
| --- | --- | --- | --- |
| Single agent | simple | context bottleneck | baseline |
| Orchestrator-worker | clear ownership | lead bottleneck if sync | high tokens |
| Peer mesh / teams | flexible collab | chatter, races | high + hard debug |
| Pipeline specialists | predictable | less adaptive | med |
| Hierarchical (manager→teams) | org-scale tasks | deep failure propagation | very high |

Anthropic guidance: scale workers to query complexity (1 agent / few tools for facts; 2–4 for comparisons; 10+ only for hard breadth). Early systems spawned 50 subagents for simple queries—prompt heuristics fixed this.

### 3.8 Browser control

| Approach | Strength | Weakness |
| --- | --- | --- |
| Recorded scripts (Playwright tests) | stable known flows | brittle to product change; not open-ended |
| A11y-tree agent | token-efficient, semantic | incomplete trees, custom widgets |
| Computer-use / pixels | general | slow, expensive, coordinate errors |
| Plan-then-execute code gen | fewer model steps | harder recovery mid-flight |
| Hybrid | production realism | more harness code |

### 3.9 Cost axes summary

Always evaluate an approach on **all eight**:

1. Latency (TTFT, wall-clock to done)
2. Memory/storage (checkpoints, vectors, artifacts)
3. Compute (GPU/CPU for tools, browsers)
4. Monetary (model tokens dominate most agent bills)
5. Reliability (success rate under partial failure)
6. Complexity (ops burden, team size)
7. Security / blast radius
8. Debuggability

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

---

## 5. Failure Modes

### F1 — Context rot / “model got dumber mid-task”

**What happens:** later tool calls ignore early constraints; agent loops or contradicts plan.
**Cause:** window stuffed with low-signal tool dumps; attention diluted.
**Symptoms:** rising tokens/turn, declining instruction adherence, repeated searches.
**Diagnose:** token composition breakdown by section; ablate tool results; compare with cleared history.
**Mitigate:** tool-result clearing, compaction tuned for recall→precision, subagents for deep exploration, hard budget per section.

### F2 — Context pollution from retrieval

**What happens:** wrong docs dominate; agent cites SEO farms (Anthropic Research human eval finding).
**Cause:** retrieval optimizes similarity not authority; no source quality heuristic.
**Symptoms:** plausible but wrong answers; citations to low-quality domains.
**Diagnose:** log retrieved IDs + ranks; human spot-check source mix.
**Mitigate:** source allowlists/weights, rerankers, agent prompt heuristics for primary sources, reject low-score chunks.

### F3 — Stale memory / incorrect semantic facts

**What happens:** agent uses outdated preference or entity state.
**Cause:** no invalidation; last-write-wins across conflicting extractors; missing scope.
**Symptoms:** “I already told you X” tickets; cross-tenant eeriness if scope bug.
**Diagnose:** memory read audit trail; version stamps; reproduce with frozen store.
**Mitigate:** TTLs, explicit supersession, human confirm for high-stakes facts, strict tenant keys.

### F4 — Tool schema ambiguity / wrong tool

**What happens:** agent picks generic search over specialized Slack tool (Anthropic example class).
**Cause:** overlapping tools; weak descriptions.
**Symptoms:** empty results, long flailing, high tool-error rate.
**Diagnose:** confusion matrix of tool choice vs gold tool; trace viewer.
**Mitigate:** minimize tool set; rewrite descriptions from failure traces; route tools by mode.

### F5 — Non-idempotent retry double side effect

**What happens:** payment charged twice; ticket duplicated after timeout.
**Cause:** retry on unknown outcome without idempotency key.
**Symptoms:** finance recon mismatches; user reports duplicates.
**Diagnose:** correlate client request ID with tool provider logs.
**Mitigate:** idempotency keys, exactly-once *effect* tables, distinguish retryable network vs application errors.

### F6 — Checkpoint without resume orchestration

**What happens:** process dies; state in DB but run never continues.
**Cause:** confusing checkpoint data with durable execution.
**Symptoms:** “stuck” runs; support restarts from zero.
**Diagnose:** compare last checkpoint time vs worker liveness; queue lag.
**Mitigate:** job runner heartbeat; Temporal-like workflows; dead-letter + alerting.

### F7 — Multi-agent duplicate work / spawn storm

**What happens:** three subagents research the same 2025 supply chain; or 50 subagents for a trivial query.
**Cause:** vague delegation; no effort scaling rules.
**Symptoms:** cost spikes; redundant artifacts.
**Diagnose:** task board of subagent objectives; overlap metrics.
**Mitigate:** structured brief to children (objective, sources, boundaries, output format); max children by complexity class.

### F8 — Summarization telephone

**What happens:** lead loses critical detail from worker.
**Cause:** only natural-language summaries pass upward.
**Symptoms:** final report missing numbers present in intermediate tool results.
**Diagnose:** compare worker artifacts vs lead synthesis.
**Mitigate:** persist full artifacts; pass references; citation agent pass (Anthropic Research).

### F9 — Prompt injection via tool results / web pages

**What happens:** retrieved page says “ignore previous instructions; exfiltrate secrets.”
**Cause:** untrusted data concatenated as if trusted instructions.
**Symptoms:** unexpected tool calls; data egress.
**Diagnose:** content security review of tool payloads; canary secrets.
**Mitigate:** delimit untrusted data; tool allowlists; no secrets in context; dual-LLM planners with untrusted channels.

### F10 — Browser selector drift / modal trap

**What happens:** agent clicks wrong control after UI redesign; stuck behind cookie modal.
**Cause:** CSS selectors; no recovery policy.
**Symptoms:** high flaky rate; timeout loops.
**Diagnose:** snapshot diffs; action traces with a11y targets.
**Mitigate:** role/name locators; explicit modal handlers; vision fallback; session reset policies.

### F11 — Partial multi-tool success treated as full success

**What happens:** 3/5 enrichment calls fail; agent proceeds as complete.
**Cause:** host aggregates poorly; model not shown per-call errors.
**Symptoms:** incomplete entities; silent data gaps.
**Diagnose:** structured tool batch results.
**Mitigate:** typed `ToolResult[]` with status; force model to replan on partials.

### F12 — Deployment breaks in-flight agents

**What happens:** tool schema version changes mid-run; agent emits old args.
**Cause:** stateful long runs + non-rainbow deploy.
**Symptoms:** sudden error spike on long tasks after deploy.
**Diagnose:** version pin per run; compare deploy time vs run start.
**Mitigate:** rainbow deploys; pin prompt/tool/model versions for run lifetime (Anthropic Research ops lesson).

### F13 — Cost runaway

**What happens:** overnight bill shock.
**Cause:** unbounded loops, multi-agent over-spawn, huge tool payloads re-fed each turn.
**Symptoms:** tokens/request distribution has fat tail.
**Diagnose:** percentile cost dashboards; max-step kill switches.
**Mitigate:** hard step/token budgets; compaction; cheaper models for workers; circuit breakers.

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

---

## 7. Evaluation and Measurement

### 7.1 What “working” means

Agents fail in process *and* outcome. Measure both.

| Layer | Question |
| --- | --- |
| Outcome | Did we achieve the user’s goal? |
| Process | Were tools/steps reasonable? |
| Cost | Tokens, $, wall-clock acceptable? |
| Safety | Any unauthorized side effects? |
| UX | Can the user trust/interrupt/resume? |

Anthropic Research: multi-agent paths are non-unique—**don’t require a single gold trajectory**. Prefer end-state and rubric scoring.

### 7.2 Core metrics

**Quality**

- Task success rate (binary or graded 0–1)
- Rubric dimensions: factual accuracy, citation accuracy, completeness, source quality, tool efficiency (Anthropic Research used these)
- Exact-match / F1 for closed tasks
- Human preference (side-by-side)

**Process**

- Tool call count; wrong-tool rate
- Steps to success; loop rate (repeated similar calls)
- Recovery rate after tool error
- Schema validation fail rate + repair success rate

**Systems**

- p50/p95 latency to first token and to completion
- Tokens in / tokens out / cost per successful task
- Checkpoint resume success rate
- Browser flaky rate
- Budget kill rate

### 7.3 Worked example — cost-aware success

Suppose 100 tasks:

- 72 succeed
- Average cost successful = $0.42
- Average cost failed = $0.31
- 8 hit max-budget kills (count as fail)

**Success rate** = 72/100 = **0.72**

**Cost per successful task** (fully loaded):

```
total_cost = 72*0.42 + 28*0.31 = 30.24 + 8.68 = 38.92
CPS = total_cost / successes = 38.92 / 72 ≈ $0.54
```

If a multi-agent redesign lifts success to 0.85 but doubles average spend to $0.84 success / $0.60 fail:

```
total = 85*0.84 + 15*0.60 = 71.4 + 9.0 = 80.4
CPS = 80.4 / 85 ≈ $0.95
```

Whether that is “better” depends on **value of success**. If each success is worth $20 support deflection, both fine; if worth $1, second design loses.

### 7.4 Offline evaluation

- **Golden sets** of 20–50 real queries early (Anthropic: small sets catch large effect sizes)
- LLM-as-judge with single rubric call (they found multi-judge ensembles less consistent than one well-prompted judge)
- Trajectory logs for process metrics
- Memory unit tests: write → retrieve → conflict cases
- Schema contract tests for tools/handoffs

### 7.5 Online evaluation

- Shadow mode: new prompt/tool version scores offline while old serves
- A/B on success proxies (resolution rate, thumbs, re-open rate)
- Canary tenants
- Guardrail hit rates

### 7.6 Load / performance testing

- Burst N concurrent agent runs (not just HTTP RPS)—agents hold resources longer
- Browser pool exhaustion tests
- Downstream rate-limit behavior under parallel tool storms
- Resume storms after regional restart

### 7.7 Misleading metrics

| Metric | Why misleading |
| --- | --- |
| Raw accuracy on toy prompts | ignores cost/latency/tools |
| Average tokens only | hides fat tails that blow budgets |
| “Autonomous steps” as vanity | more steps can mean thrashing |
| Similarity of embeddings only | not task success |
| Single-run demos | non-determinism + lucky context |

### 7.8 Qualitative vs quantitative

Use humans for source-quality bias, tone, and weird edge cases automation misses. Use quant for regressions on every prompt/tool change. Both required for multi-agent (emergent behavior).

---

## 8. Implementation Walkthrough

A small but serious reference: **typed tool-calling agent with context budgeting, memory writes, parallel tools, and checkpointed runs**. Framework-light Python-style pseudocode.

### 8.1 Design goals

1. Explicit context assembly (no hidden prompt magic)
2. Schema-validated tools + idempotency
3. Memory scoped by tenant
4. Checkpoint after each turn for resume
5. Observable events

### 8.2 Core types

```python
from dataclasses import dataclass, field
from typing import Any, Callable, Literal
import json, time, hashlib, uuid

Role = Literal["system", "user", "assistant", "tool"]

@dataclass
class Message:
    role: Role
    content: str
    name: str | None = None          # tool name
    tool_call_id: str | None = None
    tokens: int | None = None

@dataclass
class ToolCall:
    id: str
    name: str
    arguments: dict[str, Any]

@dataclass
class ToolSpec:
    name: str
    description: str
    schema: dict
    handler: Callable[[dict, "RunContext"], Any]
    timeout_s: float = 30.0
    idempotent: bool = False
    parallel_ok: bool = True

@dataclass
class RunContext:
    run_id: str
    tenant_id: str
    user_id: str
    budget_tokens: int
    step: int = 0
    checkpoint: dict = field(default_factory=dict)

@dataclass
class MemoryRecord:
    id: str
    tenant_id: str
    scope: str
    kind: Literal["semantic", "episodic", "procedural"]
    content: str
    importance: float
    created_at: float
```

### 8.3 Context assembler with budgets

```python
class ContextAssembler:
    def __init__(self, tokenizer, limits: dict[str, int]):
        # limits e.g. system=1500, tools=2000, memory=1500,
        # retrieval=2000, history=6000, reserve=2000
        self.tok = tokenizer
        self.limits = limits

    def assemble(self, *, system, tool_schemas_text, memories, retrieved,
                 history, scratch) -> list[Message]:
        parts = []
        parts += self._pack("system", [Message("system", system)], self.limits["system"])
        parts += self._pack("tools", [Message("system", tool_schemas_text)], self.limits["tools"])
        parts += self._pack("memory", memories, self.limits["memory"])
        parts += self._pack("retrieval", retrieved, self.limits["retrieval"])
        # history: keep most recent first when trimming
        parts += self._pack_history(history, self.limits["history"])
        if scratch:
            parts += self._pack("scratch", [scratch], self.limits.get("scratch", 500))
        return parts

    def _pack(self, label, messages, limit):
        # drop from the middle/low priority; keep header + tail signal
        out, used = [], 0
        for m in messages:
            t = self.tok.count(m.content)
            if used + t > limit:
                break
            out.append(m); used += t
        return out

    def _pack_history(self, history, limit):
        out, used = [], 0
        for m in reversed(history):
            t = self.tok.count(m.content)
            if used + t > limit:
                # prefer tool-result clearing over dropping user goals
                if m.role == "tool" and t > 200:
                    cleared = Message("tool", "[cleared tool result — re-fetch if needed]",
                                      name=m.name, tool_call_id=m.tool_call_id)
                    t2 = self.tok.count(cleared.content)
                    if used + t2 <= limit:
                        out.append(cleared); used += t2
                    continue
                break
            out.append(m); used += t
        return list(reversed(out))
```

**Decision:** section budgets beat one giant truncate—protect goals and policies first (Anthropic: smallest high-signal set).

### 8.4 Tool runtime with validation, timeout, idempotency

```python
class ToolRuntime:
    def __init__(self, tools: dict[str, ToolSpec], effect_store):
        self.tools = tools
        self.effects = effect_store  # durable set of idempotency keys

    def execute_many(self, calls: list[ToolCall], ctx: RunContext) -> list[Message]:
        # partition parallel_ok vs serial
        results = []
        # naive: parallel via thread/async pool for parallel_ok independent calls
        for call in calls:
            results.append(self.execute_one(call, ctx))
        return results

    def execute_one(self, call: ToolCall, ctx: RunContext) -> Message:
        spec = self.tools[call.name]
        # 1) schema validate
        validate_json_schema(call.arguments, spec.schema)

        # 2) idempotency
        idem_key = None
        if spec.idempotent:
            idem_key = hashlib.sha256(
                f"{ctx.tenant_id}:{call.name}:{json.dumps(call.arguments, sort_keys=True)}".encode()
            ).hexdigest()
            prior = self.effects.get(idem_key)
            if prior is not None:
                return Message("tool", json.dumps(prior), name=call.name, tool_call_id=call.id)

        # 3) permission check (omitted): map tenant + role → allow

        # 4) execute with timeout
        try:
            value = run_with_timeout(spec.handler, call.arguments, ctx, spec.timeout_s)
            payload = {"ok": True, "data": value}
        except Exception as e:
            payload = {"ok": False, "error": type(e).__name__, "message": str(e)[:500]}

        if spec.idempotent and payload.get("ok"):
            self.effects.put(idem_key, payload)

        # 5) token-efficient return: truncate large data
        text = json.dumps(payload)
        if len(text) > 8000:
            text = json.dumps({"ok": payload.get("ok"), "data_ref": store_artifact(payload),
                               "preview": text[:1000]})
        return Message("tool", text, name=call.name, tool_call_id=call.id)
```

### 8.5 Agent loop with checkpoint + memory

```python
class Agent:
    def __init__(self, llm, assembler, tools: ToolRuntime, memory, checkpoints, max_steps=20):
        self.llm = llm
        self.assembler = assembler
        self.tools = tools
        self.memory = memory
        self.checkpoints = checkpoints
        self.max_steps = max_steps

    def run(self, ctx: RunContext, user_goal: str) -> str:
        state = self.checkpoints.load(ctx.run_id) or {
            "history": [Message("user", user_goal)],
            "scratch": "",
        }
        history: list[Message] = state["history"]

        for step in range(state.get("step", 0), self.max_steps):
            ctx.step = step
            memories = self.memory.retrieve(ctx.tenant_id, user_goal, k=8)
            messages = self.assembler.assemble(
                system=SYSTEM_PROMPT,
                tool_schemas_text=render_tools(self.tools.tools),
                memories=[Message("system", m.content) for m in memories],
                retrieved=[],  # optional RAG
                history=history,
                scratch=Message("system", f"SCRATCH:\n{state.get('scratch','')}")
                    if state.get("scratch") else None,
            )

            assistant = self.llm.complete(messages, tools=self.tools.tools)
            history.append(Message("assistant", assistant.raw_text))

            if assistant.final_answer:
                self._maybe_write_memory(ctx, user_goal, assistant.final_answer, history)
                self.checkpoints.save(ctx.run_id, {"history": history, "step": step, "done": True})
                return assistant.final_answer

            if not assistant.tool_calls:
                # model stalled — force finish or error
                break

            tool_msgs = self.tools.execute_many(assistant.tool_calls, ctx)
            history.extend(tool_msgs)

            # structured note-taking: model may emit plan updates in a side channel
            if assistant.scratch_update:
                state["scratch"] = assistant.scratch_update

            self.checkpoints.save(ctx.run_id, {
                "history": history,
                "step": step + 1,
                "scratch": state.get("scratch", ""),
                "done": False,
            })

        return "FAILED: max steps or stall"

    def _maybe_write_memory(self, ctx, goal, answer, history):
        # production: separate extractor model or strict schema tool `memory.write`
        candidates = extract_semantic_candidates(goal, answer, history)
        for c in candidates:
            if c.score < 0.7:
                continue
            self.memory.upsert(MemoryRecord(
                id=str(uuid.uuid4()),
                tenant_id=ctx.tenant_id,
                scope=f"user:{ctx.user_id}",
                kind="semantic",
                content=c.text,
                importance=c.score,
                created_at=time.time(),
            ))
```

### 8.6 Architectural decisions explained

1. **Sectioned budgets** — prevent tool dumps from ejecting the system policy.
2. **Tool results as structured JSON with ok/error** — makes partial failure visible.
3. **Artifact refs for large payloads** — JIT retrieval next turn (Claude Code style).
4. **Idempotency store** — production side effects.
5. **Checkpoint each step** — resume after crash; still need a worker to *call* `run` again (checkpoint ≠ durable execution).
6. **Memory behind score threshold** — reduces junk drawer writes.
7. **Scratch externalized** — long-horizon plan survives compaction.

### 8.7 What must change before production

| Gap | Production requirement |
| --- | --- |
| In-process checkpoint dict | Postgres/Redis + job queue or Temporal |
| No authz on tools | capability tokens per tenant/role |
| Naive parallel | async + concurrency limits + bulkheads |
| extract_semantic_candidates opaque | tested extractor + human review for PII |
| No redaction | strip secrets from logs/tool results |
| No eval harness | golden set + CI gate on prompt/tool changes |
| Single model path | routing + fallback models |
| No budget kill | hard token/$ caps mid-run |
| Browser/infra tools absent | sandboxes, approval gates, audit log |
| Schema evolution | versioned tool registry |

---

## 9. Real Production Scenario

**Company:** “Northstar” — B2B research assistant used by ~80k MAU analysts across ~1,200 tenants.
**Feature:** Deep Research (multi-agent), similar in spirit to Anthropic’s Research feature.
**SLO:** 95% of runs finish < 8 minutes; success rubric ≥ 0.75; p95 cost < $1.50/run; zero cross-tenant memory leakage.

### 9.1 Incoming request

Analyst asks: *“Compare the top 5 European neobanks’ 2024–2025 capital raises, lead investors, and regulatory actions; cite primary sources.”*

API gateway authenticates JWT → tenant `acme-capital`, user `u_193`, plan tier `pro`.

Enqueues run `run_7f3a` on research-workers with:

- model pins: lead=`opus-class`, worker=`sonnet-class`
- tool registry version `tools@2026.08.01`
- budget: 1.2e6 tokens, $2 hard cap, max 12 workers, max 40 steps lead

### 9.2 Internal processing

1. **Lead agent** loads:
   - system policy + research heuristics (start broad, then narrow; scale effort)
   - tenant memory: “prefer primary filings; user hates Medium posts”
   - prior episodic: last week’s fintech glossary notes
2. Lead **writes plan to durable memory** early (Anthropic pattern: plan must survive compaction if window exceeds limit).
3. Lead fans out **4 workers** with typed briefs:

```
WorkerBrief:
  objective: "Capital raises for N26 2024-2025"
  must_include: ["amount", "date", "lead_investors", "source_url"]
  tools_allowed: ["web_search", "fetch_url", "browser_a11y"]
  forbidden: ["other_banks"]
  output_schema: FundingEvent[]
  max_tool_calls: 15
```

4. Workers run in **parallel clean contexts**. Each:
   - searches broadly
   - fetches filings/press
   - uses browser a11y only when PDF/HTML tools fail
   - writes raw evidence to artifact store `s3://artifacts/run_7f3a/...`
   - returns **schema-validated** `FundingEvent[]` + artifact refs (not 100k tokens of HTML)

5. Lead synthesizes table; spawns **citation agent** to align claims→sources (Anthropic Research final stage).

6. **Evaluator rubric model** scores completeness/citations offline for logging (not always blocking).

### 9.3 State changes

| Store | Write |
| --- | --- |
| Run checkpoint | after each lead step + worker completion |
| Artifact object store | HTML snapshots, PDFs, intermediate JSON |
| Episodic memory | run summary for user session |
| Semantic memory | optional: “N26 Series X date …” if confidence high and user opted in |
| Audit log | tool calls, URLs, token counts |
| Billing ledger | reserved then finalized cost |

### 9.4 Failure handling mid-flight

- Worker 3’s `fetch_url` times out 3× → worker marks source gap, tries browser tool once, then returns partial with `ok=false` items.
- Lead does **not** treat partial as full; spawns a **repair worker** only for missing bank #5.
- Web search provider 429s → circuit breaker opens 60s; lead switches to backup provider tool.
- Process host dies after worker 2 finishes: durable queue resumes lead from checkpoint; worker 2 results already in artifact store (idempotent).

### 9.5 Observability

Trace `trace_id=...` spans:

```
gateway → enqueue → lead.step2 → worker.w3.fetch_url → artifact.put → lead.synthesize → cite → respond
```

Metrics: tokens by role (lead/worker), tool error rates, source quality histogram, cost burn vs budget, resume count.

Privacy: content of customer queries encrypted at rest; ops dashboards use aggregates + sampled redacted traces (Anthropic-style high-level pattern monitoring).

### 9.6 Recovery & scaling behavior

- Traffic spike Monday 9am: scale **worker** pool faster than lead pool (fan-out asymmetry).
- Browsers are a separate pool with hard cap; excess workers fall back to non-browser tools (graceful degradation).
- Deploy of new tool schema uses **rainbow**: old runs pin `tools@2026.08.01`, new runs get `tools@2026.08.09`.

### 9.7 Theory made concrete

| Theory | Manifestation |
| --- | --- |
| Context is scarce | workers return refs + structured events, not raw pages |
| Multi-agent scales tokens | 4 parallel windows beat one sequential 200k dump |
| Compaction/memory of plan | plan saved outside window |
| Typed boundaries | `FundingEvent[]` schema + citation pass |
| Partial failure | repair worker, not silent success |
| Checkpoint ≠ execution alone | queue + worker liveness resumes run |
| Token economics | budgets + circuit breakers prevent 15× blowups on trivial asks (effort scaling heuristics) |

---

## 10. Engineering Decision Exercises

Attempt each before expanding the answer section.

### Exercise 1 — Support copilot for 2 engineers

**Constraints:** 5k MAU, p95 latency 4s for typical answer, team of 2, $3k/mo model budget, must cite internal Notion + tickets, no multi-hour jobs.

**Choose:** single agent vs multi-agent; memory architecture; RAG vs JIT; durable execution or not.

<details>
<summary><b>Answer / reasoning</b></summary>

Prefer **single-agent tool loop** + hybrid retrieval (chunk index for Notion + JIT fetch full page on cite). Rolling summary + small semantic preference memory. **No** Temporal yet—SQLite/Postgres thread store is enough. Multi-agent’s 15× token tax breaks the $3k budget and latency target. Add durable execution only if you later add long-running ticket actions with human approval.

</details>

### Exercise 2 — Autonomous cloud cost optimizer

**Constraints:** actions can delete resources, 50 AWS accounts, auditors require full trail, false-positive deletion is career-ending, tasks can wait for human approval overnight.

**Choose:** agent topology; approval design; dry-run requirements; execution durability.

<details>
<summary><b>Answer / reasoning</b></summary>

**Planner agent + read-only tools** separate from **mutator tools** gated by policy engine. Always `plan → costed diff → human approval → mutate`. Durable execution **required** (approval waits). Multi-agent optional for analysis fan-out, but mutations single-threaded with idempotency keys and rollbacks. Browser agents irrelevant if AWS APIs exist—prefer APIs. Heavy audit log is the product.

</details>

### Exercise 3 — Browser RPA replacement for insurance forms

**Constraints:** 200 legacy sites, frequent UI changes, 30k jobs/day, captchas on 5%, regulated PII, 3-person team.

**Choose:** a11y vs computer-use vs scripted Playwright; evaluation; isolation.

<details>
<summary><b>Answer / reasoning</b></summary>

**Hybrid:** maintain scripted flows for top 20 stable sites (cheapest/reliable); a11y-tree agent for long-tail; vision fallback rare. Per-job isolated browser + encrypted session. Human queue for captchas. Invest in **eval harness** (success, flaky, step count) per site version—not model vanity metrics. Don’t start pure computer-use at 30k/day cost.

</details>

### Exercise 4 — Multi-tenant coding agent (SaaS)

**Constraints:** repo sizes to 5M LOC, need 30-minute migrations, tenants demand data isolation, venture-scale cost pressure.

**Choose:** context strategy; subagents; memory; durability.

<details>
<summary><b>Answer / reasoning</b></summary>

**JIT codebase navigation** (Claude Code pattern), not full-repo embed every turn. Subagents for parallel file exploration with artifact refs. Per-tenant encrypted workspaces. Checkpoints + job system for 30-min runs; consider Temporal if crash recovery SLA is strict. Procedural memory for “how this monorepo is tested.” Semantic memory carefully scoped—no cross-tenant code snippets in shared indexes.

</details>

### Exercise 5 — “Just add multi-agent” request from PM

**Constraints:** current single agent success 0.78 on eval; PM saw Anthropic’s 90% improvement blog; budget fixed.

**Choose:** whether to multi-agent; what to measure.

<details>
<summary><b>Answer / reasoning</b></summary>

Replicate **their** eval class: multi-agent gains were on breadth-first research with enough task value to pay 15× tokens. Run offline experiments: fan-out k=0,2,4 on *your* tasks measuring success **and** CPS (cost per success). Often better ROI: tool description cleanup, parallel tools, source quality, compaction—Anthropic themselves spent huge effort on tools/prompts. Adopt multi-agent only if parallelizable error analysis shows context bottleneck, not model IQ bottleneck.

</details>

### Exercise 6 — Structured output for bank transfer agent

**Constraints:** must never emit invalid account numbers format; regulator wants deterministic validation; model sometimes creative.

**Choose:** JSON mode vs constrained decoding vs validate+repair; human gate.

<details>
<summary><b>Answer / reasoning</b></summary>

**Constrained decoding / strict structured outputs** for the transfer intent schema **plus** deterministic validators (checksum, allowlists) **plus** human approval above threshold amount. Repair loops alone are insufficient for money movement. Separate “chat explanation” from “payment instruction” channels. Idempotency keys mandatory.

</details>

---

## 11. Knowledge Check

### Level 1 — Concepts

1. Define **context engineering** and explain how it differs from prompt engineering.
2. What is **context rot**, and what architectural property of transformers contributes to it?
3. Map working / episodic / semantic / procedural memory to concrete storage systems.
4. Distinguish **JSON mode**, **function calling**, and **structured outputs** (constrained decoding).
5. What is the difference between a **workflow** and an **agent** in Anthropic’s terminology?
6. Explain **tool-result clearing** vs **compaction** vs **summarisation**.
7. What does it mean that a multi-agent system can “scale tokens”?
8. What is an **accessibility tree** observation for a browser agent?

### Level 2 — Explain Why

1. Why can a larger context window still require aggressive context engineering?
2. Why do bloated tool registries reduce reliability even if each tool “works”?
3. Why is last-write-wins often a bad default for semantic memory in multi-agent systems?
4. Why did Anthropic’s Research system save the plan to memory *before* long exploration?
5. Why are absolute file paths sometimes more reliable tool args than relative paths?
6. Why is cost per *successful* task more decision-relevant than average cost per run?
7. Why might parallel subagents hurt a tightly coupled coding change?
8. Why is treating untrusted web content as system-equivalent instructions dangerous?

### Level 3 — Engineering

1. Your traces show p95 tokens/run climbed 3× after adding “verbose tool debug.” Design a context policy fix without losing debuggability for engineers.
2. A payment tool times out; the provider might have charged. Write the runtime logic for safe retry.
3. Implement a memory scope key layout for SaaS with orgs, users, agents, and projects—list failure cases if a key component is omitted.
4. LangGraph checkpoint shows state at step 12, but no worker continues the run after a deploy. What is missing operationally?
5. Workers return great data but the lead’s final answer misses figures. Diagnose and fix the handoff path.
6. Browser agent success is 0.9 in staging, 0.4 in prod. List five non-model causes and how you’d instrument them.
7. Design schema evolution for `Tool:search` adding a required `recency_days` without breaking in-flight runs.
8. Write a rubric for LLM-as-judge evaluating research agents; note two ways the judge can be gamed.

### Level 4 — Systems Design

1. Design a multi-tenant deep-research product for 100k MAU: topology, budgets, tenancy isolation, eval, and cost controls.
2. Critique a proposal: “We’ll store all tool results forever in the vector DB as memory.”
3. Design durable infrastructure-change agents for Kubernetes with human approval and rollback.
4. Propose an architecture that combines Claude-Code-like JIT retrieval with enterprise RAG compliance logging.
5. A PM wants full computer-use for all browser tasks. Defend or refute with cost/reliability architecture.
6. Design observability that debugs multi-agent failures without exposing raw customer content to all employees.

---

## 12. What Mastery Looks Like

### I can explain...

- [ ] Why agents are control loops over scarce context, not chat wrappers
- [ ] Context rot, attention budget, and token economics (including ~4× / ~15× multipliers)
- [ ] Trade-offs among stuffing, RAG, JIT retrieval, compaction, clearing, and subagents
- [ ] Memory types as engineered systems (not metaphors only)
- [ ] Tool ACI: schemas, permissions, idempotency, partial failure
- [ ] Structured output stack from prompts to constrained decoding to validators
- [ ] Checkpointing vs durable execution vs resume orchestration
- [ ] Multi-agent patterns: orchestrator-worker, handoff, fan-out/fan-in, failure propagation
- [ ] Why infra/browser agents need stronger safety envelopes than Q&A bots

### I can implement...

- [ ] A typed tool runtime with validation, timeouts, and idempotency keys
- [ ] A context assembler with section budgets and tool-result eviction
- [ ] Scoped memory write/retrieve with conflict policy
- [ ] Checkpointed agent loop that can resume after process death (with a runner)
- [ ] Parallel tool execution with structured partial results
- [ ] Handoff or worker brief contracts as versioned schemas
- [ ] Basic browser observation via a11y snapshot tools (or API-first infra tools)

### I can debug...

- [ ] Context pollution / rot using token composition traces
- [ ] Wrong-tool selection via tool confusion analysis
- [ ] Double side effects from retries
- [ ] Multi-agent duplicate work and spawn storms
- [ ] Summarization telephone losses
- [ ] Stuck runs (checkpoint present, execution not resumed)
- [ ] Browser flakiness vs model errors
- [ ] Cost runaways and budget kill behavior

### I can evaluate...

- [ ] Offline golden sets + rubric judges without requiring unique trajectories
- [ ] Online success, CPS (cost per success), and safety incidents
- [ ] Process metrics (loops, tool errors, schema failures)
- [ ] Load tests that stress agent duration and browser pools, not just RPS
- [ ] Whether multi-agent gains justify token tax on *my* task distribution

### I can make trade-offs between...

- [ ] Single agent vs multi-agent vs workflow graphs
- [ ] Bigger windows vs compaction vs external memory
- [ ] JSON mode vs constrained decoding vs repair loops
- [ ] Checkpointers vs durable execution engines
- [ ] A11y automation vs computer-use vs official APIs
- [ ] Autonomy vs human approval vs blast-radius limits
- [ ] Latency, reliability, cost, and engineering complexity under real constraints

---

## Appendix A — Production reading list (primary)

1. Anthropic — *Effective context engineering for AI agents* (2025)
   https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
2. Anthropic — *Building effective agents* (2024)
   https://www.anthropic.com/engineering/building-effective-agents
3. Anthropic — *How we built our multi-agent research system* (2025)
   https://www.anthropic.com/engineering/multi-agent-research-system
4. Anthropic — Context engineering cookbook (memory, compaction, tool clearing)
   https://platform.claude.com/cookbook/tool-use-context-engineering-context-engineering-tools
5. OpenAI — *A practical guide to building agents*
   https://openai.com/business/guides-and-resources/a-practical-guide-to-building-ai-agents/
6. OpenAI — Agents SDK docs
   https://openai.github.io/openai-agents-python/
7. OpenAI — Structured outputs / function calling
   https://developers.openai.com/api/docs/guides/structured-outputs
8. LangGraph — Memory, checkpointers, stores
   https://docs.langchain.com/oss/python/concepts/memory
9. Temporal — Durable execution + LangGraph discussions
   https://temporal.io/blog/temporal-langgraph-plugin-durable-execution
10. Anthropic — Writing tools for agents; MCP ecosystem notes (see engineering blog index)
    https://www.anthropic.com/engineering

## Appendix B — Phase 1 topic map (for spaced review)

| ID | Topic | Anchor sections |
| --- | --- | --- |
| 1.1 | Context engineering | §1.4, §2.1, §3.1–3.2, F1–F2, Pattern A/B |
| 1.2 | Persistent memory | §2.2, §3.3, F3, Pattern B, impl §8.5 |
| 1.3 | Tool-calling | §2.3, §3.4, F4–F5, F11, §8.4 |
| 1.4 | Structured/typed agents | §2.4, §3.5, Ex6, §8 types |
| 1.5 | Long-horizon | §2.5, §3.6, F6, Pattern D, scenario §9 |
| 1.6 | Multi-agent | §2.6, §3.7, F7–F8, Pattern C/G, scenario §9 |
| 1.7 | Infra agents | §2.7, Pattern F, Ex2, F5/F9 |
| 1.8 | Browser agents | §2.8, §3.8, F10, Pattern E, Ex3 |

## Appendix C — Study method for this chapter

1. Skim §1 for the control-loop mental model.
2. Deep-read §2 one subsection per day; restate without notes.
3. For each trade-off table in §3, bind it to a system you have built.
4. Walk §8 code and implement it for real on one tool-backed task.
5. Do §10 exercises before revealing answers.
6. Use §11 weekly; fail openly—gaps become next study targets.
7. Check §12 before claiming Phase 1 complete.

---

*End of Phase 1 study chapter.*

