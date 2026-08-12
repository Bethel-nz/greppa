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
