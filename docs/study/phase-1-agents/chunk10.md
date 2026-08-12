---

## 9. Real Production Scenario

**Company:** “Northstar” — B2B research assistant used by ~80k MAU analysts across ~1,200 tenants.
**Feature:** Deep Research (multi-agent), similar in spirit to Anthropic’s Research feature.
**SLO:** 95% of runs finish < 8 minutes; success rubric ≥ 0.75; p95 cost < $1.50/run; zero cross-tenant memory leakage.

### 9.1 Incoming request

Analyst asks: *“Compare the top 5 European neobanks’ 2024–2025 capital raises, lead investors, and regulatory actions; cite primary sources.”*

API gateway authenticates JWT → tenant `acme-capital`, user `u_193`, plan tier `pro`.

Enqueues run `run_7f3a` on research-workers with:

- model pins: lead=`opus-class`, worker=`sonnet-class`
- tool registry version `tools@2026.08.01`
- budget: 1.2e6 tokens, $2 hard cap, max 12 workers, max 40 steps lead

### 9.2 Internal processing

1. **Lead agent** loads:
   - system policy + research heuristics (start broad, then narrow; scale effort)
   - tenant memory: “prefer primary filings; user hates Medium posts”
   - prior episodic: last week’s fintech glossary notes
2. Lead **writes plan to durable memory** early (Anthropic pattern: plan must survive compaction if window exceeds limit).
3. Lead fans out **4 workers** with typed briefs:

```
WorkerBrief:
  objective: "Capital raises for N26 2024-2025"
  must_include: ["amount", "date", "lead_investors", "source_url"]
  tools_allowed: ["web_search", "fetch_url", "browser_a11y"]
  forbidden: ["other_banks"]
  output_schema: FundingEvent[]
  max_tool_calls: 15
```

4. Workers run in **parallel clean contexts**. Each:
   - searches broadly
   - fetches filings/press
   - uses browser a11y only when PDF/HTML tools fail
   - writes raw evidence to artifact store `s3://artifacts/run_7f3a/...`
   - returns **schema-validated** `FundingEvent[]` + artifact refs (not 100k tokens of HTML)

5. Lead synthesizes table; spawns **citation agent** to align claims→sources (Anthropic Research final stage).

6. **Evaluator rubric model** scores completeness/citations offline for logging (not always blocking).

### 9.3 State changes

| Store | Write |
| --- | --- |
| Run checkpoint | after each lead step + worker completion |
| Artifact object store | HTML snapshots, PDFs, intermediate JSON |
| Episodic memory | run summary for user session |
| Semantic memory | optional: “N26 Series X date …” if confidence high and user opted in |
| Audit log | tool calls, URLs, token counts |
| Billing ledger | reserved then finalized cost |

### 9.4 Failure handling mid-flight

- Worker 3’s `fetch_url` times out 3× → worker marks source gap, tries browser tool once, then returns partial with `ok=false` items.
- Lead does **not** treat partial as full; spawns a **repair worker** only for missing bank #5.
- Web search provider 429s → circuit breaker opens 60s; lead switches to backup provider tool.
- Process host dies after worker 2 finishes: durable queue resumes lead from checkpoint; worker 2 results already in artifact store (idempotent).

### 9.5 Observability

Trace `trace_id=...` spans:

```
gateway → enqueue → lead.step2 → worker.w3.fetch_url → artifact.put → lead.synthesize → cite → respond
```

Metrics: tokens by role (lead/worker), tool error rates, source quality histogram, cost burn vs budget, resume count.

Privacy: content of customer queries encrypted at rest; ops dashboards use aggregates + sampled redacted traces (Anthropic-style high-level pattern monitoring).

### 9.6 Recovery & scaling behavior

- Traffic spike Monday 9am: scale **worker** pool faster than lead pool (fan-out asymmetry).
- Browsers are a separate pool with hard cap; excess workers fall back to non-browser tools (graceful degradation).
- Deploy of new tool schema uses **rainbow**: old runs pin `tools@2026.08.01`, new runs get `tools@2026.08.09`.

### 9.7 Theory made concrete

| Theory | Manifestation |
| --- | --- |
| Context is scarce | workers return refs + structured events, not raw pages |
| Multi-agent scales tokens | 4 parallel windows beat one sequential 200k dump |
| Compaction/memory of plan | plan saved outside window |
| Typed boundaries | `FundingEvent[]` schema + citation pass |
| Partial failure | repair worker, not silent success |
| Checkpoint ≠ execution alone | queue + worker liveness resumes run |
| Token economics | budgets + circuit breakers prevent 15× blowups on trivial asks (effort scaling heuristics) |
