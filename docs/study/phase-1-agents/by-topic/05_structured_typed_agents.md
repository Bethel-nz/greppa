# 5. Structured / Typed Agents

> Production anchors: OpenAI Structured Outputs & function calling docs; Anthropic tool-use patterns; schema-first handoffs in multi-agent systems.

## 5.1 The problem

Natural language is an excellent **human** interface and a poor **machine boundary**.

If your agent’s “API” to tools, workers, workflows, and billing systems is free-form prose, you will spend your life writing brittle parsers and handling creative formatting. Production agents need **typed boundaries** at every place where software will act.

---

## 5.2 The constraint stack (stop collapsing these terms)

These are different layers. Industry slides often pretend they are synonyms.

### Layer 0 — Prompted shape

“Please respond in JSON with keys …”

- **Guarantee:** social pressure on a stochastic model.
- **Use:** prototypes only.

### Layer 1 — JSON mode

Model is constrained to emit valid JSON *syntax*.

- **Guarantee:** parseable JSON value.
- **Not guaranteed:** required keys, enums, types, absence of extra fields.

### Layer 2 — Function / tool calling

Model emits a named tool invocation plus arguments (often JSON).

- **Guarantee:** depends on provider; increasingly schema-checked.
- **Role:** action interface, not necessarily final user answer format.

### Layer 3 — Structured outputs / constrained decoding

Generation is restricted so that outputs conform to a JSON Schema (token masking / grammar constraints). OpenAI’s Structured Outputs is the widely known API form; libraries like Outlines implement similar ideas for open models.

- **Guarantee:** schema adherence (within the supported schema fragment).
- **Not guaranteed:** business correctness (“amount > balance” still needs app logic).

### Layer 4 — Application validation

Pydantic/Zod/domain rules after parse: checksums, referential integrity, authz.

### Layer 5 — Repair loops

On validation failure, re-prompt with errors or run deterministic repair.

- **Useful for:** complex constraints not expressible in schema.
- **Dangerous as sole control for money/infra:** can loop, can be jailbroken, is non-deterministic.

---

## 5.3 Why typed agents exist beyond “JSON is nice”

Typed boundaries enable:

1. **Safe execution** — do not call refund without a validated `PaymentIntent`.
2. **Multi-agent contracts** — worker returns `FundingEvent[]`, not an essay.
3. **Streaming UX** — event envelopes (`progress`, `tool_start`, `final`) with known shapes.
4. **Eval** — automatic scoring of structured fields.
5. **Schema evolution** — versioned contracts like real APIs.

Anthropic’s multi-agent research appendix recommends external artifacts and structured returns to reduce “telephone” loss. That is a typing/architecture point, not a prose point.

---

## 5.4 Schema design for agents

### Prefer closed control sets

```json
{
  "action": { "enum": ["search", "draft", "escalate", "finish"] },
  "query": { "type": "string" }
}
```

Better than free-form `action` strings the host must interpret.

### Separate human channel from machine channel

Bad:

```json
{ "response": "Sure! I'll refund $12.13 to acct..." }
```

Better:

```json
{
  "assistant_speech": "I can refund that now.",
  "intent": {
    "type": "refund",
    "amount_cents": 1213,
    "currency": "USD",
    "order_id": "ord_..."
  }
}
```

Speech can be approximate; intent must be exact.

### Avoid formats that fight tokenization / planning

Anthropic’s SWE-bench tooling notes: making the model keep accurate line counts for diffs, or JSON-escape large code blocks, increases error rates. Prefer formats close to what models see naturally in training data when possible.

### Make illegal states hard to represent

If a tool always needs either `issue_id` or `search_query`, encode a schema that forbids empty both (as supported by your constrained decoding features). Where not supported, validate in app code.

---

## 5.5 Validation, repair, retries

Recommended pipeline:

```
model output
  → constrained decode (if available)
  → JSON parse
  → schema validate
  → domain validate
  → (optional) repair once/twice with error feedback
  → fail closed (ask user / safe fallback)
```

**Repair budget:** cap attempts. Infinite repair is a cost and safety hazard.

**Fail closed vs fail open:** for reads, degrade; for writes, stop.

---

## 5.6 Streaming structured data

Challenges:

- partial JSON is not valid JSON;
- UI wants incremental tokens;
- tools need complete args before execution.

Patterns:

1. **Stream speech, buffer intent** until schema-complete.
2. **NDJSON event stream** where each line is a small complete object.
3. **Incremental parsers** with explicit `partial` states (do not execute on partial).
4. **Two-phase:** model streams plan text; final message is structured only.

---

## 5.7 Schema evolution

Treat schemas like public APIs between:

- model ↔ host
- host ↔ tools
- lead ↔ workers
- agent ↔ workflow engine

Rules of thumb:

- additive optional fields first;
- dual-read old/new during rollout;
- pin schema version on long-running runs (rainbow deploys);
- contract tests in CI with golden model outputs and adversarial cases.

Breaking a required field mid-flight is a classic “deploy broke agents” outage.

---

## 5.8 Approaches and trade-offs

| Approach | Guarantee | Latency | Cost | Complexity | Use |
| --- | --- | --- | --- | --- | --- |
| Prompted JSON | weak | low | low | low | never for side effects |
| JSON mode | syntax | low | low | low | low-risk parsing aids |
| Tool calling | action-oriented | low-med | low-med | med | default agent actions |
| Strict structured outputs | schema | slight overhead | low-med | med | boundaries that must not drift |
| Grammar-constrained DSL | very strong for DSL | med | med | high | SQL/plan DSLs |
| Validate + repair | business rules | +turns | +$ | med | secondary layer |

---

## 5.9 Misconceptions

1. **“Structured outputs make the agent truthful.”** They make it **well-formed**, not correct.
2. **“One schema for the whole agent is enough.”** Different stages need different schemas (plan vs tool vs final answer vs handoff).
3. **“If strict mode is on, I can skip app validation.”** Schema ≠ policy ≠ authz.

Next: `06_long_horizon_agents.md`.
