# 1. Mental Model — How Intelligent Agent Systems Actually Operate

## 1.1 The fundamental problem

A large language model, used by itself, is a **stateless conditional generator**. You give it a sequence of tokens; it samples a continuation. That fact never changes, no matter how much product language we wrap around it.

Almost everything people want from “AI agents” violates the assumptions of a single clean completion:

1. **Duration.** Real goals take many model calls. A codebase migration, a multi-source research brief, or a browser workflow is not one prompt.
2. **External truth.** The model does not contain your ticket queue, your customer’s live balance, or the current DOM of a partner portal. Truth is outside.
3. **Side effects.** Writing a row, refunding a charge, restarting a pod, or submitting a form changes the world. Wrong actions have cost.
4. **Scarce attention.** Every extra token competes for the model’s finite effective attention. More context is not free, and often not better.
5. **Partial failure.** Tools time out. Half of a parallel fan-out fails. Processes die mid-run. Humans interrupt. The normal case is messy.

So the real problem statement is not “how do I make the model smarter?” It is:

> **How do I build a system that repeatedly assembles a high-utility finite context, lets a model propose the next actions, executes those actions under policy, feeds observations back, persists what must survive the next turn or a crash, and stops under budget—while remaining debuggable and safe?**

That system is what engineers mean (when they are being precise) by an **agent runtime**.

---

## 1.2 Intuition first, then names

Imagine a competent junior engineer given a laptop, a ticket, and access to internal tools.

They do not paste the entire company wiki into their working memory. They:

- keep the ticket and acceptance criteria close;
- open a few relevant files or dashboards;
- try something;
- look at the result;
- update a short note (“deploy blocked on migration”);
- come back tomorrow and re-read their note.

An agent is the same control pattern, with two harsh constraints:

1. **Working memory is the context window**, and it is both expensive and lossy at length.
2. **The “person” is stochastic.** The same state does not always produce the same next action.

Everything called “context engineering,” “memory,” “tool calling,” “planning,” or “multi-agent” is a technique for making that control loop work under those constraints.

---

## 1.3 The agent loop as a closed-loop controller

```
                    ┌─────────────────────────────────┐
                    │     Durable runtime / queue     │
                    │  checkpoints · timers · resume  │
                    └──────────────┬──────────────────┘
                                   │ rehydrate state
                                   v
   Goal ──► Assemble context ──► Model step ──► Interpret structured intent
              ▲                      │
              │                      ├─► terminal answer ──► stop
              │                      │
              │                      └─► tool call(s) ──► execute under policy
              │                                              │
              │                         observations ◄───────┘
              │                              │
              └──── memory writes / logs / plan updates ◄────┘
```

Map this to classical control:

| Control concept | Agent system analogue |
| --- | --- |
| Reference signal | User goal + success criteria + policies |
| Controller | Model + your decoding constraints + routing logic |
| Actuators | Tools (APIs, shell, browser, infra CLIs) |
| Sensors | Tool results, metrics, DOM/a11y, logs |
| Plant | External systems + durable agent state |
| Disturbance | Flaky APIs, stale indexes, UI changes, injection |
| State estimator | Context assembler + memory retrieval |

This framing is useful because it forces the right questions:

- What is the **state**?
- What is the **action space**?
- What is the **observation channel**?
- What are the **safety interlocks** on actuators?
- What is the **cost of each control cycle**?

If you only think in chat UX terms (“messages in a thread”), you will under-design durability, permissions, and budgets.

---

## 1.4 Workflows vs agents (and why industry language is sloppy)

Anthropic’s distinction, now widely used:

- A **workflow** orchestrates LLMs and tools along **predefined** code paths (graphs, pipelines, fixed stages).
- An **agent** lets the model **dynamically** choose the next tools and structure of work based on intermediate observations.
- **Agentic system** is the umbrella term for both.

These are ends of a spectrum, not a purity test. Production systems are usually hybrids:

- fixed outer workflow (auth → quota → run record → bill);
- agentic inner loop for the uncertain middle;
- fixed terminal stages (citation check, schema validate, redaction).

### Overloaded words to disambiguate every time you hear them

