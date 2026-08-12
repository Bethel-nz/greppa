# Phase 1 — Agents: How Intelligent Systems Actually Operate

**Study chapter · AI Engineering curriculum**
**Scope:** Context engineering · persistent memory · tool-calling · structured agents · long-horizon planning · multi-agent systems · infrastructure agents · browser agents
**Level:** Production engineering depth (not beginner, not interview prep)

---

## Primary sources (production systems)

This chapter is grounded in what companies building agents have published about production systems, not only framework tutorials:

- **Anthropic** — *Effective context engineering for AI agents* (2025): context as finite resource, compaction, note-taking, sub-agents
- **Anthropic** — *Building effective agents* (2024): workflows vs agents, composable patterns, tool ACI
- **Anthropic** — *How we built our multi-agent research system* (2025): orchestrator-worker at scale, token economics, evaluation
- **Anthropic** — Claude Code / context management cookbook: compaction, tool-result clearing, memory tools
- **OpenAI** — *A practical guide to building agents* + Agents SDK: orchestration, guardrails, multi-agent handoffs
- **OpenAI** — Structured Outputs / function calling docs: schema-constrained generation vs JSON mode
- **LangChain / LangGraph** — checkpointers, BaseStore, short-term vs long-term memory
- **Temporal** engineering writing — checkpoints vs durable execution; crash recovery for long-running agents
- Browser automation engineering literature (Playwright/CDP, accessibility trees, computer-use trade-offs)

Treat these as primary literature. Framework docs are secondary; they abstract mechanisms this chapter makes explicit.

---

## 1. Mental Model

### 1.1 The fundamental problem

An LLM is a **stateless next-token predictor** conditioned on a finite sequence of tokens called the **context**. Production agents exist because real work is not one-shot generation:

1. Goals span many steps (hours or days, not one completion).
2. Ground truth lives outside the model (APIs, databases, browsers, infrastructure).
3. Side effects must be safe, auditable, and recoverable.
4. Token windows fill, rot, and get expensive.
5. Partial failure is the normal case, not the exception.

The core engineering problem:

> **Given a goal, continuously assemble the highest-utility finite context, decide which tools to invoke, apply side effects safely, persist what must survive the next turn (or crash), and stop when done—under cost, latency, and reliability constraints.**

Everything in Phase 1 is a special case of that sentence.

### 1.2 Agent vs workflow (terminology industry overloads)

Anthropic’s distinction (widely adopted, often misused):

| Term | Control flow | Who decides the next step |
| --- | --- | --- |
| **Workflow** | Predefined graph / code path | Engineer + maybe a classifier |
| **Agent** | Dynamic loop | Model chooses tools/plan based on observations |
| **Agentic system** | Either or hybrid | Umbrella term |

Industry sloppiness to watch for:

- **"Agent"** used for a single tool-calling chat turn.
- **"Multi-agent"** used for two sequential prompts with no coordination protocol.
- **"Memory"** used for (a) conversation history, (b) vector RAG, (c) durable fact store, (d) checkpointed workflow state—four different systems.
- **"Context"** used for prompt text, product feature "context windows," and retrieval corpora.

When reading production posts, map each term to: *where does state live, who owns the control loop, what survives a process crash?*

### 1.3 The agent loop as a control system

```
                 ┌──────────────────────────────────────┐
                 │           Durable runtime            │
                 │  (checkpoint / workflow / queue)     │
                 └───────────────┬──────────────────────┘
                                 │ resume state
                                 v
Goal ──► Assemble context ──► Model step ──► Parse structured intent
              ▲                     │
              │                     ├─ final answer ──► done
              │                     │
              │                     └─ tool call(s) ──► execute
              │                                            │
              │                     observe / validate ◄───┘
              │                            │
              └──── write memory / logs ◄──┘
```

This is closer to a **closed-loop controller** than to a chatbot:

- **Actuators:** tools (APIs, shell, browser, infra).
- **Sensors:** tool results, logs, DOM/a11y snapshots, metrics.
- **Controller:** the model + your policies (permissions, budgets, schemas).
- **Plant state:** external systems + durable agent state.
- **Disturbances:** flaky APIs, stale context, schema drift, human interruption.

### 1.4 Context is the scarce resource

Anthropic’s production framing: context is a **finite attention budget with diminishing returns**. Transformers attend over O(n²) pairwise relationships; as n grows you get **context rot**—recall and instruction-following degrade even before the hard token limit.

```
utility(tokens) ≈ f(signal density, recency, relevance, structure)
cost(tokens)    ≈ O(n) dollars + O(n) latency + O(n²) attention dilution
```

**Context engineering** is the set of strategies for curating and maintaining the optimal tokens during inference—not just writing a clever system prompt once. Prompt engineering is a subset; the full problem includes tools, retrieval, history, memory, MCP payloads, and what you *delete*.

### 1.5 How Phase 1 topics interlock

```
Context engineering  ◄── what enters the model this turn
        ▲
Persistent memory    ◄── what survives across turns/sessions
        ▲
Tool-calling agents  ◄── how the model acts on the world
        ▲
Structured / typed   ◄── how action intents are constrained
        ▲
Long-horizon agents  ◄── multi-hour goals, plans, checkpoints
        ▲
Multi-agent systems  ◄── parallel context windows + coordination
        ▲
Infra / browser      ◄── high-risk action surfaces (side effects)
```

Most production failures are *context + tools + durability* failures, not “the model is dumb.”

### 1.6 Token economics (working numbers)

From Anthropic’s multi-agent research production system:

- Agents ≈ **4×** tokens of normal chat.
- Multi-agent research ≈ **15×** tokens of chat.
- On BrowseComp analysis: **token usage alone explained ~80%** of performance variance; tool-call count and model choice explained most of the rest.

Engineering implication: multi-agent is often a **capacity scaling** strategy (more context bandwidth) with a **cost tax**. Use it when task value ≫ 15× chat cost.
