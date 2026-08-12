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