**“Agent”** might mean:

1. a single tool-calling loop;
2. a product feature with autonomy marketing;
3. one role inside a multi-agent graph;
4. a background job that happens to call an LLM.

**“Memory”** might mean:

1. the conversation transcript still in context;
2. a summary of that transcript;
3. a vector index of documents (often just RAG);
4. a typed fact store with scopes and conflict rules;
5. a workflow checkpoint (execution state, not knowledge).

**“Context”** might mean:

1. the literal token window;
2. “business context” as in domain knowledge;
3. React/JS context (unrelated);
4. retrieval corpus.

**When you read a blog post, translate every overloaded term into: where state lives, who owns the next decision, and what survives process death.**

---

## 1.5 The scarcity that drives the whole field: context

Anthropic’s 2025 production framing is the right starting point: **context is a finite resource with diminishing marginal returns.**

Mechanically:

- Transformers build pairwise interactions across tokens (attention). As sequence length grows, the model’s ability to use every token with equal fidelity degrades. This is discussed in industry as **context rot** (and related phenomena like lost-in-the-middle).
- Training distributions historically over-represent shorter sequences, so long-context behavior is partly extrapolation.
- Positional schemes and long-context training help, but they do not create infinite perfect working memory.

So “we have a 200k window” does **not** mean “dump everything.” It means “you have a larger **budget**, still subject to rot, latency, and dollar cost.”

### Token economics as a first-class design input

Anthropic’s multi-agent research system published striking empirical notes:

- agent runs often use on the order of **~4×** the tokens of ordinary chat;
- multi-agent research can approach **~15×** chat token usage;
- in one BrowseComp analysis, **token usage alone explained ~80%** of performance variance, with tool-call count and model choice explaining much of the rest.

Interpretation for engineers:

1. Many “architecture wins” are really **capacity wins**—you found a way to spend more useful tokens.
2. Multi-agent is not free intelligence; it is often **parallel context bandwidth** purchased at high cost.
3. You should track **cost per successful task**, not only average tokens.

---

## 1.6 How Phase 1 topics lock together

Study them as one machine, not eight buzzwords:

```
Context engineering     what enters the model on this turn
        ↑ pulls from
Persistent memory       what survives across turns and sessions
        ↑ written by / read for
Tool-calling            how the model acts on the outside world
        ↑ constrained by
Structured / typed I/O  how intents become machine-checkable
        ↑ sequenced by
Long-horizon control    plans, checkpoints, resume, replanning
        ↑ scaled by
Multi-agent systems     multiple contexts + coordination protocols
        ↑ specialized into
Infra & browser agents  high-blast-radius action surfaces
```

**Failure intuition:** when a production agent “gets dumb,” the bug is usually in assembly of context, tool contracts, memory scope, or durability—not in the base model’s IQ ceiling.

---

## 1.7 A minimal complete mental checklist

Before designing any agent feature, answer:

1. **Goal & stop condition** — what does done mean? what is the max step/token/$ budget?
2. **Action space** — which tools exist? which are forbidden?
3. **Observation quality** — will the model see errors clearly, or silent empties?
4. **Context policy** — what is always present, retrieved, cleared, summarized?
5. **Durable state** — what must survive crash? where is it stored?
6. **Side-effect safety** — idempotency, approvals, blast radius, audit.
7. **Evaluation** — how will you know a prompt/tool change helped?

If you cannot answer these, you do not have an agent architecture; you have a demo script.

---

## 1.8 What “good taste” looks like (from production teams)

Across Anthropic’s agent posts and OpenAI’s practical guide, the same taste emerges:

- Prefer **simple composable patterns** over framework cathedrals until complexity is earned.
- Invest heavily in **tool interfaces** (ACI: agent–computer interface), not only system prompts.
- Treat long-running work as a **systems problem** (state, resume, deploy safety), not only a prompting problem.
- Measure with **small realistic evals early**; do not wait for a 500-case harness to learn anything.
- Add multi-agent only when the task is **parallelizable and valuable enough** to pay the token tax.

Next: `02_context_engineering.md` — the discipline that sits under every other topic.
