# Phase 1 — Agents (expanded study pack)

This is the **uncompressed** version of the study material.

The earlier `FULL_CHAPTER.md` was deliberately dense (written under pressure to fit Craft MCP chunk uploads). **Do not study from that file as primary material.** Use this `by-topic/` pack instead.

## How to read

| Order | File | Focus |
| --- | --- | --- |
| 1 | `01_mental_model.md` | What agents actually are; control loop; terminology |
| 2 | `02_context_engineering.md` | Token budgets, selection, compaction, pollution, debugging |
| 3 | `03_persistent_memory.md` | Working/episodic/semantic/procedural; writes; isolation |
| 4 | `04_tool_calling.md` | Schemas, selection, parallel, retries, idempotency |
| 5 | `05_structured_typed_agents.md` | JSON mode → constrained decoding → contracts |
| 6 | `06_long_horizon_agents.md` | Plans, checkpoints, durable execution, recovery |
| 7 | `07_multi_agent_systems.md` | Topologies, handoffs, failure propagation |
| 8 | `08_infra_and_browser_agents.md` | Side-effect safety + browser observation stacks |
| 9 | `09_production_path_and_failures.md` | PoC→prod, failure modes, architecture patterns |
| 10 | `10_evaluation_and_implementation.md` | Metrics, reference impl, production scenario |
| 11 | `11_exercises_and_mastery.md` | Decision exercises, knowledge check, mastery list |

## Primary production sources (re-read these)

1. Anthropic — Effective context engineering for AI agents (2025)
2. Anthropic — Building effective agents (2024)
3. Anthropic — How we built our multi-agent research system (2025)
4. Anthropic — Context engineering cookbook (compaction / clearing / memory)
5. OpenAI — A practical guide to building agents + Agents SDK
6. OpenAI — Structured Outputs & function calling
7. LangGraph — Memory, checkpointers, stores
8. Temporal engineering notes — checkpoints vs durable execution

## Study method

For each topic file: read once for map → restate mechanisms without looking → implement one small piece → do the knowledge checks in file 11 for that topic.


---

# 1. Mental Model — How Intelligent Agent Systems Actually Operate

## 1.1 The fundamental problem

A large language model, used by itself, is a **stateless conditional generator**. You give it a sequence of tokens; it samples a continuation. That fact never changes, no matter how much product language we wrap around it.

Almost everything people want from “AI agents” violates the assumptions of a single clean completion:

1. **Duration.** Real goals take many model calls. A codebase migration, a multi-source research brief, or a browser workflow is not one prompt.
2. **External truth.** The model does not contain your ticket queue, your customer’s live balance, or the current DOM of a partner portal. Truth is outside.
3. **Side effects.** Writing a row, refunding a charge, restarting a pod, or submitting a form changes the world. Wrong actions have cost.
4. **Scarce attention.** Every extra token competes for the model’s finite effective attention. More context is not free, and often not better.
5. **Partial failure.** Tools time out. Half of a parallel fan-out fails. Processes die mid-run. Humans interrupt. The normal case is messy.

So the real problem statement is not “how do I make the model smarter?” It is:

> **How do I build a system that repeatedly assembles a high-utility finite context, lets a model propose the next actions, executes those actions under policy, feeds observations back, persists what must survive the next turn or a crash, and stops under budget—while remaining debuggable and safe?**

That system is what engineers mean (when they are being precise) by an **agent runtime**.

---

## 1.2 Intuition first, then names

Imagine a competent junior engineer given a laptop, a ticket, and access to internal tools.

They do not paste the entire company wiki into their working memory. They:

- keep the ticket and acceptance criteria close;
- open a few relevant files or dashboards;
- try something;
- look at the result;
- update a short note (“deploy blocked on migration”);
- come back tomorrow and re-read their note.

An agent is the same control pattern, with two harsh constraints:

1. **Working memory is the context window**, and it is both expensive and lossy at length.
2. **The “person” is stochastic.** The same state does not always produce the same next action.

Everything called “context engineering,” “memory,” “tool calling,” “planning,” or “multi-agent” is a technique for making that control loop work under those constraints.

---

## 1.3 The agent loop as a closed-loop controller

```
                    ┌─────────────────────────────────┐
                    │     Durable runtime / queue     │
                    │  checkpoints · timers · resume  │
                    └──────────────┬──────────────────┘
                                   │ rehydrate state
                                   v
   Goal ──► Assemble context ──► Model step ──► Interpret structured intent
              ▲                      │
              │                      ├─► terminal answer ──► stop
              │                      │
              │                      └─► tool call(s) ──► execute under policy
              │                                              │
              │                         observations ◄───────┘
              │                              │
              └──── memory writes / logs / plan updates ◄────┘
```

Map this to classical control:

| Control concept | Agent system analogue |
| --- | --- |
| Reference signal | User goal + success criteria + policies |
| Controller | Model + your decoding constraints + routing logic |
| Actuators | Tools (APIs, shell, browser, infra CLIs) |
| Sensors | Tool results, metrics, DOM/a11y, logs |
| Plant | External systems + durable agent state |
| Disturbance | Flaky APIs, stale indexes, UI changes, injection |
| State estimator | Context assembler + memory retrieval |

This framing is useful because it forces the right questions:

- What is the **state**?
- What is the **action space**?
- What is the **observation channel**?
- What are the **safety interlocks** on actuators?
- What is the **cost of each control cycle**?

If you only think in chat UX terms (“messages in a thread”), you will under-design durability, permissions, and budgets.

---

## 1.4 Workflows vs agents (and why industry language is sloppy)

Anthropic’s distinction, now widely used:

- A **workflow** orchestrates LLMs and tools along **predefined** code paths (graphs, pipelines, fixed stages).
- An **agent** lets the model **dynamically** choose the next tools and structure of work based on intermediate observations.
- **Agentic system** is the umbrella term for both.

These are ends of a spectrum, not a purity test. Production systems are usually hybrids:

- fixed outer workflow (auth → quota → run record → bill);
- agentic inner loop for the uncertain middle;
- fixed terminal stages (citation check, schema validate, redaction).

### Overloaded words to disambiguate every time you hear them

**“Agent”** might mean:

1. a single tool-calling loop;
2. a product feature with autonomy marketing;
3. one role inside a multi-agent graph;
4. a background job that happens to call an LLM.

**“Memory”** might mean:

1. the conversation transcript still in context;
2. a summary of that transcript;
3. a vector index of documents (often just RAG);
4. a typed fact store with scopes and conflict rules;
5. a workflow checkpoint (execution state, not knowledge).

**“Context”** might mean:

1. the literal token window;
2. “business context” as in domain knowledge;
3. React/JS context (unrelated);
4. retrieval corpus.

**When you read a blog post, translate every overloaded term into: where state lives, who owns the next decision, and what survives process death.**

---

## 1.5 The scarcity that drives the whole field: context

Anthropic’s 2025 production framing is the right starting point: **context is a finite resource with diminishing marginal returns.**

Mechanically:

- Transformers build pairwise interactions across tokens (attention). As sequence length grows, the model’s ability to use every token with equal fidelity degrades. This is discussed in industry as **context rot** (and related phenomena like lost-in-the-middle).
- Training distributions historically over-represent shorter sequences, so long-context behavior is partly extrapolation.
- Positional schemes and long-context training help, but they do not create infinite perfect working memory.

So “we have a 200k window” does **not** mean “dump everything.” It means “you have a larger **budget**, still subject to rot, latency, and dollar cost.”

### Token economics as a first-class design input

Anthropic’s multi-agent research system published striking empirical notes:

- agent runs often use on the order of **~4×** the tokens of ordinary chat;
- multi-agent research can approach **~15×** chat token usage;
- in one BrowseComp analysis, **token usage alone explained ~80%** of performance variance, with tool-call count and model choice explaining much of the rest.

Interpretation for engineers:

1. Many “architecture wins” are really **capacity wins**—you found a way to spend more useful tokens.
2. Multi-agent is not free intelligence; it is often **parallel context bandwidth** purchased at high cost.
3. You should track **cost per successful task**, not only average tokens.

---

## 1.6 How Phase 1 topics lock together

Study them as one machine, not eight buzzwords:

```
Context engineering     what enters the model on this turn
        ↑ pulls from
Persistent memory       what survives across turns and sessions
        ↑ written by / read for
Tool-calling            how the model acts on the outside world
        ↑ constrained by
Structured / typed I/O  how intents become machine-checkable
        ↑ sequenced by
Long-horizon control    plans, checkpoints, resume, replanning
        ↑ scaled by
Multi-agent systems     multiple contexts + coordination protocols
        ↑ specialized into
Infra & browser agents  high-blast-radius action surfaces
```

**Failure intuition:** when a production agent “gets dumb,” the bug is usually in assembly of context, tool contracts, memory scope, or durability—not in the base model’s IQ ceiling.

---

## 1.7 A minimal complete mental checklist

Before designing any agent feature, answer:

1. **Goal & stop condition** — what does done mean? what is the max step/token/$ budget?
2. **Action space** — which tools exist? which are forbidden?
3. **Observation quality** — will the model see errors clearly, or silent empties?
4. **Context policy** — what is always present, retrieved, cleared, summarized?
5. **Durable state** — what must survive crash? where is it stored?
6. **Side-effect safety** — idempotency, approvals, blast radius, audit.
7. **Evaluation** — how will you know a prompt/tool change helped?

If you cannot answer these, you do not have an agent architecture; you have a demo script.

---

## 1.8 What “good taste” looks like (from production teams)

Across Anthropic’s agent posts and OpenAI’s practical guide, the same taste emerges:

- Prefer **simple composable patterns** over framework cathedrals until complexity is earned.
- Invest heavily in **tool interfaces** (ACI: agent–computer interface), not only system prompts.
- Treat long-running work as a **systems problem** (state, resume, deploy safety), not only a prompting problem.
- Measure with **small realistic evals early**; do not wait for a 500-case harness to learn anything.
- Add multi-agent only when the task is **parallelizable and valuable enough** to pay the token tax.

Next: `02_context_engineering.md` — the discipline that sits under every other topic.


---

# 2. Context Engineering

> Primary production source: Anthropic, *Effective context engineering for AI agents* (2025), plus Claude Code context-management cookbook (compaction, tool-result clearing, memory).

## 2.1 What problem this solves

The model only “knows” what is in the current token sequence. Agents generate new candidates for that sequence every turn: tool results, retrieved docs, plans, errors, user interruptions.

Without an explicit discipline, context grows until:

