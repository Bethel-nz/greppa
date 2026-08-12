---

## 8. Implementation Walkthrough

A small but serious reference: **typed tool-calling agent with context budgeting, memory writes, parallel tools, and checkpointed runs**. Framework-light Python-style pseudocode.

### 8.1 Design goals

1. Explicit context assembly (no hidden prompt magic)
2. Schema-validated tools + idempotency
3. Memory scoped by tenant
4. Checkpoint after each turn for resume
5. Observable events

### 8.2 Core types

```python
from dataclasses import dataclass, field
from typing import Any, Callable, Literal
import json, time, hashlib, uuid

Role = Literal["system", "user", "assistant", "tool"]

@dataclass
class Message:
    role: Role
    content: str
    name: str | None = None          # tool name
    tool_call_id: str | None = None
    tokens: int | None = None

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
    parallel_ok: bool = True

@dataclass
class RunContext:
    run_id: str
    tenant_id: str
    user_id: str
    budget_tokens: int
    step: int = 0
    checkpoint: dict = field(default_factory=dict)

@dataclass
class MemoryRecord:
    id: str
    tenant_id: str
    scope: str
    kind: Literal["semantic", "episodic", "procedural"]
    content: str
    importance: float
    created_at: float
```

### 8.3 Context assembler with budgets

```python
class ContextAssembler:
    def __init__(self, tokenizer, limits: dict[str, int]):
        # limits e.g. system=1500, tools=2000, memory=1500,
        # retrieval=2000, history=6000, reserve=2000
        self.tok = tokenizer
        self.limits = limits

    def assemble(self, *, system, tool_schemas_text, memories, retrieved,
                 history, scratch) -> list[Message]:
        parts = []
        parts += self._pack("system", [Message("system", system)], self.limits["system"])
        parts += self._pack("tools", [Message("system", tool_schemas_text)], self.limits["tools"])
        parts += self._pack("memory", memories, self.limits["memory"])
        parts += self._pack("retrieval", retrieved, self.limits["retrieval"])
        # history: keep most recent first when trimming
        parts += self._pack_history(history, self.limits["history"])
        if scratch:
            parts += self._pack("scratch", [scratch], self.limits.get("scratch", 500))
        return parts

    def _pack(self, label, messages, limit):
        # drop from the middle/low priority; keep header + tail signal
        out, used = [], 0
        for m in messages:
            t = self.tok.count(m.content)
            if used + t > limit:
                break
            out.append(m); used += t
        return out

    def _pack_history(self, history, limit):
        out, used = [], 0
        for m in reversed(history):
            t = self.tok.count(m.content)
            if used + t > limit:
                # prefer tool-result clearing over dropping user goals
                if m.role == "tool" and t > 200:
                    cleared = Message("tool", "[cleared tool result — re-fetch if needed]",
                                      name=m.name, tool_call_id=m.tool_call_id)
                    t2 = self.tok.count(cleared.content)
                    if used + t2 <= limit:
                        out.append(cleared); used += t2
                    continue
                break
            out.append(m); used += t
        return list(reversed(out))
```

**Decision:** section budgets beat one giant truncate—protect goals and policies first (Anthropic: smallest high-signal set).

### 8.4 Tool runtime with validation, timeout, idempotency

```python
class ToolRuntime:
    def __init__(self, tools: dict[str, ToolSpec], effect_store):
        self.tools = tools
        self.effects = effect_store  # durable set of idempotency keys

    def execute_many(self, calls: list[ToolCall], ctx: RunContext) -> list[Message]:
        # partition parallel_ok vs serial
        results = []
        # naive: parallel via thread/async pool for parallel_ok independent calls
        for call in calls:
            results.append(self.execute_one(call, ctx))
        return results

    def execute_one(self, call: ToolCall, ctx: RunContext) -> Message:
        spec = self.tools[call.name]
        # 1) schema validate
        validate_json_schema(call.arguments, spec.schema)

        # 2) idempotency
        idem_key = None
        if spec.idempotent:
            idem_key = hashlib.sha256(
                f"{ctx.tenant_id}:{call.name}:{json.dumps(call.arguments, sort_keys=True)}".encode()
            ).hexdigest()
            prior = self.effects.get(idem_key)
            if prior is not None:
                return Message("tool", json.dumps(prior), name=call.name, tool_call_id=call.id)

        # 3) permission check (omitted): map tenant + role → allow

        # 4) execute with timeout
        try:
            value = run_with_timeout(spec.handler, call.arguments, ctx, spec.timeout_s)
            payload = {"ok": True, "data": value}
        except Exception as e:
            payload = {"ok": False, "error": type(e).__name__, "message": str(e)[:500]}

        if spec.idempotent and payload.get("ok"):
            self.effects.put(idem_key, payload)

        # 5) token-efficient return: truncate large data
        text = json.dumps(payload)
        if len(text) > 8000:
            text = json.dumps({"ok": payload.get("ok"), "data_ref": store_artifact(payload),
                               "preview": text[:1000]})
        return Message("tool", text, name=call.name, tool_call_id=call.id)
```

