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