- you hit the hard window limit and truncate catastrophically;
- or, earlier, you suffer **soft failure**: instructions ignored, goals drifted, tools re-run, contradictions unresolved.

**Context engineering** is the practice of **selecting, structuring, budgeting, compressing, and evicting** tokens each turn so that the model’s conditional distribution is steered toward the behavior you want.

Anthropic’s definitional move is important: this is not “write a better system prompt once.” Prompt engineering is a subset. Context engineering is **iterative curation of the entire state the model sees**, including tools, MCP payloads, history, and memory.

Their optimization objective, paraphrased:

> Find the **smallest high-signal token set** that maximizes the likelihood of the desired outcome under architectural and cost constraints.

“Smallest” here is not aesthetic minimalism. It is a response to **diminishing returns** and **attention budget** depletion.

---

## 2.2 Formal pieces of a context

At a given model call, context typically contains some of:

| Region | Contents | Typical volatility |
| --- | --- | --- |
| System / policy | role, safety, product rules | low |
| Tool schemas | names, JSON schemas, usage notes | low–medium (versioned) |
| Static project rules | e.g. `CLAUDE.md`, style guides | low |
| Retrieved knowledge | RAG chunks, tickets, docs | high |
| Memory snippets | semantic facts, preferences | medium |
| Conversation / run history | user, assistant, tool messages | high growth |
| Scratch / plan | notes, TODO, DAG summary | medium |
| Just-in-time artifacts | file excerpts loaded on demand | high |

Engineering work is deciding **which regions exist**, **how they are ordered**, **how they are budgeted**, and **what eviction policy applies**.

---

## 2.3 Why rot happens (mechanism, not myth)

### Attention as a budget

Self-attention relates tokens to tokens. As \(n\) grows, the number of pairwise interactions grows like \(n^2\). Models can still function at long \(n\), but empirical long-context tests (needle-in-a-haystack variants, multi-hop reasoning over large histories) show **degraded retrieval and instruction-following** long before the absolute max length.

### Training and positional effects

Long contexts are partly enabled by positional interpolation / extension techniques. These let models accept longer sequences than the original training length, but position sensitivity and long-range dependency quality are not free.

### Agent-specific rot

Agents are worse than chat apps at this because **tool results are huge and repetitive**. A 30KB HTML fetch repeated across turns will drown the original goal. The failure mode looks like “the model got dumb,” but the context composition is the bug.

---

## 2.4 Budgeting: treat the window like a memory allocator

A practical production pattern is **section budgets**:

```
total_window = W
reserve_for_output_and_next_tools = R
usable = W - R

usable =
    B_system
  + B_tools
  + B_memory
  + B_retrieval
  + B_history
  + B_scratch
```

### Worked example

Suppose \(W = 128000\) tokens, you reserve \(R = 8000\) for the model’s reply and headroom.

You might allocate:

| Section | Budget | Rationale |
| --- | --- | --- |
| System + safety | 2,000 | must never be truncated first |
| Tool schemas | 3,000 | too many tools = selection noise |
| Memory | 2,000 | high-signal facts only |
| Retrieval | 4,000 | ranked top-k after rerank |
| Scratch/plan | 1,500 | durable goals inside window |
| History | 107,500 theoretically… | **but** you should not fill this |

The last line is the trap. Even if the math allows 100k of history, **you should not use it**. A tighter operational history budget (e.g. 12k–24k of *high-signal* history) often performs better than a maximal dump.

**Reserve is not optional.** Engineers who pack context to 95% full before tool results land get truncated JSON, partial tool args, or silent drops—failures that only show under load.

---

## 2.5 Selection strategies

### A. Static inclusion

Always present: safety policy, core tool list, product invariants.

Risk: mega-system-prompts that encode brittle if/else logic. Anthropic describes a **Goldilocks altitude**: specific enough to steer, not so hardcoded that the agent cannot generalize, not so vague that it assumes shared context it does not have.

### B. Pre-retrieval (classic RAG)

Before the model runs (or at the start of a turn), embed the query, fetch top-k chunks, insert them.

**Optimizes:** latency to first useful knowledge for stable corpora.
**Fails when:** the next useful query depends on intermediate discoveries (research, debugging).

### C. Just-in-time (JIT) / agentic retrieval

Give the model handles—paths, query APIs, ticket IDs—and tools to load what it needs. Claude Code’s production pattern is the canonical example: project rules may be loaded upfront, but the codebase is navigated with glob/grep/bash rather than stuffed wholesale.

**Optimizes:** freshness, progressive disclosure, avoiding stale indexes.
**Costs:** more turns, more opportunities to thrash, requires excellent tools.

### D. Hybrid

A small static core + optional pre-retrieval of high-probability needs + JIT for the long tail. This is what most serious systems converge to.

---

## 2.6 Structured vs unstructured context

Unstructured prose is flexible but low density. Structure increases **addressability** and **evictability**.

Examples of structure that help agents:

- XML or markdown sections with stable headers (`## Goals`, `## Constraints`, `## Evidence`);
- typed memory records (`{fact, confidence, source, as_of}`);
- tool results as `{ok, data, error, data_ref}` rather than free text blobs;
- plans as checklists or DAGs, not paragraphs.

Anthropic still recommends clear sectioning for system prompts. Exact markup matters less as models improve; **clarity and separation of concerns** still matter.

---

## 2.7 Compression family: three different operations

People say “summarize the context” for three different mechanisms. Separate them.

### 1) Summarisation (lossy rewrite)

A model rewrites history into a shorter narrative.

- **Good for:** conversational continuity, UX threads.
- **Bad for:** precise constraints, numbers, security boundaries—unless the summary prompt is carefully evaluated for recall of those items.

### 2) Compaction (production long-horizon pattern)

As used in Claude Code-style systems: when approaching a limit, compress the trace into a high-fidelity summary, then **re-seed a new window** with:

- the summary;
- critical pinned artifacts (e.g. recently touched files, active plan);
- enough recent turns to keep local coherence.

Anthropic’s tuning advice: first maximize **recall** of what the compaction must keep, then improve **precision** by removing fluff. Over-aggressive compaction creates mysterious regressions hours into a task.

### 3) Tool-result clearing (cheap eviction)

Old tool payloads are replaced with placeholders once the model has had a chance to use them. Knobs in first-party platforms look like `trigger` (when clearing starts) and `keep` (how many recent tool results remain).

This is often the **highest ROI** lever: tool results are huge, and re-fetching is often cheap compared with re-paying attention over giant blobs every turn.

```
Before clearing:  [sys][tools][goal][t1 BIG][t2 BIG][t3 BIG][t4 BIG]
After clearing:   [sys][tools][goal][t1 cleared][t2 cleared][t3 BIG][t4 BIG]
```

---

## 2.8 Prioritisation under pressure

When something must go, drop in reverse priority of risk:

1. **Never drop first:** safety, permissions, stop conditions, current goal.
2. **Drop late:** recent observations that change the plan, active errors.
3. **Drop earlier:** raw tool payloads already reduced to conclusions; duplicate retrievals.
4. **Drop eagerly:** verbose debug, repeated searches, SEO junk, stale plans superseded by a newer plan.

A concrete policy used in production-ish assemblers:

- pin messages tagged `pin:true`;
- clear tool results older than K steps;
- summarize episodic history older than T minutes of run time;
- re-retrieve memory fresh each turn rather than leaving old memory snippets forever.

---

## 2.9 Context pollution and staleness

### Pollution

The window contains tokens that actively **mis-steer** the model:

- contradictory instructions from different prompt layers;
- retrieved docs that are topically similar but wrong;
- tool errors misinterpreted as domain facts;
- multi-agent chatter that is not decision-relevant;
- prompt injection text inside tool results (“ignore previous instructions…”).

Pollution is worse than emptiness. Empty context yields uncertainty; polluted context yields confident wrong action.

### Staleness

Tokens that were true when written but false now:

- index not rebuilt after doc update;
- memory fact not superseded;
- DOM snapshot from three navigations ago;
- plan steps completed but still listed as TODO.

**Mitigations:** timestamps + `as_of` fields, re-fetch instead of reusing blobs, explicit invalidation APIs, “prefer tools over memory when live state matters.”

---

## 2.10 Lifecycle across the agent loop

Write the policy as a function, not a vibe:

```text
C_{t+1} = Assemble(
  pin = system + tools_active + goal + policy,
  memory = Retrieve(tenant, query=goal_and_recent),
  history = Evict(history_t, rules),
  observations = Format(tool_results_t),
  scratch = UpdatePlan(scratch_t, model_notes_t)
)
```

Every production team eventually invents this function. The ones who invent it explicitly can test it.

---

## 2.11 Production debugging of context failures

### Symptoms

- Agent repeats the same tool call with tiny variations.
- Ignores an instruction present “somewhere above.”
- Contradicts itself across turns.
- Performance collapses after step ~N while early steps looked great.
- Quality improves when you **manually** delete half the history (smoking gun for pollution/rot).

### Diagnosis procedure

1. **Export the exact model payload** for the failing turn (not a UI paraphrase).
2. Build a **token composition histogram**: system %, tools %, retrieval %, history %, tool results %.
3. Diff successful vs failing runs: what new region dominated?
4. Ablate: clear old tool results; remove retrieval; shrink tools list; pin only goal+last observation.
5. Check for injection patterns in tool/retrieval text.
6. Verify compaction prompt recall on a held-out long trace (did it keep the constraint that later mattered?).

### Instrumentation you want in the runtime

- token counts per section per turn;
- eviction events (what was cleared);
- retrieval IDs and ranks;
- compaction events with before/after hashes;
- model/tool/prompt version pins for the run.

Without this, you will argue about prompts while the real bug is a 40k HTML blob.

---

## 2.12 Approaches and trade-offs (context-specific)

| Approach | Optimizes | Latency | $ | Reliability | Best for | Wrong for |
| --- | --- | --- | --- | --- | --- | --- |
| Stuff everything | engineering speed | poor | poor | collapses at scale | tiny demos | production agents |
| Big window only | less eviction code | med-poor | poor | soft rot remains | short tasks with large single docs | long multi-tool runs |
| Aggressive summary every turn | bounded size | extra model call | med | lossy errors | chat UX | precise tool workflows |
| Tool-result clearing | bounded size cheaply | good | good | needs re-fetch tools | tool-heavy agents | when results are non-refetchable secrets |
| JIT file/API retrieval | freshness, density | more turns | variable | depends on tool quality | code, live systems | ultra-low-latency single shot |
| Subagent with summary return | isolate exploration | parallel wall-clock better | high tokens | coordination cost | broad research | tightly coupled sequential edits |

