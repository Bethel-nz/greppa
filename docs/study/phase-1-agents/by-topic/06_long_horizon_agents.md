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
