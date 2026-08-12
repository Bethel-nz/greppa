# 4. Tool-Calling Agents at Production Scale

> Production anchors: Anthropic *Building effective agents* (tool ACI), multi-agent research (parallel tools, tool description rewriting), OpenAI function calling + Agents SDK.

## 4.1 Core idea

A tool-calling agent is not “a model that can use plugins.” It is a **loop**:

1. model emits a **structured intent** to invoke one or more tools;
2. host **validates** and **authorizes** the intent;
3. host **executes** with timeouts and resource limits;
4. host returns **observations** as tokens (or references) into the next context;
5. repeat until terminal output or budget kill.

Anthropic’s short definition of agents—**LLMs autonomously using tools in a loop**—is the right unit of thought.

---

## 4.2 Tool schemas are the API surface (ACI)

Anthropic explicitly compares tool design to HCI and calls the discipline **ACI (agent–computer interface)**.

A tool definition typically includes:

- name;
- natural language description (when to use / when not to);
- JSON Schema for arguments;
- (implicit) return shape;
- (in serious systems) auth scopes, side-effect class, idempotency, timeout defaults.

### Why schema quality dominates prompt cleverness

The model’s policy is heavily shaped by the tool list. If two tools overlap, you created an ambiguous decision boundary. Anthropic’s observation: if a **human engineer** cannot say which tool to use, the model will not reliably do better.

They report large gains from **rewriting tool descriptions after watching failures**—including an automated tool-testing agent that exercises bad MCP tools and revises descriptions (~40% faster task completion in their account).

### Design rules that show up in production

1. **Minimal viable tool set** for a mode/role—not the entire company API catalog.
2. **Non-overlapping responsibilities.** Prefer `search_docs` vs `search_tickets` over one mega-`search`.
3. **Poka-yoke arguments.** Absolute paths beat relative paths after `cd` (SWE-bench tooling lesson). Enums beat free-form strings for control flow.
4. **Token-efficient returns.** Return summaries + `data_ref` handles for large payloads; let the agent fetch detail JIT.
5. **Errors as structured data.** `{ok:false, error_type, message, retryable}` beats a stack trace novel—or worse, empty string.

---

## 4.3 Tool discovery and selection

### Static registration

Tools array attached to the model call. Simple, cacheable, auditable.

### Dynamic discovery (MCP and friends)

Servers expose tools at runtime. Powerful for ecosystems; dangerous for quality variance. Anthropic notes MCP compounds description quality problems because agents encounter tools with uneven docs.

### Selection mechanisms

- model chooses among listed tools (default);
- router narrows tool set by intent class before the agent loop;
- permission layer removes tools the identity cannot use (so the model never “tempted”).

**Important:** removing a tool from the schema is a stronger control than writing “do not use X” in prose.

---

## 4.4 Argument validation

Validation layers (all useful):

1. **JSON Schema / strict structured outputs** — syntactic and type constraints;
2. **Application validators** — checksums, allowlists, path sandboxes, amount limits;
3. **Policy engine** — OPA-style rules on who can do what in which environment;
4. **Dry-run** — for infra, show diff before apply.

Never execute side effects on unvalidated args. Model confidence is not input validation.

---

## 4.5 Sequential vs parallel execution

### Sequential

Simple; preserves dependencies; easier debugging; higher wall-clock.

### Parallel

Independent tool calls in one turn (or fan-out across subagents). Anthropic Research reported up to ~**90% wall-clock reduction** on complex research by combining parallel subagents and parallel tool calls.

### Host-side programmatic loops

Sometimes the right move is: model proposes a query plan, host runs 500 fetches in code, returns aggregate stats. This keeps giant intermediates out of context (Claude Code analyzing data via bash head/tail style).

| Pattern | Wall-clock | Context risk | Failure complexity |
| --- | --- | --- | --- |
| Sequential tools | high | medium | low |
| Parallel tools | low | medium | medium (partials) |
| Programmatic bulk | low-med | low | medium (engineering) |
| Subagent fan-out | low | low per agent / high total tokens | high |

---

## 4.6 Retries, idempotency, timeouts

### Timeouts

Always set:

- per-tool timeout;
- per-turn wall clock;
- per-run budget (steps, tokens, $).

Hanging tools hold workers and multiply cost.

### Retries

Retry only when:

- error is **transient** (429, 503, network blip);
- operation is **idempotent** or guarded by an idempotency key;
- you have **backoff + jitter** and a max attempt count.

### Idempotency

For any non-read tool that matters:

```
idempotency_key = hash(tenant, tool_name, canonical_args, optional_user_intent_id)
```

Store outcomes in an **effect table**. On retry, return the original effect instead of creating a second refund.

**The classic outage:** timeout after the provider side succeeded; naive retry creates duplicates. This is distributed systems 101 applied to agents.

### Partial failures

If 5 parallel tools run and 2 fail, the observation must show **per-call status**. Aggregating into a single “done” is a lie that models will believe.

---

## 4.7 Permissions and side-effect classes

Classify tools:

| Class | Examples | Default policy |
| --- | --- | --- |
| Pure read | get ticket, search docs | broad allow |
| Soft write | draft email, create private note | allow with audit |
| Hard write | refund, delete, deploy | step-up auth / approval |
| Dangerous | shell, browser to arbitrary URL, admin APIs | sandbox + allowlist + human |

Map classes to IAM roles / capability tokens. The agent runtime should hold **least privilege**, not your personal admin key.

---

## 4.8 Observability for tools

Minimum fields per tool invocation:

- run_id, turn_id, tool_call_id
- tool name + schema version
- redacted args
- start/end, latency
- status, error class
- response size (bytes/tokens)
- idempotency key hit?
- downstream status codes

Anthropic’s multi-agent production story emphasizes that without tracing, user reports like “it couldn’t find obvious information” are undiagnosable—was it query quality, source selection, or tool failure?

---

## 4.9 Cost and latency budgeting

Tools affect budgets in two ways:

1. **direct latency/cost** of the tool;
2. **context cost** of stuffing the result into future turns.

A slow browser screenshot that also injects 5k vision tokens is a double tax.

Budget patterns:

- max tool calls per run;
- max parallel width;
- max response bytes before forced `data_ref`;
- separate rate limits per tool class;
- circuit breakers when a dependency’s error rate spikes.

---

## 4.10 Failure modes (tooling)

1. **Wrong tool loops** — ambiguous registry.
2. **Schema too clever** — model cannot produce args (overly nested, exotic formats).
3. **Return payload bloat** — context rot accelerator.
4. **Non-idempotent retry** — duplicated side effects.
5. **Permission confused deputy** — tool uses server credentials broader than user.
6. **Tool result injection** — malicious page/doc content influences later tool choice.
7. **Sync fan-out bottleneck** — lead waits on slowest worker (Anthropic Research limitation they discuss).

---

## 4.11 Approaches comparison

| Approach | Reliability | Latency | $ | Complexity | When |
| --- | --- | --- | --- | --- | --- |
| Few hard-coded tools | high | med | med | low | early product |
| Large open tool catalog | low-med | var | high | high | only with routing/search over tools |
| MCP ecosystem tools | variable | var | var | med | internal trusted servers first |
| Code-execution tool (sandbox) | high leverage | var | var | high security needs | data analysis, transforms |
| Browser-as-tool | flexible | high | high | high | no API available |

Next: `05_structured_typed_agents.md`.