---

## 2.13 Common misconceptions

1. **“The model will ignore irrelevant tokens.”** It might; it often won’t. Irrelevant tokens still consume attention budget.
2. **“RAG is context engineering.”** RAG is one retrieval strategy inside context engineering.
3. **“Summaries are always safer than truncation.”** Bad summaries silently delete constraints. Truncation at least fails more obviously sometimes.
4. **“More tools in the schema is more capable.”** More tools often means worse selection and more schema tokens every turn.
5. **“Compaction is just zipping text.”** Compaction is a **learned lossy codec** for agent state; it needs eval.

---

## 2.14 Scale effects

At low volume, context assembly is a function in your server.

At multi-tenant high volume:

- assembly becomes a **service** with caching (tool schema renders, memory retrieval, embedding);
- per-tenant budget accounting matters (noisy neighbor burns $);
- privacy requires redaction before logs and sometimes before model calls;
- prompt/tool versions must be pinned per in-flight run so deploys do not rewrite the world mid-thought (see Anthropic Research “rainbow deploy” lesson).

---

## 2.15 Mini exercise (do this on a real trace)

Take one failing agent run from any project (or greppa chat/tools if available).

1. Count tokens by section for the last 5 model calls.
2. Identify the largest low-signal region.
3. Propose an eviction rule that would have removed it without deleting the goal.
4. Predict one regression your rule might cause; add a pin exception.

Next: `03_persistent_memory.md`.


---

# 3. Persistent Agent Memory

> Production anchors: Anthropic structured note-taking / memory tool patterns; LangGraph checkpointer vs BaseStore; Claude Code notes across compaction boundaries.

## 3.1 The problem memory exists to solve

Context is **ephemeral working memory**. When the window is compacted, cleared, or a new session starts, tokens disappear.

Persistent memory is any store **outside the window** with:

1. a **write policy** (what is worth saving);
2. a **retrieval policy** (what is worth loading next time);
3. a **scope/isolation model** (who can see it);
4. a **lifecycle** (update, conflict, forget, export, delete).

If any of those four is missing, you do not have memory architecture—you have a junk drawer or a security incident waiting to happen.

---

## 3.2 Cognitive labels → engineering systems

The field borrows psychology vocabulary. It is useful **only if** you map labels to storage and APIs.

| Label | Question it answers | Typical implementation | Write pattern |
| --- | --- | --- | --- |
| **Working memory** | What am I operating on *right now*? | context window + scratchpad | continuous |
| **Episodic memory** | What happened in this run/session? | event log, traces, session summaries | append-only |
| **Semantic memory** | What durable facts/preferences exist? | KV, document store, vector+metadata, knowledge graph | upsert + conflict rules |
| **Procedural memory** | How should this agent do recurring work? | skills, playbooks, refined tool heuristics, versioned prompts | versioned publish |

### LangGraph’s practical split (do not confuse these)

- **Checkpointer / thread state:** short-term continuity for a conversation or graph run (resume mid-thread). This is **execution + dialogue state**, not “knowledge of the user forever.”
- **Store (BaseStore):** cross-thread long-term items, often namespaced by user/assistant.

Teams routinely say “we added memory” when they only enabled a checkpointer. That helps multi-turn chat; it does **not** create durable semantic knowledge.

---

## 3.3 Working memory in agents

Working memory is mostly **context engineering** (previous file). The persistent angle is **scratch externalization**:

- a `NOTES.md` / plan object the agent rewrites;
- a structured TODO list;
- Anthropic’s examples: Claude Code todos; Pokémon agent tallies and maps that survive context resets.

**Why write scratch outside the window?** Because compaction will smash free-form history. A small structured artifact is cheaper to reload than hoping the summary kept “Pikachu needs 2 more levels.”

Design rule: **scratch should be short, authoritative, and rewritten in place**, not an infinite append log.

---

## 3.4 Episodic memory

Episodes are **what happened**.

Examples:

- “User attempted refund; bank returned code Z”;
- “Worker B found filing URL X”;
- “Migration step 4 failed on index create.”

### Why keep episodes?

- debugging and audit;
- session continuity after summary;
- training data for later procedural improvements;
- evidence for semantic extraction.

### Why not treat episodes as the only memory?

Full transcripts do not scale as retrieval units. They are low density, privacy-heavy, and hard to conflict-resolve. Production systems usually:

1. store episodes in cold/append form;
2. extract semantic candidates;
3. retrieve episodes only when the agent needs narrative detail (“what exactly did we try?”).

---

## 3.5 Semantic memory

Semantic memory is **distilled belief about the world or user**.

Examples:

- “Customer prefers PDF reports.”
- “Prod cluster is `us-east-1`, not `eu-west-1`.”
- “Library X is deprecated in this monorepo.”

### Write pipeline (this is the real product)

```
signal (dialogue, tool result, doc)
  → candidate extraction (model or rules)
  → validation (schema, PII policy, confidence)
  → scoping (tenant/user/project/agent)
  → conflict resolution
  → persist + index
  → (optional) human review for high-impact facts
```

### Conflict resolution strategies

| Strategy | Behavior | Use when |
| --- | --- | --- |
| Last-write-wins | newest replaces old | low stakes preferences |
| Evidence-weighted | keep higher confidence / better source | research facts |
| Multi-value | store competing values with provenance | uncertain domains |
| Human gate | require approval | security, compliance, billing facts |
| Time-versioned | facts have `valid_from`/`valid_to` | anything that changes |

Last-write-wins is the default people implement and the default that corrupts multi-agent systems (workers overwrite each other with partial views).

---

## 3.6 Procedural memory

Procedural memory is **how to act**, not what is true.

Examples:

- a skill: “when running integration tests in repo R, use command C”;
- a tool-description improvement discovered from failures (Anthropic’s tool-testing agent rewriting MCP descriptions);
- a playbook: “refund flow requires steps A→B→C and approval if amount > N.”

Procedural memory should be **versioned** like code. Hot-editing procedural text under the agent’s feet mid-run is a deploy hazard.

---

## 3.7 Retrieval policies

Writing without retrieval policy is hoarding.

Common policies:

1. **Recency** — last K session notes (chat tone, short-term preferences).
2. **Semantic similarity** — embeddings over facts/chunks.
3. **Hybrid** — BM25 + vectors + rerank (usually better than vectors alone).
4. **Structured filters first** — `tenant_id=… AND entity_id=…` then rank.
5. **Agent-directed query** — model rewrites the memory query (powerful, can thrash).
6. **Graph expansion** — from entity to related entities (CRM, code symbols).

### Quality identity

```
memory_quality ≈ correctness × retrieval_precision × freshness × scope_correctness
```

High recall of wrong or out-of-scope items is actively harmful (context pollution).

---

## 3.8 Forgetting, compression, consolidation

Human memory metaphors are fine; engineering mechanisms matter:

- **TTL / decay:** unused episodic detail expires.
- **Consolidation job:** offline process merges duplicates, promotes stable episodic patterns into semantic facts, archives raw episodes.
- **Active delete:** user “forget this” and GDPR erasure must remove primary store **and** indexes **and** caches.
- **Compaction of notes:** rewrite `NOTES` to current truth, do not append infinitely.

Forgetting is a product feature, not only a storage optimization. Agents that never forget become wrong and creepy.

---

## 3.9 Isolation and multi-tenancy

Scope keys are security boundaries.

Example key layout:

```
tenant/{tenant_id}/user/{user_id}/facts/{fact_id}
tenant/{tenant_id}/project/{project_id}/procedures/{proc_id}
tenant/{tenant_id}/shared/glossary/{term_id}
agent/{agent_version}/skills/{skill_id}   # global product skills, not tenant data
```

Failure modes:

- missing `tenant_id` in query → cross-tenant leakage;
- agent skills index mixed with customer content → data exfiltration via “helpful” retrieval;
- shared org memory without ACLs → confidential project bleed.

**Test these like you test auth.** Memory is an access-control problem wearing an AI costume.

---

## 3.10 Durable storage choices

| Store | Strength | Weakness | Fits |
| --- | --- | --- | --- |
| Postgres rows | transactions, ACLs, audit | semantic search needs add-ons | facts, scopes, effects |
| Object storage + pointers | large artifacts | query poor alone | transcripts, HTML, PDFs |
| Vector DB | similarity | updates/deletes/filtering discipline | chunk retrieval |
| Files in workspace | agent-native, simple | multi-tenant SaaS hard | coding agents, single-user |
| Graph DB | relations | extraction quality critical | entity-heavy domains |

Serious systems often use **two layers**: transactional system of record + retrieval index derived from it.

---

## 3.11 Memory vs checkpoint vs RAG (disambiguation table)

| System | Purpose | Survives new session? | Typical query |
| --- | --- | --- | --- |
| Context window | immediate reasoning | no | n/a |
| Checkpoint | resume a run/graph | run continuity, not knowledge | by run_id/thread_id |
| RAG over docs | enterprise knowledge | yes (docs) | by similarity to question |
| Semantic memory | durable beliefs about user/world | yes | by user+topic |
| Episodic log | what we did | yes | by time/run |

---

## 3.12 Approaches and trade-offs

| Approach | $ | Complexity | Quality control | When |
| --- | --- | --- | --- | --- |
| Transcript only | low eng / high tokens | low | poor | prototypes |
| Rolling summary | low | low | medium lossy | consumer chat |
| “Embed everything said” | high storage | med | pollution risk | rarely correct alone |
| Typed fact store + episodic cold log | med | higher | high if disciplined | multi-tenant products |
| Agent-written NOTES files | low | low | depends on agent | coding / personal agents |
| Knowledge graph extraction | high | high | brittle extraction | complex entity domains |

---

## 3.13 Failure modes (memory-specific)

1. **Silent wrong fact** — high confidence retrieval of outdated preference → wrong action.
2. **Write thrash** — model writes near-duplicates every turn → retrieval returns clutter.
3. **Scope bug** — missing tenant filter.
4. **PII accretion** — memory extractor stores secrets from tool results into long-term store.
5. **Consolidation corruption** — offline job merges two different entities into one.
6. **False sense of continuity** — checkpointer resumes chat but semantic store empty; users say “it forgot me” after “memory launch.”

---

## 3.14 What good looks like in production

