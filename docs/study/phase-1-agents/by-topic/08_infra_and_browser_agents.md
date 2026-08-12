# 8. Infrastructure Agents & Browser Agents

These two domains share a property: **side effects and environment stochasticity dominate model IQ**. They are where agent demos most often die in production.

---

# Part A — Autonomous infrastructure agents

> Anchors: plan→act→observe→reflect loops; cloud/IaC practice; approval gates; audit requirements.

## A.1 Loop

```
plan → (dry-run / diff) → approve? → act → observe → reflect → replan or stop
```

The dry-run and approval stages are not optional cosmetics for production infrastructure. They are the difference between an agent and a chaos monkey with an API key.

## A.2 Safe side effects

### Capability model

Bind each tool to least-privilege credentials:

- read tools → read-only roles;
- mutate tools → narrow resource ARNs / namespaces;
- break-glass tools → human-held, not agent-held.

### Diff-first culture

Before mutate:

- `terraform plan`
- `kubectl diff`
- SQL in transaction with `EXPLAIN` / dry run modes
- “create change request object” that another system applies

### Blast radius limits

Encode hard caps:

- max nodes touched per step;
- max spend delta;
- allowed environments (`dev` open, `prod` gated);
- time windows (no deploys during freeze).

### Rollbacks

Every mutation class needs:

- reverse operation, or
- snapshot/restore point, or
- forward-fix runbook linked in the audit entry.

An agent that can “scale to 50” but cannot “scale back” is incomplete.

## A.3 Guardrails vs content filters

People hear “guardrails” and think toxicity filters. For infra agents, guardrails are **control-plane policy**:

- static allowlists of resources;
- OPA/Cedar policies on tool args;
- rate limits on mutators;
- mandatory second channel approval for high risk.

## A.4 Human approval boundaries

Put humans where expected cost of error exceeds cost of delay:

- production data deletion;
- security group 0.0.0.0/0;
- IAM policy widening;
- spend above threshold;
- actions outside change window.

Approvals must be durable (see long-horizon file). Slack “yes” scraped from a channel without authZ binding is not an approval system.

## A.5 Auditability

Append-only log:

- who (user, tenant, agent version, model pin);
- what intent (structured);
- what command/API;
- what result;
- correlation IDs to cloud audit trails.

Security teams will ask for this after the first incident. Build it first.

## A.6 Partial failure in infra

Example: rolling restart across 12 services; 9 succeed, 3 fail.

The agent must:

- represent partial state explicitly;
- not mark the change “complete”;
- propose repair or rollback for the failed subset;
- avoid naive full retries that double-restart the healthy 9 without reason.

---

# Part B — Browser-using agents

> Anchors: Playwright/CDP architectures; accessibility trees vs screenshots/computer-use; selector drift; session/auth; production eval flakiness.

## B.1 Why browser agents exist

Because many systems still only expose a UI. Browser agents are **RPA with a stochastic planner**. That heritage matters: RPA already taught us about flaky selectors, auth pain, and the cost of UI churn.

## B.2 Control architecture

```
Agent runtime
   │ tool calls: navigate, click, type, snapshot, wait
   v
Browser controller service
   │ Playwright / Puppeteer / raw CDP
   v
Headless browser instance (pooled, sandboxed)
   │
   ├─ cookies / localStorage (session)
   ├─ tabs / frames
   └─ network egress policy
```

Separate the **browser pool** from the **LLM workers**. Browsers are RAM/CPU heavy and fail differently.

## B.3 Observation modalities

| Modality | What model sees | Tokens | Strengths | Weaknesses |
| --- | --- | --- | --- | --- |
| Raw DOM/HTML | markup | high | complete-ish | noisy, brittle, scripts |
| **Accessibility tree** | roles, names, states | low-med | semantic, stable-ish, cheap | incomplete for custom widgets |
| Screenshot / computer-use | pixels | high | works without a11y | coordinate errors, cost, latency |
| Hybrid | a11y first, vision fallback | med | production pragmatic | more harness complexity |

Emerging engineering consensus in serious write-ups: **prefer structured text (a11y) as primary**; use vision when the tree is insufficient. Pure computer-use demos are impressive; economics and reliability often lose at volume.

Accessibility snapshots often land in the low-kilobyte range; screenshots can be tens or hundreds of KB of image tokens—material under agent loops.

## B.4 Actions and grounding

The hard problem is **grounding**: mapping intent → concrete target.

- a11y role/name locators (“button: Submit”) beat CSS `.css-1x2y3z`;
- pixel click `(x,y)` is sensitive to layout, animations, DPI;
- DOM xpath breaks when frontend ships a redesign.

**Selector drift** is the browser analogue of schema evolution: the world changes under you.

## B.5 Sessions, auth, cookies

Production issues:

- SSO flows with human 2FA;
- short-lived cookies;
- secrets leaking into prompts/traces if you dump headers;
- cross-tenant session mixups if pool isolation is wrong.

Patterns:

- dedicated browser context per run/tenant;
- secret injection via controller, not via model-visible text when possible;
- explicit re-auth tools with human handoff;
- encrypt session blobs at rest.

## B.6 Dynamic DOMs and recovery

Pages load async; modals appear; network is slow; A/B UIs differ.

Recovery policies:

- wait strategies (network idle, selector available, custom conditions);
- modal dismiss playbooks (cookie banners);
- bounded retry with new snapshot;
- “re-navigate from known URL” reset;
- escalate to human on captcha / bot wall.

Captchas and bot defenses are not a prompting problem. Plan for human or specialized services; do not pretend the agent will always “figure it out.”

## B.7 Long-running browser tasks

Challenges:

- memory leaks in browser processes;
- tab explosions;
- session expiry mid-job;
- checkpointing: save URL + storage state + task plan, not only chat history.

Kill and recreate browsers aggressively; they are cattle, not pets.

## B.8 Evaluation

Browser agents need **site-versioned** evals:

- success rate per workflow;
- median steps;
- flaky rate (same task, multiple runs);
- time and $ per success;
- breakage alerts when customer site DOM hash patterns change.

A model upgrade that “reasons better” can still lose if the locator strategy is wrong.

## B.9 Approaches and trade-offs

| Approach | Reliability | $/task | Maint. | When |
| --- | --- | --- | --- | --- |
| Scripted Playwright | high on stable flows | low | high when UI changes | top-N critical paths |
| A11y agent | med-high | med | med | long tail forms |
| Computer-use | med (variable) | high | lower locator maint, higher ops $ | novel UIs, low volume |
| API reverse engineering | highest if legal/stable | low | med | when possible, prefer over browser |
| Hybrid router | high overall | optimized | highest eng | real production estates |

## B.10 Shared lesson across infra + browser

If an official API or control plane exists, **prefer it over driving the UI or scraping**. Agents should use the highest-leverage, lowest-entropy interface available. Browser and shell are escape hatches, not default flexes.

Next: `09_production_path_and_failures.md`.
