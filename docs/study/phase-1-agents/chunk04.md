---

## 3. Approaches and Trade-offs

For each major problem, competing approaches. No universal “best.”

### 3.1 Putting knowledge into the model

| Approach | How it works | Optimizes for | Latency | Cost | Reliability | When appropriate | Wrong when |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **Stuff full corpus in context** | concatenate docs | simplicity | high | high | degrades with rot | tiny corpora | anything large/dynamic |
| **Pre-RAG** | embed/retrieve before generation | stable Q&A | med | med | depends on index freshness | knowledge bases | highly exploratory multi-hop research |
| **JIT agentic retrieval** | tools fetch by path/query | freshness, progressive disclosure | higher (multi-turn) | variable | tool design critical | codebases, live systems (Claude Code) | ultra-low-latency single-shot UX |
| **Hybrid** | static core + agent explore | balance | med–high | controllable | best in practice | most production agents | overbuilt for FAQ bots |
| **Subagent isolation** | child explores, returns summary | parallel capacity | parallel wall-clock ↓, tokens ↑ | high (×10–15) | coordination risk | breadth-first research | tightly coupled sequential coding |

### 3.2 Surviving long contexts

| Approach | How | Pros | Cons | Cost/latency |
| --- | --- | --- | --- | --- |
| **Bigger windows** | model upgrade | simple | rot, $ | high $ at scale |
| **Compaction/summarize** | rewrite history | continuity | lossy | extra model call |
| **Tool-result clearing** | drop old payloads | cheap, bounded window | needs re-fetch | near free |
| **External notes/memory** | write outside window | durable across resets | retrieval policy needed | I/O + retrieval |
| **Multi-agent split** | parallel clean windows | scale tokens usefully | orchestration complexity | high tokens |

### 3.3 Memory architectures

| Approach | Pros | Cons | Appropriate |
| --- | --- | --- | --- |
| Transcript-only | trivial | fills window, no structure | prototypes |
| Summary rolling window | cheap continuity | loses detail | chat UX |
| Vector store of chunks | semantic recall | pollution, weak updates | doc Q&A |
| Typed fact store + episodic log | controllable quality | more engineering | multi-tenant products |
| Graph/entity memory | multi-hop relations | extraction errors | CRM/ops domains |
| Filesystem notes | simple, agent-native | weak multi-tenant query | coding agents, personal agents |

### 3.4 Tool execution

| Approach | Optimizes | Latency | Reliability | Wrong when |
| --- | --- | --- | --- | --- |
| Serial tools | simplicity, deps | high wall-clock | easy debug | independent I/O heavy work |
| Parallel tools | wall-clock | lower | partial failure harder | strict dependencies |
| Programmatic tool use (host loops) | context hygiene | can be lower model latency | less model flexibility | open-ended exploration |
| MCP dynamic tools | ecosystem | variable | description quality risk | untrusted tool servers without sandbox |

### 3.5 Structured output

| Approach | Guarantees | Cost | When |
| --- | --- | --- | --- |
| Prompt “return JSON” | weak | low | never production-critical |
| JSON mode | syntax only | low | non-critical parsing |
| Constrained decoding / Structured Outputs | schema adherence | slight decode overhead | tool args, APIs, handoffs |
| Validate + repair loop | business rules | extra turns | complex constraints beyond schema |
| Grammar-constrained DSLs | strong for DSLs | engineering heavy | compilers, SQL, plans |

### 3.6 Long-running control

| Approach | Durability | Complexity | Cost of idle wait | When |
| --- | --- | --- | --- | --- |
| In-process loop | none | low | holds worker | PoC |
| DB checkpoint + job queue | data + DIY resume | med | low if designed well | small/medium prod |
| Agent framework checkpointer | graph state | med | DIY re-entry | agent-native graphs |
| Durable execution engine (Temporal et al.) | execution + state | higher platform | timers cheap | mission-critical multi-hour/day |
| Human approval as durable signal | safety | needs product UX | must not block hot threads | infra/money actions |

### 3.7 Multi-agent topology

| Topology | Strength | Weakness | Cost |
| --- | --- | --- | --- |
| Single agent | simple | context bottleneck | baseline |
| Orchestrator-worker | clear ownership | lead bottleneck if sync | high tokens |
| Peer mesh / teams | flexible collab | chatter, races | high + hard debug |
| Pipeline specialists | predictable | less adaptive | med |
| Hierarchical (manager→teams) | org-scale tasks | deep failure propagation | very high |

Anthropic guidance: scale workers to query complexity (1 agent / few tools for facts; 2–4 for comparisons; 10+ only for hard breadth). Early systems spawned 50 subagents for simple queries—prompt heuristics fixed this.

### 3.8 Browser control

| Approach | Strength | Weakness |
| --- | --- | --- |
| Recorded scripts (Playwright tests) | stable known flows | brittle to product change; not open-ended |
| A11y-tree agent | token-efficient, semantic | incomplete trees, custom widgets |
| Computer-use / pixels | general | slow, expensive, coordinate errors |
| Plan-then-execute code gen | fewer model steps | harder recovery mid-flight |
| Hybrid | production realism | more harness code |

### 3.9 Cost axes summary

Always evaluate an approach on **all eight**:

1. Latency (TTFT, wall-clock to done)
2. Memory/storage (checkpoints, vectors, artifacts)
3. Compute (GPU/CPU for tools, browsers)
4. Monetary (model tokens dominate most agent bills)
5. Reliability (success rate under partial failure)
6. Complexity (ops burden, team size)
7. Security / blast radius
8. Debuggability