- Every memory read/write is traced with scope keys (redacted content in ops tools).
- Extractors have precision targets; you measure garbage write rate.
- Users can list/delete what is stored about them.
- Live system state (balances, locks, inventory) is **not** primarily trusted to semantic memory—tools are.
- Long-horizon agents reload a short authoritative plan artifact after every compaction.

Next: `04_tool_calling.md`.


---

# 4. Tool-Calling Agents at Production Scale

> Production anchors: Anthropic *Building effective agents* (tool ACI), multi-agent research (parallel tools, tool description rewriting), OpenAI function calling + Agents SDK.

## 4.1 Core idea

A tool-calling agent is not “a model that can use plugins.” It is a **loop**:

1. model emits a **structured intent** to invoke one or more tools;
2. host **validates** and **authorizes** the intent;
3. host **executes** with timeouts and resource limits;
4. host returns **observations** as tokens (or references) into the next context;
5. repeat until terminal output or budget kill.

Anthropic’s short definition of agents—**LLMs autonomously using tools in a loop**—is the right unit of thought.

---

## 4.2 Tool schemas are the API surface (ACI)

Anthropic explicitly compares tool design to HCI and calls the discipline **ACI (agent–computer interface)**.

A tool definition typically includes:

- name;
- natural language description (when to use / when not to);
- JSON Schema for arguments;
- (implicit) return shape;
- (in serious systems) auth scopes, side-effect class, idempotency, timeout defaults.

### Why schema quality dominates prompt cleverness

The model’s policy is heavily shaped by the tool list. If two tools overlap, you created an ambiguous decision boundary. Anthropic’s observation: if a **human engineer** cannot say which tool to use, the model will not reliably do better.

They report large gains from **rewriting tool descriptions after watching failures**—including an automated tool-testing agent that exercises bad MCP tools and revises descriptions (~40% faster task completion in their account).

### Design rules that show up in production

1. **Minimal viable tool set** for a mode/role—not the entire company API catalog.
2. **Non-overlapping responsibilities.** Prefer `search_docs` vs `search_tickets` over one mega-`search`.
3. **Poka-yoke arguments.** Absolute paths beat relative paths after `cd` (SWE-bench tooling lesson). Enums beat free-form strings for control flow.
4. **Token-efficient returns.** Return summaries + `data_ref` handles for large payloads; let the agent fetch detail JIT.
5. **Errors as structured data.** `{ok:false, error_type, message, retryable}` beats a stack trace novel—or worse, empty string.

---

## 4.3 Tool discovery and selection

### Static registration

Tools array attached to the model call. Simple, cacheable, auditable.

### Dynamic discovery (MCP and friends)

Servers expose tools at runtime. Powerful for ecosystems; dangerous for quality variance. Anthropic notes MCP compounds description quality problems because agents encounter tools with uneven docs.

### Selection mechanisms

- model chooses among listed tools (default);
- router narrows tool set by intent class before the agent loop;
- permission layer removes tools the identity cannot use (so the model never “tempted”).

**Important:** removing a tool from the schema is a stronger control than writing “do not use X” in prose.

---

## 4.4 Argument validation

Validation layers (all useful):

1. **JSON Schema / strict structured outputs** — syntactic and type constraints;
2. **Application validators** — checksums, allowlists, path sandboxes, amount limits;
3. **Policy engine** — OPA-style rules on who can do what in which environment;
4. **Dry-run** — for infra, show diff before apply.

Never execute side effects on unvalidated args. Model confidence is not input validation.

---

## 4.5 Sequential vs parallel execution

### Sequential

Simple; preserves dependencies; easier debugging; higher wall-clock.

### Parallel

Independent tool calls in one turn (or fan-out across subagents). Anthropic Research reported up to ~**90% wall-clock reduction** on complex research by combining parallel subagents and parallel tool calls.

### Host-side programmatic loops

Sometimes the right move is: model proposes a query plan, host runs 500 fetches in code, returns aggregate stats. This keeps giant intermediates out of context (Claude Code analyzing data via bash head/tail style).

| Pattern | Wall-clock | Context risk | Failure complexity |
| --- | --- | --- | --- |
| Sequential tools | high | medium | low |
| Parallel tools | low | medium | medium (partials) |
| Programmatic bulk | low-med | low | medium (engineering) |
| Subagent fan-out | low | low per agent / high total tokens | high |

---

## 4.6 Retries, idempotency, timeouts

### Timeouts

Always set:

- per-tool timeout;
- per-turn wall clock;
- per-run budget (steps, tokens, $).

Hanging tools hold workers and multiply cost.

### Retries

Retry only when:

- error is **transient** (429, 503, network blip);
- operation is **idempotent** or guarded by an idempotency key;
- you have **backoff + jitter** and a max attempt count.

### Idempotency

For any non-read tool that matters:

```
idempotency_key = hash(tenant, tool_name, canonical_args, optional_user_intent_id)
```

Store outcomes in an **effect table**. On retry, return the original effect instead of creating a second refund.

**The classic outage:** timeout after the provider side succeeded; naive retry creates duplicates. This is distributed systems 101 applied to agents.

### Partial failures

If 5 parallel tools run and 2 fail, the observation must show **per-call status**. Aggregating into a single “done” is a lie that models will believe.

---

## 4.7 Permissions and side-effect classes

Classify tools:

| Class | Examples | Default policy |
| --- | --- | --- |
| Pure read | get ticket, search docs | broad allow |
| Soft write | draft email, create private note | allow with audit |
| Hard write | refund, delete, deploy | step-up auth / approval |
| Dangerous | shell, browser to arbitrary URL, admin APIs | sandbox + allowlist + human |

Map classes to IAM roles / capability tokens. The agent runtime should hold **least privilege**, not your personal admin key.

---

## 4.8 Observability for tools

Minimum fields per tool invocation:

- run_id, turn_id, tool_call_id
- tool name + schema version
- redacted args
- start/end, latency
- status, error class
- response size (bytes/tokens)
- idempotency key hit?
- downstream status codes

Anthropic’s multi-agent production story emphasizes that without tracing, user reports like “it couldn’t find obvious information” are undiagnosable—was it query quality, source selection, or tool failure?

---

## 4.9 Cost and latency budgeting

Tools affect budgets in two ways:

1. **direct latency/cost** of the tool;
2. **context cost** of stuffing the result into future turns.

A slow browser screenshot that also injects 5k vision tokens is a double tax.

Budget patterns:

- max tool calls per run;
- max parallel width;
- max response bytes before forced `data_ref`;
- separate rate limits per tool class;
- circuit breakers when a dependency’s error rate spikes.

---

## 4.10 Failure modes (tooling)

1. **Wrong tool loops** — ambiguous registry.
2. **Schema too clever** — model cannot produce args (overly nested, exotic formats).
3. **Return payload bloat** — context rot accelerator.
4. **Non-idempotent retry** — duplicated side effects.
5. **Permission confused deputy** — tool uses server credentials broader than user.
6. **Tool result injection** — malicious page/doc content influences later tool choice.
7. **Sync fan-out bottleneck** — lead waits on slowest worker (Anthropic Research limitation they discuss).

---

## 4.11 Approaches comparison

| Approach | Reliability | Latency | $ | Complexity | When |
| --- | --- | --- | --- | --- | --- |
| Few hard-coded tools | high | med | med | low | early product |
| Large open tool catalog | low-med | var | high | high | only with routing/search over tools |
| MCP ecosystem tools | variable | var | var | med | internal trusted servers first |
| Code-execution tool (sandbox) | high leverage | var | var | high security needs | data analysis, transforms |
| Browser-as-tool | flexible | high | high | high | no API available |

Next: `05_structured_typed_agents.md`.


---

# 5. Structured / Typed Agents

> Production anchors: OpenAI Structured Outputs & function calling docs; Anthropic tool-use patterns; schema-first handoffs in multi-agent systems.

## 5.1 The problem

Natural language is an excellent **human** interface and a poor **machine boundary**.

If your agent’s “API” to tools, workers, workflows, and billing systems is free-form prose, you will spend your life writing brittle parsers and handling creative formatting. Production agents need **typed boundaries** at every place where software will act.

---

## 5.2 The constraint stack (stop collapsing these terms)

These are different layers. Industry slides often pretend they are synonyms.

### Layer 0 — Prompted shape

“Please respond in JSON with keys …”

- **Guarantee:** social pressure on a stochastic model.
- **Use:** prototypes only.

### Layer 1 — JSON mode

Model is constrained to emit valid JSON *syntax*.

- **Guarantee:** parseable JSON value.
- **Not guaranteed:** required keys, enums, types, absence of extra fields.

### Layer 2 — Function / tool calling

Model emits a named tool invocation plus arguments (often JSON).

- **Guarantee:** depends on provider; increasingly schema-checked.
- **Role:** action interface, not necessarily final user answer format.

### Layer 3 — Structured outputs / constrained decoding

Generation is restricted so that outputs conform to a JSON Schema (token masking / grammar constraints). OpenAI’s Structured Outputs is the widely known API form; libraries like Outlines implement similar ideas for open models.

- **Guarantee:** schema adherence (within the supported schema fragment).
- **Not guaranteed:** business correctness (“amount > balance” still needs app logic).

### Layer 4 — Application validation

Pydantic/Zod/domain rules after parse: checksums, referential integrity, authz.

### Layer 5 — Repair loops

On validation failure, re-prompt with errors or run deterministic repair.

- **Useful for:** complex constraints not expressible in schema.
- **Dangerous as sole control for money/infra:** can loop, can be jailbroken, is non-deterministic.

---

## 5.3 Why typed agents exist beyond “JSON is nice”

Typed boundaries enable:

1. **Safe execution** — do not call refund without a validated `PaymentIntent`.
2. **Multi-agent contracts** — worker returns `FundingEvent[]`, not an essay.
3. **Streaming UX** — event envelopes (`progress`, `tool_start`, `final`) with known shapes.
4. **Eval** — automatic scoring of structured fields.
5. **Schema evolution** — versioned contracts like real APIs.

Anthropic’s multi-agent research appendix recommends external artifacts and structured returns to reduce “telephone” loss. That is a typing/architecture point, not a prose point.

---

## 5.4 Schema design for agents

### Prefer closed control sets

```json
{
  "action": { "enum": ["search", "draft", "escalate", "finish"] },
  "query": { "type": "string" }
}
```

Better than free-form `action` strings the host must interpret.

### Separate human channel from machine channel

Bad:

```json
{ "response": "Sure! I'll refund $12.13 to acct..." }
```

Better:

```json
{
  "assistant_speech": "I can refund that now.",
  "intent": {
    "type": "refund",
    "amount_cents": 1213,
    "currency": "USD",
    "order_id": "ord_..."
  }
}
```

Speech can be approximate; intent must be exact.

### Avoid formats that fight tokenization / planning

Anthropic’s SWE-bench tooling notes: making the model keep accurate line counts for diffs, or JSON-escape large code blocks, increases error rates. Prefer formats close to what models see naturally in training data when possible.

### Make illegal states hard to represent

If a tool always needs either `issue_id` or `search_query`, encode a schema that forbids empty both (as supported by your constrained decoding features). Where not supported, validate in app code.

---

## 5.5 Validation, repair, retries

Recommended pipeline:

```
model output
  → constrained decode (if available)
  → JSON parse
  → schema validate
  → domain validate
  → (optional) repair once/twice with error feedback
  → fail closed (ask user / safe fallback)
```

**Repair budget:** cap attempts. Infinite repair is a cost and safety hazard.

**Fail closed vs fail open:** for reads, degrade; for writes, stop.

---

## 5.6 Streaming structured data

Challenges:

- partial JSON is not valid JSON;
- UI wants incremental tokens;
- tools need complete args before execution.

Patterns:

1. **Stream speech, buffer intent** until schema-complete.
2. **NDJSON event stream** where each line is a small complete object.
3. **Incremental parsers** with explicit `partial` states (do not execute on partial).
4. **Two-phase:** model streams plan text; final message is structured only.

---

## 5.7 Schema evolution

Treat schemas like public APIs between:

- model ↔ host
- host ↔ tools
- lead ↔ workers
- agent ↔ workflow engine

Rules of thumb:

- additive optional fields first;
- dual-read old/new during rollout;
- pin schema version on long-running runs (rainbow deploys);
- contract tests in CI with golden model outputs and adversarial cases.

Breaking a required field mid-flight is a classic “deploy broke agents” outage.

---

## 5.8 Approaches and trade-offs

| Approach | Guarantee | Latency | Cost | Complexity | Use |
| --- | --- | --- | --- | --- | --- |
| Prompted JSON | weak | low | low | low | never for side effects |
| JSON mode | syntax | low | low | low | low-risk parsing aids |
| Tool calling | action-oriented | low-med | low-med | med | default agent actions |
| Strict structured outputs | schema | slight overhead | low-med | med | boundaries that must not drift |
| Grammar-constrained DSL | very strong for DSL | med | med | high | SQL/plan DSLs |
| Validate + repair | business rules | +turns | +$ | med | secondary layer |

---

## 5.9 Misconceptions

1. **“Structured outputs make the agent truthful.”** They make it **well-formed**, not correct.
2. **“One schema for the whole agent is enough.”** Different stages need different schemas (plan vs tool vs final answer vs handoff).
3. **“If strict mode is on, I can skip app validation.”** Schema ≠ policy ≠ authz.

Next: `06_long_horizon_agents.md`.


---

# 6. Long-Horizon Agents

> Production anchors: Anthropic long-horizon context techniques; LangGraph checkpoints/interrupts; Temporal durable execution engineering posts; the “checkpoints ≠ durable execution” distinction.

## 6.1 What “long-horizon” means

A task is long-horizon when at least one of these is true:

- token demand exceeds a single high-quality context window;
- wall-clock spans minutes to days;
- process restarts are likely before completion;
- human approval gaps idle longer than a request timeout;
- the plan itself must change as new evidence arrives.

Examples: large repo migrations, multi-source due diligence, infra rollouts, multi-day browser back-office work.

---

## 6.2 Goal decomposition and planning structures

### Flat todo lists

Simple, agent-native, works surprisingly far (Claude Code style). Weak on complex dependencies.

### DAG planning

Nodes are tasks; edges are dependencies. Independent branches parallelize. Good for orchestrators.

```
           [crawl sources]
            /     |     \
      [companyA][B][C]
            \     |     /
           [synthesize]
                |
            [citations]
```

### Hierarchical planning

- **Layer 1:** stable milestones (“migrate auth,” “migrate billing”).
- **Layer 2:** local plans that can be thrown away and rebuilt.
- Prevents thrashing the entire strategy when a leaf fails.

### Plan mutation

Long-horizon agents must **replan**. A frozen plan with new contradictory evidence is how agents dig trenches.

Represent plans as data:

```python
Plan = {
  "goal": str,
  "milestones": [ { "id", "status", "tasks": [Task] } ],
  "assumptions": [str],
  "open_questions": [str],
}
```

Update statuses from tool observations, not from vibes.

---

## 6.3 Checkpointing vs durable execution (critical distinction)

This is one of the most important production concepts in Phase 1.

### Checkpointing (e.g. LangGraph checkpointer)

- Saves **state snapshots** between graph steps / turns.
- Great for: resume *if something restarts you*; time-travel debugging; human interrupt state.
- Not automatically: crash detection, worker failover, timers that survive process death, multi-day sleeps without a hot process.

### Durable execution (e.g. Temporal and similar systems)

- Persists **event history** of the workflow.
- Runtime **resumes execution** after worker death.
- Activities have retry policies; timers are first-class; human waits do not require holding a thread.

Engineering slogan from Temporal-adjacent writing:

> **Checkpoints are durable data. Durable execution is durable control flow.**

Many teams discover this after their first production crash leaves “perfectly saved state” and zero progress.

### Intra-node loss

Even with graph checkpoints, a crash **inside** a long node (a Python loop of 10k items) loses intermediate work unless you checkpoint at finer granularity or push work into activities/tasks.

---

## 6.4 Idempotency and replay

On resume, the system may re-enter a step that already had side effects.

Therefore:

1. Side-effecting tools need **idempotency keys** or durable “done” markers.
2. Pure LLM calls may be **recorded** so replay doesn’t rebill and diverge (workflow engines do this via history).
3. Non-deterministic branching should be made explicit and stored.

If you resume naively without these, you get double deploys, double emails, corrupted migrations.

---

## 6.5 Recovery after crashes

Minimum viable recovery loop:

```
on_worker_start:
  for run in claimable_incomplete_runs():
      state = load_checkpoint(run.id)
      if state.version not in supported_versions: quarantine
      else: continue_agent(run.id, state)
```

Better: a workflow engine owns claim/lease/heartbeat.

**Quarantine** matters: after a breaking schema deploy, old runs may be unresumable without an adapter.

Anthropic Research discusses **rainbow deployments** so in-flight agents are not forced onto incompatible prompt/tool versions mid-run.

---

## 6.6 Human-in-the-loop as a durable state

Approvals are not `input()` in a server request.

They are:

- a workflow signal;
- a record in an approvals table;
- a UI that can happen hours later;
- a timeout policy (auto-deny / escalate).

LangGraph `interrupt()` paired with a persistent checkpointer is one agent-native approach; Temporal signals are the general-purpose approach. Either way, **do not hold an HTTP request open for a human.**

---

## 6.7 Context techniques for long horizons

From Anthropic context engineering work:

1. **Compaction** across window boundaries.
2. **Structured note-taking** for goals/progress.
3. **Subagents** so exploration does not pollute the lead’s window.
4. **JIT retrieval** of artifacts by reference.

Long-horizon is where context engineering and durable execution meet. One without the other still fails: perfect resume of a polluted 180k context is still a bad agent; perfect clean context with no resume dies on the first OOM.

---

## 6.8 Evaluation of hours/days tasks

You cannot only measure final answer string match.

Measure:

- milestone completion rates;
- percent of runs that resume successfully after injected kill -9;
- duplicate side-effect rate under retry storms;
- human approval wait times and expiry behavior;
- cost distribution tails (p95/p99 $ per run);
- plan stability (how often root goal flips—can indicate thrash).

Anthropic notes **end-state evaluation** for agents that mutate state: judge whether the final environment is correct, not whether the path matched a golden trajectory.

---

## 6.9 Approaches and trade-offs

| Approach | Survives crash? | Idle human wait cost | Complexity | When |
| --- | --- | --- | --- | --- |
| In-process loop | no | holds worker | low | PoC |
| DB checkpoint + cron resume | if you build it | low | med | small prod |
| Agent graph checkpointer | state yes / exec DIY | low-med | med | agent-centric apps |
| Durable execution engine | yes | low (timers) | higher platform | mission-critical |
| Manual operator restart | technically yes | high human $ | low eng | not a strategy |

Next: `07_multi_agent_systems.md`.


---

# 7. Multi-Agent Systems

> Primary production source: Anthropic *How we built our multi-agent research system* (2025); also Anthropic *Building effective agents* (orchestrator-workers pattern); OpenAI Agents SDK handoffs.

## 7.1 When multi-agent is a real architecture (not theater)

Calling two prompts “Agent A” and “Agent B” is not multi-agent architecture.

Multi-agent systems earn their keep when:

1. work is **parallelizable** into weakly coupled strands;
2. a single context cannot hold the exploration residue;
3. specialization (tools/prompts/models) improves quality;
4. the **task value** justifies roughly an order-of-magnitude token premium.

Anthropic’s Research production system:

- orchestrator-worker pattern;
- lead plans, spawns subagents, synthesizes;
- internal eval: Opus lead + Sonnet workers beat single Opus by **~90%** on their research eval;
- cost: agents ~4× chat tokens; multi-agent ~15× chat tokens;
- best fit: breadth-first research; weaker fit: many coding tasks with tight coupling and poor real-time coordination.

Their BrowseComp analysis takeaway is sobering and useful: a lot of the gain is from **spending enough tokens** with enough tool calls, amplified by stronger models—not mystical emergent society.

---

## 7.2 Core topologies

### Coordinator / worker (orchestrator-workers)

```
        Lead
     /   |   \
   W1   W2   W3
     \   |   /
      synthesize
```

**Ownership:** lead owns goal decomposition and final synthesis; workers own local exploration.
**Failure boundary:** worker failures should return structured errors; lead replans.
**Scaling:** width of fan-out; sync lead becomes bottleneck (Anthropic called this out).

### Supervisor / subagent

Subagents report only upward; no peer chat. Simpler reasoning about information flow. Claude Code subagents typically fit this mental model.

### Peer teams / agent teams

Agents share a task list, claim work, message each other. Higher coordination power, higher deadlock/chatter/race risk. Treat as experimental unless you have strong contracts.

### Fan-out / fan-in

Map-reduce for agents. Fan-in needs an explicit reduce schema.

### Handoff chains

Ownership transfers: triage → specialist → closer. Each agent has different tools/permissions. OpenAI Agents SDK popularized ergonomic handoffs; the deep requirement is a **handoff contract**, not a vibe.

