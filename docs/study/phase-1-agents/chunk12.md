---

## 11. Knowledge Check

### Level 1 — Concepts

1. Define **context engineering** and explain how it differs from prompt engineering.
2. What is **context rot**, and what architectural property of transformers contributes to it?
3. Map working / episodic / semantic / procedural memory to concrete storage systems.
4. Distinguish **JSON mode**, **function calling**, and **structured outputs** (constrained decoding).
5. What is the difference between a **workflow** and an **agent** in Anthropic’s terminology?
6. Explain **tool-result clearing** vs **compaction** vs **summarisation**.
7. What does it mean that a multi-agent system can “scale tokens”?
8. What is an **accessibility tree** observation for a browser agent?

### Level 2 — Explain Why

1. Why can a larger context window still require aggressive context engineering?
2. Why do bloated tool registries reduce reliability even if each tool “works”?
3. Why is last-write-wins often a bad default for semantic memory in multi-agent systems?
4. Why did Anthropic’s Research system save the plan to memory *before* long exploration?
5. Why are absolute file paths sometimes more reliable tool args than relative paths?
6. Why is cost per *successful* task more decision-relevant than average cost per run?
7. Why might parallel subagents hurt a tightly coupled coding change?
8. Why is treating untrusted web content as system-equivalent instructions dangerous?

### Level 3 — Engineering

1. Your traces show p95 tokens/run climbed 3× after adding “verbose tool debug.” Design a context policy fix without losing debuggability for engineers.
2. A payment tool times out; the provider might have charged. Write the runtime logic for safe retry.
3. Implement a memory scope key layout for SaaS with orgs, users, agents, and projects—list failure cases if a key component is omitted.
4. LangGraph checkpoint shows state at step 12, but no worker continues the run after a deploy. What is missing operationally?
5. Workers return great data but the lead’s final answer misses figures. Diagnose and fix the handoff path.
6. Browser agent success is 0.9 in staging, 0.4 in prod. List five non-model causes and how you’d instrument them.
7. Design schema evolution for `Tool:search` adding a required `recency_days` without breaking in-flight runs.
8. Write a rubric for LLM-as-judge evaluating research agents; note two ways the judge can be gamed.

### Level 4 — Systems Design

1. Design a multi-tenant deep-research product for 100k MAU: topology, budgets, tenancy isolation, eval, and cost controls.
2. Critique a proposal: “We’ll store all tool results forever in the vector DB as memory.”
3. Design durable infrastructure-change agents for Kubernetes with human approval and rollback.
4. Propose an architecture that combines Claude-Code-like JIT retrieval with enterprise RAG compliance logging.
5. A PM wants full computer-use for all browser tasks. Defend or refute with cost/reliability architecture.
6. Design observability that debugs multi-agent failures without exposing raw customer content to all employees.
