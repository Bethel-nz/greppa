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