### Pipeline specialists

Fixed stages (research → draft → cite → redact). More workflow than agent, often more reliable.

---

## 7.3 Handoff contracts

A handoff should look like an API:

```json
{
  "contract_version": "handoff.v2",
  "from_agent": "triage",
  "to_agent": "billing_specialist",
  "goal": "Resolve double charge on invoice 1842",
  "user_id": "u_...",
  "accepted_tools": ["get_invoice", "create_refund_draft"],
  "forbidden_tools": ["wire_transfer"],
  "evidence_refs": ["s3://.../invoice.json"],
  "success_criteria": ["user confirms", "refund_draft created or reason recorded"],
  "budget": { "max_steps": 12, "max_usd": 0.4 }
}
```

Without this, multi-agent systems degrade into telephone games.

Anthropic appendix recommendation: workers write **artifacts to storage** and pass **references**, not only natural language summaries, to avoid fidelity loss.

---

## 7.4 Shared state vs message passing

| Mechanism | Pros | Cons |
| --- | --- | --- |
| Shared blackboard DB | simple visibility | write races, pollution |
| Message queues | clear async boundaries | harder global snapshot |
| Single-writer lead state | easier consistency | lead bottleneck |
| Artifact store + refs | high fidelity, cacheable | need lifecycle GC |

For most production research/coding multi-agents, **artifact store + single-writer lead** is the sane default.

---

## 7.5 Task ownership and synchronization

Problems you will hit:

- two workers claim the same subtask;
- worker dies after claim without heartbeat;
- lead spawns 50 workers for a trivial ask (Anthropic early failure mode);
- workers duplicate searches because briefs were vague (“research semiconductors”).

Fixes:

- lease/heartbeat on tasks;
- structured worker briefs (objective, bounds, sources, output schema, budget);
- **effort scaling rules** in the lead prompt (1 agent for factoid; 2–4 for comparison; many only for hard breadth);
- dedupe keys for search queries where appropriate.

---

## 7.6 Failure propagation, circuit breakers, degradation

Child failure modes:

1. **Retry child** with same brief.
2. **Rebrief child** with tighter instructions.
3. **Spawn alternative specialist.**
4. **Continue with partial** and declare gaps.
5. **Abort run** if dependency is critical.

Circuit breakers:

- if web search error rate > threshold, stop spawning search workers; switch mode.
- if cost burn > budget curve, freeze fan-out.

Graceful degradation examples:

- return partial research with explicit missing sections;
- fall back to single-agent mode;
- fall back to non-browser tools when browser pool exhausted.

---

## 7.7 Observability: boundary tracing

You need a trace tree:

```
user_request
  lead.plan
    workerA.search
    workerA.fetch
    workerB.search
  lead.synthesize
  cite.run
  respond
```

Metrics by agent role: tokens, tool errors, duplicate query rate, time-to-first-worker-result, time blocked on slowest worker.

Privacy: aggregate patterns without dumping customer content to all employees (Anthropic discusses high-level monitoring without reading conversations).

---

## 7.8 Evaluation differences from single-agent

Paths diverge. Do not require identical trajectories.

Evaluate:

- end quality rubrics (accuracy, citations, completeness, source quality, tool efficiency—Anthropic Research set);
- cost per success;
- duplication rate across workers;
- leadership errors (bad decomposition) vs worker errors.

Start with ~20 realistic queries; large effect sizes show up early.

---

## 7.9 Approaches and trade-offs

| Topology | Latency | $ | Reliability eng | Best for | Wrong for |
| --- | --- | --- | --- | --- | --- |
| Single agent | baseline | baseline | simplest | most products | huge parallel research |
| Orchestrator-worker | better wall-clock if parallel | high | med-high | breadth-first research | low-value chat |
| Peer mesh | unpredictable | very high | hard | experimental collab | regulated side effects |
| Handoff chain | med | med | med | support specialization | deep parallel search |
| Fixed pipeline | predictable | med | high | stable business process | open-ended novelty |

Next: `08_infra_and_browser_agents.md`.


---

# 8. Infrastructure Agents & Browser Agents

These two domains share a property: **side effects and environment stochasticity dominate model IQ**. They are where agent demos most often die in production.

---

# Part A — Autonomous infrastructure agents

> Anchors: plan→act→observe→reflect loops; cloud/IaC practice; approval gates; audit requirements.

## A.1 Loop

```
plan → (dry-run / diff) → approve? → act → observe → reflect → replan or stop
```

The dry-run and approval stages are not optional cosmetics for production infrastructure. They are the difference between an agent and a chaos monkey with an API key.

## A.2 Safe side effects

### Capability model

Bind each tool to least-privilege credentials:

- read tools → read-only roles;
- mutate tools → narrow resource ARNs / namespaces;
- break-glass tools → human-held, not agent-held.

### Diff-first culture

Before mutate:

- `terraform plan`
- `kubectl diff`
- SQL in transaction with `EXPLAIN` / dry run modes
- “create change request object” that another system applies

### Blast radius limits

Encode hard caps:

- max nodes touched per step;
- max spend delta;
- allowed environments (`dev` open, `prod` gated);
- time windows (no deploys during freeze).

### Rollbacks

Every mutation class needs:

- reverse operation, or
- snapshot/restore point, or
- forward-fix runbook linked in the audit entry.

An agent that can “scale to 50” but cannot “scale back” is incomplete.

## A.3 Guardrails vs content filters

People hear “guardrails” and think toxicity filters. For infra agents, guardrails are **control-plane policy**:

- static allowlists of resources;
- OPA/Cedar policies on tool args;
- rate limits on mutators;
- mandatory second channel approval for high risk.

## A.4 Human approval boundaries

Put humans where expected cost of error exceeds cost of delay:

- production data deletion;
- security group 0.0.0.0/0;
- IAM policy widening;
- spend above threshold;
- actions outside change window.

Approvals must be durable (see long-horizon file). Slack “yes” scraped from a channel without authZ binding is not an approval system.

## A.5 Auditability

Append-only log:

- who (user, tenant, agent version, model pin);
- what intent (structured);
- what command/API;
- what result;
- correlation IDs to cloud audit trails.

Security teams will ask for this after the first incident. Build it first.

## A.6 Partial failure in infra

Example: rolling restart across 12 services; 9 succeed, 3 fail.

The agent must:

- represent partial state explicitly;
- not mark the change “complete”;
- propose repair or rollback for the failed subset;
- avoid naive full retries that double-restart the healthy 9 without reason.

---

# Part B — Browser-using agents

> Anchors: Playwright/CDP architectures; accessibility trees vs screenshots/computer-use; selector drift; session/auth; production eval flakiness.

## B.1 Why browser agents exist

Because many systems still only expose a UI. Browser agents are **RPA with a stochastic planner**. That heritage matters: RPA already taught us about flaky selectors, auth pain, and the cost of UI churn.

## B.2 Control architecture

```
Agent runtime
   │ tool calls: navigate, click, type, snapshot, wait
   v
Browser controller service
   │ Playwright / Puppeteer / raw CDP
   v
Headless browser instance (pooled, sandboxed)
   │
   ├─ cookies / localStorage (session)
   ├─ tabs / frames
   └─ network egress policy
```

Separate the **browser pool** from the **LLM workers**. Browsers are RAM/CPU heavy and fail differently.

## B.3 Observation modalities

| Modality | What model sees | Tokens | Strengths | Weaknesses |
| --- | --- | --- | --- | --- |
| Raw DOM/HTML | markup | high | complete-ish | noisy, brittle, scripts |
| **Accessibility tree** | roles, names, states | low-med | semantic, stable-ish, cheap | incomplete for custom widgets |
| Screenshot / computer-use | pixels | high | works without a11y | coordinate errors, cost, latency |
| Hybrid | a11y first, vision fallback | med | production pragmatic | more harness complexity |

Emerging engineering consensus in serious write-ups: **prefer structured text (a11y) as primary**; use vision when the tree is insufficient. Pure computer-use demos are impressive; economics and reliability often lose at volume.

Accessibility snapshots often land in the low-kilobyte range; screenshots can be tens or hundreds of KB of image tokens—material under agent loops.

## B.4 Actions and grounding

The hard problem is **grounding**: mapping intent → concrete target.

- a11y role/name locators (“button: Submit”) beat CSS `.css-1x2y3z`;
- pixel click `(x,y)` is sensitive to layout, animations, DPI;
- DOM xpath breaks when frontend ships a redesign.

**Selector drift** is the browser analogue of schema evolution: the world changes under you.

## B.5 Sessions, auth, cookies

Production issues:

- SSO flows with human 2FA;
- short-lived cookies;
- secrets leaking into prompts/traces if you dump headers;
- cross-tenant session mixups if pool isolation is wrong.

Patterns:

- dedicated browser context per run/tenant;
- secret injection via controller, not via model-visible text when possible;
- explicit re-auth tools with human handoff;
- encrypt session blobs at rest.

## B.6 Dynamic DOMs and recovery

Pages load async; modals appear; network is slow; A/B UIs differ.

Recovery policies:

- wait strategies (network idle, selector available, custom conditions);
- modal dismiss playbooks (cookie banners);
- bounded retry with new snapshot;
- “re-navigate from known URL” reset;
- escalate to human on captcha / bot wall.

Captchas and bot defenses are not a prompting problem. Plan for human or specialized services; do not pretend the agent will always “figure it out.”

## B.7 Long-running browser tasks

Challenges:

- memory leaks in browser processes;
- tab explosions;
- session expiry mid-job;
- checkpointing: save URL + storage state + task plan, not only chat history.

Kill and recreate browsers aggressively; they are cattle, not pets.

## B.8 Evaluation

Browser agents need **site-versioned** evals:

- success rate per workflow;
- median steps;
- flaky rate (same task, multiple runs);
- time and $ per success;
- breakage alerts when customer site DOM hash patterns change.

A model upgrade that “reasons better” can still lose if the locator strategy is wrong.

## B.9 Approaches and trade-offs

| Approach | Reliability | $/task | Maint. | When |
| --- | --- | --- | --- | --- |
| Scripted Playwright | high on stable flows | low | high when UI changes | top-N critical paths |
| A11y agent | med-high | med | med | long tail forms |
| Computer-use | med (variable) | high | lower locator maint, higher ops $ | novel UIs, low volume |
| API reverse engineering | highest if legal/stable | low | med | when possible, prefer over browser |
| Hybrid router | high overall | optimized | highest eng | real production estates |

