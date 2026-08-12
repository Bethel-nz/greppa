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
