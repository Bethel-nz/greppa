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
