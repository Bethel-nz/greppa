# Phase 1 — Agents (expanded study pack)

This is the **uncompressed** version of the study material.

The earlier `FULL_CHAPTER.md` was deliberately dense (written under pressure to fit Craft MCP chunk uploads). **Do not study from that file as primary material.** Use this `by-topic/` pack instead.

## How to read

| Order | File | Focus |
| --- | --- | --- |
| 1 | `01_mental_model.md` | What agents actually are; control loop; terminology |
| 2 | `02_context_engineering.md` | Token budgets, selection, compaction, pollution, debugging |
| 3 | `03_persistent_memory.md` | Working/episodic/semantic/procedural; writes; isolation |
| 4 | `04_tool_calling.md` | Schemas, selection, parallel, retries, idempotency |
| 5 | `05_structured_typed_agents.md` | JSON mode → constrained decoding → contracts |
| 6 | `06_long_horizon_agents.md` | Plans, checkpoints, durable execution, recovery |
| 7 | `07_multi_agent_systems.md` | Topologies, handoffs, failure propagation |
| 8 | `08_infra_and_browser_agents.md` | Side-effect safety + browser observation stacks |
| 9 | `09_production_path_and_failures.md` | PoC→prod, failure modes, architecture patterns |
| 10 | `10_evaluation_and_implementation.md` | Metrics, reference impl, production scenario |
| 11 | `11_exercises_and_mastery.md` | Decision exercises, knowledge check, mastery list |

## Primary production sources (re-read these)

1. Anthropic — Effective context engineering for AI agents (2025)
2. Anthropic — Building effective agents (2024)
3. Anthropic — How we built our multi-agent research system (2025)
4. Anthropic — Context engineering cookbook (compaction / clearing / memory)
5. OpenAI — A practical guide to building agents + Agents SDK
6. OpenAI — Structured Outputs & function calling
7. LangGraph — Memory, checkpointers, stores
8. Temporal engineering notes — checkpoints vs durable execution

## Study method

For each topic file: read once for map → restate mechanisms without looking → implement one small piece → do the knowledge checks in file 11 for that topic.
