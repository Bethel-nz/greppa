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