## B.10 Shared lesson across infra + browser

If an official API or control plane exists, **prefer it over driving the UI or scraping**. Agents should use the highest-leverage, lowest-entropy interface available. Browser and shell are escape hatches, not default flexes.

Next: `09_production_path_and_failures.md`.


---

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


---

# 10. Evaluation, Reference Implementation, Production Scenario

---

## 10.1 Evaluation and measurement

### What you are trying to know

Agents can look fluent while failing the job. Measure four planes:

1. **Outcome** — did we achieve the goal?
2. **Process** — were the steps sane?
3. **Economics** — tokens, $, wall-clock
4. **Safety** — unauthorized actions, leakage, policy breaches

Anthropic Research: multi-agent trajectories are non-unique. Prefer **end-state** and **rubric** evaluation over forcing a single golden path.

### Core metrics

**Quality**

- task success rate (binary or 0–1 rubric)
- factual accuracy, citation accuracy, completeness, source quality, tool efficiency (research rubric set)
- exact match / structured field accuracy for closed tasks
- human preference pairs for open tasks

**Process**

- tool calls per success
- wrong-tool rate
- loop score (repeated near-identical calls)
- schema validation failure rate + repair success rate
- recovery rate after injected tool errors

**Systems**

- p50/p95 time-to-first-token and time-to-completion
- tokens in/out; **cost per successful task (CPS)**
- checkpoint resume success after kill tests
- browser flaky rate
- budget-kill rate

### Worked example — CPS

100 runs:

- 72 successes @ $0.42 average
- 28 failures @ $0.31 average

```
total_cost = 72*0.42 + 28*0.31 = 30.24 + 8.68 = 38.92
CPS = 38.92 / 72 ≈ $0.5406
success_rate = 0.72
```

Multi-agent redesign:

- 85 successes @ $0.84
- 15 failures @ $0.60

```
total = 85*0.84 + 15*0.60 = 71.4 + 9.0 = 80.4
CPS ≈ $0.9459
success_rate = 0.85
```

Whether this is better depends on **value of a success** \(V\):

```
expected_value_per_run ≈ success_rate * V - average_cost_per_run
```

If \(V = \$20\) support deflection, both designs win; if \(V = \$1\), the second design is worse despite higher success.

### Offline evaluation

- start with **~20 real queries** (Anthropic: large early effect sizes don’t need 500 cases to see signal);
- LLM-as-judge with a single clear rubric often beats fragmented multi-judge setups (their finding);
- trajectory logs for process metrics;
- memory unit tests: write/read/conflict/scope;
- contract tests for tool/handoff schemas.

### Online evaluation

- shadow new versions;
- A/B on resolution proxies;
- canaries per tenant tier;
- safety incident dashboards.

### Load testing agents (not HTTP toys)

- concurrent **runs**, not only RPS;
- browser pool exhaustion;
- tool dependency 429 behavior under parallel storms;
- resume storms after simulated regional restart.

### Misleading metrics

| Metric | Why it misleads |
| --- | --- |
| Demo success once | non-determinism + lucky context |
| Average tokens only | hides fat tails |
| “Number of autonomous steps” | thrash can increase steps |
| Embedding similarity | not task success |
| Accuracy on toy prompts | ignores tools/cost/latency |

---

## 10.2 Reference implementation (serious toy)

Framework-light sketch of a production-shaped loop: section budgets, validated tools, idempotency, checkpoints, scoped memory.

### Design goals

1. Context assembly is explicit and testable.
2. Tools cannot execute invalid args.
3. Side effects are idempotent when marked.
4. Large tool results become artifacts.
5. Each step checkpoints.
6. Memory writes are scored and scoped.

### Types

```python
from __future__ import annotations
from dataclasses import dataclass, field
from typing import Any, Callable, Literal
import hashlib, json, time, uuid

Role = Literal["system", "user", "assistant", "tool"]

@dataclass
class Message:
    role: Role
    content: str
    name: str | None = None
    tool_call_id: str | None = None

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
    side_effect: Literal["read", "soft_write", "hard_write"] = "read"

@dataclass
class RunContext:
    run_id: str
    tenant_id: str
    user_id: str
    budget_tokens: int
    step: int = 0
    model_pin: str = "model.x"
    tools_version: str = "tools.2026.08.01"

@dataclass
class MemoryRecord:
    id: str
    tenant_id: str
    scope: str
    kind: Literal["semantic", "episodic", "procedural"]
    content: str
    importance: float
    source: str
    created_at: float
```

### Tokenizer stub + assembler

```python
class SimpleTokenizer:
    def count(self, text: str) -> int:
        # production: use real model tokenizer
        return max(1, len(text) // 4)

class ContextAssembler:
    """Section budgets beat naive tail truncation."""

    def __init__(self, tok: SimpleTokenizer, limits: dict[str, int]):
        self.tok = tok
        self.limits = limits

    def assemble(
        self,
        *,
        system: str,
        tools_text: str,
        memories: list[Message],
        history: list[Message],
        scratch: str | None,
    ) -> list[Message]:
        out: list[Message] = []
        out += self._fit([Message("system", system)], self.limits["system"])
        out += self._fit([Message("system", tools_text)], self.limits["tools"])
        out += self._fit(memories, self.limits["memory"])
        if scratch:
            out += self._fit([Message("system", f"<scratch>\n{scratch}\n</scratch>")],
                             self.limits["scratch"])
        out += self._fit_history(history, self.limits["history"])
        return out

    def _fit(self, messages: list[Message], limit: int) -> list[Message]:
        acc, used = [], 0
        for m in messages:
            t = self.tok.count(m.content)
            if used + t > limit:
                break
            acc.append(m)
            used += t
        return acc

    def _fit_history(self, history: list[Message], limit: int) -> list[Message]:
        acc, used = [], 0
        for m in reversed(history):
            t = self.tok.count(m.content)
            if used + t > limit:
                if m.role == "tool" and t > 300:
                    cleared = Message(
                        "tool",
                        "[cleared tool result — re-fetch via data_ref if needed]",
                        name=m.name,
                        tool_call_id=m.tool_call_id,
                    )
                    t2 = self.tok.count(cleared.content)
                    if used + t2 <= limit:
                        acc.append(cleared)
                        used += t2
                continue
            acc.append(m)
            used += t
        return list(reversed(acc))
```

**Why this shape:** system/tools/memory/scratch are protected regions; history is where eviction happens first; tool clearing is preferred over dropping the user goal.

### Tool runtime

```python
class ToolRuntime:
    def __init__(self, tools: dict[str, ToolSpec], effects, artifacts, authorizer):
        self.tools = tools
        self.effects = effects          # durable idempotency store
        self.artifacts = artifacts      # large payload store
        self.authorizer = authorizer

    def execute_one(self, call: ToolCall, ctx: RunContext) -> Message:
        if call.name not in self.tools:
            return self._err(call, "unknown_tool", retryable=False)

        spec = self.tools[call.name]
        # authorization before anything else
        self.authorizer.check(ctx, spec, call.arguments)

        # schema validation
        validate_schema(call.arguments, spec.schema)

        idem_key = None
        if spec.idempotent:
            idem_key = hashlib.sha256(
                f"{ctx.tenant_id}|{spec.name}|{json.dumps(call.arguments, sort_keys=True)}".encode()
            ).hexdigest()
            cached = self.effects.get(idem_key)
            if cached is not None:
                return Message("tool", json.dumps(cached), name=spec.name, tool_call_id=call.id)

        try:
            value = run_with_timeout(spec.handler, call.arguments, ctx, spec.timeout_s)
            payload = {"ok": True, "data": value, "retryable": False}
        except TimeoutError as e:
            payload = {"ok": False, "error": "timeout", "message": str(e), "retryable": True}
        except Exception as e:
            payload = {
                "ok": False,
                "error": type(e).__name__,
                "message": str(e)[:500],
                "retryable": False,
            }

        if spec.idempotent and payload.get("ok"):
            self.effects.put(idem_key, payload)

        text = json.dumps(payload)
        if len(text) > 8000:
            ref = self.artifacts.put(ctx, payload)
            text = json.dumps({
                "ok": payload.get("ok"),
                "data_ref": ref,
                "preview": text[:1000],
                "note": "full payload externalized",
            })

        return Message("tool", text, name=spec.name, tool_call_id=call.id)

    def execute_many(self, calls: list[ToolCall], ctx: RunContext) -> list[Message]:
        # production: parallelize read-only / parallel_ok calls with a bounded pool
        return [self.execute_one(c, ctx) for c in calls]

    def _err(self, call, code, retryable):
        return Message(
            "tool",
            json.dumps({"ok": False, "error": code, "retryable": retryable}),
            name=call.name,
            tool_call_id=call.id,
        )
```

### Agent loop

```python
class Agent:
    def __init__(self, llm, assembler, tools: ToolRuntime, memory, checkpoints, max_steps=25):
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
            "step": 0,
            "done": False,
            "model_pin": ctx.model_pin,
            "tools_version": ctx.tools_version,
        }
        # refuse silent version skew
        if state.get("tools_version") != ctx.tools_version:
            raise RuntimeError("tools_version pin mismatch — resume with original pin or migrate")

        history: list[Message] = state["history"]
        scratch: str = state.get("scratch", "")

        for step in range(state.get("step", 0), self.max_steps):
            ctx.step = step
            memories = [
                Message("system", f"- ({m.importance:.2f}) {m.content}")
                for m in self.memory.retrieve(ctx.tenant_id, f"user:{ctx.user_id}", user_goal, k=8)
            ]
            messages = self.assembler.assemble(
                system=SYSTEM_PROMPT,
                tools_text=render_tool_docs(self.tools.tools),
                memories=memories,
                history=history,
                scratch=scratch or None,
            )

            assistant = self.llm.complete(messages, tools=self.tools.tools, pin=ctx.model_pin)
            history.append(Message("assistant", assistant.raw))

            if assistant.scratch_update:
                scratch = assistant.scratch_update

            if assistant.final_answer:
                self._write_memory(ctx, user_goal, assistant.final_answer)
                self.checkpoints.save(ctx.run_id, {
                    **state, "history": history, "scratch": scratch,
                    "step": step, "done": True,
                })
                return assistant.final_answer

            if not assistant.tool_calls:
                break

            history.extend(self.tools.execute_many(assistant.tool_calls, ctx))
            self.checkpoints.save(ctx.run_id, {
                **state, "history": history, "scratch": scratch,
                "step": step + 1, "done": False,
            })

        return "FAILED: budget or stall"

    def _write_memory(self, ctx, goal, answer):
        for cand in extract_candidates(goal, answer):  # separate tested extractor
            if cand.score < 0.75:
                continue
            if looks_like_secret(cand.text):
                continue
            self.memory.upsert(MemoryRecord(
                id=str(uuid.uuid4()),
                tenant_id=ctx.tenant_id,
                scope=f"user:{ctx.user_id}",
                kind="semantic",
                content=cand.text,
                importance=cand.score,
                source=ctx.run_id,
                created_at=time.time(),
            ))
```