### 8.5 Agent loop with checkpoint + memory

```python
class Agent:
    def __init__(self, llm, assembler, tools: ToolRuntime, memory, checkpoints, max_steps=20):
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
        }
        history: list[Message] = state["history"]

        for step in range(state.get("step", 0), self.max_steps):
            ctx.step = step
            memories = self.memory.retrieve(ctx.tenant_id, user_goal, k=8)
            messages = self.assembler.assemble(
                system=SYSTEM_PROMPT,
                tool_schemas_text=render_tools(self.tools.tools),
                memories=[Message("system", m.content) for m in memories],
                retrieved=[],  # optional RAG
                history=history,
                scratch=Message("system", f"SCRATCH:\n{state.get('scratch','')}")
                    if state.get("scratch") else None,
            )

            assistant = self.llm.complete(messages, tools=self.tools.tools)
            history.append(Message("assistant", assistant.raw_text))

            if assistant.final_answer:
                self._maybe_write_memory(ctx, user_goal, assistant.final_answer, history)
                self.checkpoints.save(ctx.run_id, {"history": history, "step": step, "done": True})
                return assistant.final_answer

            if not assistant.tool_calls:
                # model stalled — force finish or error
                break

            tool_msgs = self.tools.execute_many(assistant.tool_calls, ctx)
            history.extend(tool_msgs)

            # structured note-taking: model may emit plan updates in a side channel
            if assistant.scratch_update:
                state["scratch"] = assistant.scratch_update

            self.checkpoints.save(ctx.run_id, {
                "history": history,
                "step": step + 1,
                "scratch": state.get("scratch", ""),
                "done": False,
            })

        return "FAILED: max steps or stall"

    def _maybe_write_memory(self, ctx, goal, answer, history):
        # production: separate extractor model or strict schema tool `memory.write`
        candidates = extract_semantic_candidates(goal, answer, history)
        for c in candidates:
            if c.score < 0.7:
                continue
            self.memory.upsert(MemoryRecord(
                id=str(uuid.uuid4()),
                tenant_id=ctx.tenant_id,
                scope=f"user:{ctx.user_id}",
                kind="semantic",
                content=c.text,
                importance=c.score,
                created_at=time.time(),
            ))
```

### 8.6 Architectural decisions explained

1. **Sectioned budgets** — prevent tool dumps from ejecting the system policy.
2. **Tool results as structured JSON with ok/error** — makes partial failure visible.
3. **Artifact refs for large payloads** — JIT retrieval next turn (Claude Code style).
4. **Idempotency store** — production side effects.
5. **Checkpoint each step** — resume after crash; still need a worker to *call* `run` again (checkpoint ≠ durable execution).
6. **Memory behind score threshold** — reduces junk drawer writes.
7. **Scratch externalized** — long-horizon plan survives compaction.

### 8.7 What must change before production

| Gap | Production requirement |
| --- | --- |
| In-process checkpoint dict | Postgres/Redis + job queue or Temporal |
| No authz on tools | capability tokens per tenant/role |
| Naive parallel | async + concurrency limits + bulkheads |
| extract_semantic_candidates opaque | tested extractor + human review for PII |
| No redaction | strip secrets from logs/tool results |
| No eval harness | golden set + CI gate on prompt/tool changes |
| Single model path | routing + fallback models |
| No budget kill | hard token/$ caps mid-run |
| Browser/infra tools absent | sandboxes, approval gates, audit log |
| Schema evolution | versioned tool registry |
