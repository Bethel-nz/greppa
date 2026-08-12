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