### What this already teaches

- section budgets;
- tool clearing under pressure;
- idempotent effects;
- artifact externalization;
- version pins for resume;
- memory thresholds + secret filter;
- scratch outside pure chat history.

### What is still missing for production

| Missing | Why required |
| --- | --- |
| Real durable runner | checkpoints don’t self-resume |
| Parallel tool pool + bulkheads | latency and isolation |
| Redaction pipeline | logs and model egress |
| Eval harness in CI | prevent silent prompt regressions |
| Hard $ / token kills mid-run | cost runaway |
| Multi-tenant authz tests | memory/tool scope |
| Human approval integration | hard writes |
| Rainbow deploy strategy | in-flight safety |

---

## 10.3 Real production scenario (deep research SaaS)

**Northstar Research** — multi-tenant deep research, ~80k MAU, ~1,200 tenants.

### Request

Analyst: compare top 5 EU neobanks’ 2024–2025 raises, investors, regulatory actions; primary sources only.

### Path

1. API auth → tenant quotas → create `run_7f3a` with pins (`lead_model`, `worker_model`, `tools@date`).
2. Lead loads policy + tenant memory (“prefer primary filings”) + writes plan to durable scratch early.
3. Lead spawns 4 workers with **typed briefs** and output schema `FundingEvent[]`.
4. Workers explore in clean contexts; write evidence to object storage; return structured events + refs.
5. Lead synthesizes; citation agent aligns claims to sources.
6. Billing finalizes actual tokens; UI streams progress events.

### Failures handled

- one worker partial → repair worker for missing bank only;
- search 429 → circuit breaker → backup tool;
- host death → queue resumes lead; completed worker artifacts already durable;
- deploy mid-run → run continues on pinned tool/prompt versions.

### Theory → practice map

| Idea | Manifestation |
| --- | --- |
| Context scarcity | workers don’t return raw HTML |
| Multi-agent token scaling | 4 windows, explicit budgets |
| Plan memory | survives compaction |
| Typed contracts | FundingEvent schema |
| Partial failure | explicit gaps + repair |
| Durable control | resume via queue/engine |
| Effort scaling | not 50 workers for a factoid |

---

Next: `11_exercises_and_mastery.md`.


---

# 11. Exercises, Knowledge Check, Mastery

---

## 11.1 Engineering decision exercises

Try each before expanding the answer.

### Exercise 1 — Support copilot, team of 2

Constraints: 5k MAU, p95 4s typical answer, $3k/mo model budget, cite Notion + tickets, no multi-hour jobs.

Choose topology, memory, retrieval, durability.

<details>
<summary><b>Answer / reasoning</b></summary>

Single-agent tool loop. Hybrid retrieval (index + JIT full-page fetch for citations). Small semantic preference memory + thread store. No Temporal yet. Multi-agent’s token tax breaks budget and latency. Add durable execution only when long-running ticket actions with human waits appear.

</details>

### Exercise 2 — Cloud cost optimizer with delete rights

Constraints: 50 AWS accounts, auditors, false delete is catastrophic, overnight approvals.

<details>
<summary><b>Answer / reasoning</b></summary>

Separate read planner from mutators. Always diff/dry-run → policy → human approval → mutate. Durable execution required. Mutations single-threaded with idempotency + rollback. Prefer AWS APIs over browser. Audit log is the product.

</details>

### Exercise 3 — Insurance form browser estate

Constraints: 200 sites, UI churn, 30k jobs/day, captchas 5%, PII, team of 3.

<details>
<summary><b>Answer / reasoning</b></summary>

Hybrid: scripted Playwright for top stable flows; a11y agents for long tail; vision rare. Isolated browser per job; human captcha queue; site-versioned eval harness. Pure computer-use at 30k/day is usually economically wrong.

</details>

### Exercise 4 — Multi-tenant coding agent

Constraints: multi-million LOC repos, 30-minute migrations, strict isolation, cost pressure.

<details>
<summary><b>Answer / reasoning</b></summary>

JIT codebase navigation (not full-repo stuffing). Subagents for parallel exploration with artifact refs. Per-tenant workspaces. Checkpoint + job/workflow for long runs. Procedural memory for test commands. Never mix tenant code into shared indexes.

</details>

### Exercise 5 — PM wants multi-agent because of a blog

Constraints: single-agent success 0.78; fixed budget; blog claims ~90% gains.

<details>
<summary><b>Answer / reasoning</b></summary>

Replicate *your* task distribution offline with fan-out k=0/2/4; optimize CPS not vibes. Anthropic gains were on parallel research with high task value and huge token spend. Often better ROI first: tool descriptions, parallel *tools*, source quality, clearing/compaction. Adopt multi-agent only if analysis shows context/parallelism bottleneck.

</details>

### Exercise 6 — Bank transfer intents

Constraints: invalid account format is unacceptable; regulator wants determinism; model is creative.

<details>
<summary><b>Answer / reasoning</b></summary>

Strict structured outputs for intent + deterministic validators (checksums, allowlists) + human approval above thresholds. Separate speech channel from payment instruction. Idempotency keys mandatory. Repair loops alone are not enough for money movement.

</details>

---

## 11.2 Knowledge check

### Level 1 — Concepts

1. Define context engineering vs prompt engineering.
2. What is context rot?
3. Map working/episodic/semantic/procedural memory to storage.
4. Distinguish JSON mode, tool calling, constrained structured outputs.
5. Workflow vs agent (Anthropic usage).
6. Tool-result clearing vs compaction vs summarisation.
7. What does it mean multi-agent “scales tokens”?
8. What is an accessibility-tree observation?

### Level 2 — Explain why

1. Why can a 200k window still require aggressive curation?
2. Why do large tool registries hurt reliability?
3. Why is last-write-wins dangerous for multi-writer semantic memory?
4. Why save the plan outside the window early in long research?
5. Why absolute paths can beat relative paths in coding tools?
6. Why CPS beats average cost per run for architecture choices?
7. Why parallel subagents can hurt tightly coupled coding tasks?
8. Why untrusted web text must not be treated as system instructions?

### Level 3 — Engineering

1. p95 tokens/run tripled after “verbose tool debug.” Fix context policy without losing eng debuggability.
2. Payment tool timed out; charge may have succeeded. Write safe retry logic.
3. Design memory scope keys for org/user/project/agent; list leakage cases if a component is omitted.
4. Checkpoint at step 12 exists; nothing resumes after deploy. What’s missing?
5. Workers return correct numbers; final answer misses them. Fix handoff path.
6. Browser success 0.9 staging / 0.4 prod. List five non-model causes + instrumentation.
7. Evolve `search` tool schema with new required field without breaking in-flight runs.
8. Write a research rubric for LLM-as-judge; name two ways it can be gamed.

### Level 4 — Systems design

1. Design multi-tenant deep research for 100k MAU: topology, budgets, isolation, eval, cost control.
2. Critique: “store all tool results forever in a vector DB as memory.”
3. Design K8s change agent with approval + rollback + audit.
4. Combine JIT code retrieval with enterprise RAG compliance logging.
5. Defend or refute: full computer-use for all browser tasks.
6. Design multi-agent observability that debugs failures without exposing raw customer content broadly.

---

## 11.3 What mastery looks like

### I can explain...

- [ ] Agents as control loops over scarce context
- [ ] Context rot, attention budgets, ~4× / ~15× token multipliers
- [ ] Trade-offs: stuffing vs RAG vs JIT vs clearing vs compaction vs subagents
- [ ] Memory types as engineered systems with scope and conflict rules
- [ ] Tool ACI: schemas, authz, idempotency, partial failure
- [ ] Constraint stack from prompted JSON to app validators
- [ ] Checkpointing vs durable execution vs resume orchestration
- [ ] Multi-agent topologies and when the token tax is justified
- [ ] Why infra/browser agents need stronger envelopes than Q&A bots

### I can implement...

- [ ] Typed tool runtime with validation, timeouts, idempotency
- [ ] Context assembler with section budgets and tool eviction
- [ ] Scoped memory write/retrieve with conflict policy
- [ ] Checkpointed loop + external runner that actually resumes
- [ ] Parallel tools with structured partial results
- [ ] Versioned handoff/worker contracts
- [ ] A11y-first browser tools or API-first infra tools

### I can debug...

- [ ] Pollution/rot via token composition traces
- [ ] Wrong-tool selection
- [ ] Double effects from retries
- [ ] Spawn storms / duplicate workers
- [ ] Summarization telephone losses
- [ ] Stuck runs with live checkpoints
- [ ] Browser flakiness vs model errors
- [ ] Cost runaways

### I can evaluate...

- [ ] Offline goldens + rubrics without unique trajectories
- [ ] Online success, CPS, safety incidents
- [ ] Process metrics (loops, schema fails, tool errors)
- [ ] Load tests for run concurrency and browser pools
- [ ] Whether multi-agent helps *my* task distribution

### I can make trade-offs between...

- [ ] Single agent vs multi-agent vs workflows
- [ ] Bigger windows vs compaction vs external memory
- [ ] JSON mode vs constrained decoding vs repair
- [ ] Checkpointers vs durable execution engines
- [ ] A11y automation vs computer-use vs official APIs
- [ ] Autonomy vs human approval vs blast radius
- [ ] Latency, reliability, cost, complexity under real constraints

---

## 11.4 Primary reading list

1. https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
2. https://www.anthropic.com/engineering/building-effective-agents
3. https://www.anthropic.com/engineering/multi-agent-research-system
4. https://platform.claude.com/cookbook/tool-use-context-engineering-context-engineering-tools
5. https://openai.com/business/guides-and-resources/a-practical-guide-to-building-ai-agents/
6. https://openai.github.io/openai-agents-python/
7. https://developers.openai.com/api/docs/guides/structured-outputs
8. https://docs.langchain.com/oss/python/concepts/memory
9. https://temporal.io/blog/temporal-langgraph-plugin-durable-execution

---

*End of expanded Phase 1 study pack.*


---

