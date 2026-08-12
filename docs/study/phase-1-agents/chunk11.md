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
