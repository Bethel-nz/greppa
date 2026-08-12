---

## 12. What Mastery Looks Like

### I can explain...

- [ ] Why agents are control loops over scarce context, not chat wrappers
- [ ] Context rot, attention budget, and token economics (including ~4× / ~15× multipliers)
- [ ] Trade-offs among stuffing, RAG, JIT retrieval, compaction, clearing, and subagents
- [ ] Memory types as engineered systems (not metaphors only)
- [ ] Tool ACI: schemas, permissions, idempotency, partial failure
- [ ] Structured output stack from prompts to constrained decoding to validators
- [ ] Checkpointing vs durable execution vs resume orchestration
- [ ] Multi-agent patterns: orchestrator-worker, handoff, fan-out/fan-in, failure propagation
- [ ] Why infra/browser agents need stronger safety envelopes than Q&A bots

### I can implement...

- [ ] A typed tool runtime with validation, timeouts, and idempotency keys
- [ ] A context assembler with section budgets and tool-result eviction
- [ ] Scoped memory write/retrieve with conflict policy
- [ ] Checkpointed agent loop that can resume after process death (with a runner)
- [ ] Parallel tool execution with structured partial results
- [ ] Handoff or worker brief contracts as versioned schemas
- [ ] Basic browser observation via a11y snapshot tools (or API-first infra tools)

### I can debug...

- [ ] Context pollution / rot using token composition traces
- [ ] Wrong-tool selection via tool confusion analysis
- [ ] Double side effects from retries
- [ ] Multi-agent duplicate work and spawn storms
- [ ] Summarization telephone losses
- [ ] Stuck runs (checkpoint present, execution not resumed)
- [ ] Browser flakiness vs model errors
- [ ] Cost runaways and budget kill behavior

### I can evaluate...

- [ ] Offline golden sets + rubric judges without requiring unique trajectories
- [ ] Online success, CPS (cost per success), and safety incidents
- [ ] Process metrics (loops, tool errors, schema failures)
- [ ] Load tests that stress agent duration and browser pools, not just RPS
- [ ] Whether multi-agent gains justify token tax on *my* task distribution

### I can make trade-offs between...

- [ ] Single agent vs multi-agent vs workflow graphs
- [ ] Bigger windows vs compaction vs external memory
- [ ] JSON mode vs constrained decoding vs repair loops
- [ ] Checkpointers vs durable execution engines
- [ ] A11y automation vs computer-use vs official APIs
- [ ] Autonomy vs human approval vs blast-radius limits
- [ ] Latency, reliability, cost, and engineering complexity under real constraints

---

## Appendix A — Production reading list (primary)

1. Anthropic — *Effective context engineering for AI agents* (2025)
   https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
2. Anthropic — *Building effective agents* (2024)
   https://www.anthropic.com/engineering/building-effective-agents
3. Anthropic — *How we built our multi-agent research system* (2025)
   https://www.anthropic.com/engineering/multi-agent-research-system
4. Anthropic — Context engineering cookbook (memory, compaction, tool clearing)
   https://platform.claude.com/cookbook/tool-use-context-engineering-context-engineering-tools
5. OpenAI — *A practical guide to building agents*
   https://openai.com/business/guides-and-resources/a-practical-guide-to-building-ai-agents/
6. OpenAI — Agents SDK docs
   https://openai.github.io/openai-agents-python/
7. OpenAI — Structured outputs / function calling
   https://developers.openai.com/api/docs/guides/structured-outputs
8. LangGraph — Memory, checkpointers, stores
   https://docs.langchain.com/oss/python/concepts/memory
9. Temporal — Durable execution + LangGraph discussions
   https://temporal.io/blog/temporal-langgraph-plugin-durable-execution
10. Anthropic — Writing tools for agents; MCP ecosystem notes (see engineering blog index)
    https://www.anthropic.com/engineering

## Appendix B — Phase 1 topic map (for spaced review)

| ID | Topic | Anchor sections |
| --- | --- | --- |
| 1.1 | Context engineering | §1.4, §2.1, §3.1–3.2, F1–F2, Pattern A/B |
| 1.2 | Persistent memory | §2.2, §3.3, F3, Pattern B, impl §8.5 |
| 1.3 | Tool-calling | §2.3, §3.4, F4–F5, F11, §8.4 |
| 1.4 | Structured/typed agents | §2.4, §3.5, Ex6, §8 types |
| 1.5 | Long-horizon | §2.5, §3.6, F6, Pattern D, scenario §9 |
| 1.6 | Multi-agent | §2.6, §3.7, F7–F8, Pattern C/G, scenario §9 |
| 1.7 | Infra agents | §2.7, Pattern F, Ex2, F5/F9 |
| 1.8 | Browser agents | §2.8, §3.8, F10, Pattern E, Ex3 |

## Appendix C — Study method for this chapter

1. Skim §1 for the control-loop mental model.
2. Deep-read §2 one subsection per day; restate without notes.
3. For each trade-off table in §3, bind it to a system you have built.
4. Walk §8 code and implement it for real on one tool-backed task.
5. Do §10 exercises before revealing answers.
6. Use §11 weekly; fail openly—gaps become next study targets.
7. Check §12 before claiming Phase 1 complete.

---

*End of Phase 1 study chapter.*
