# Research Skill — Structured evidence-based research

## What

A multi-agent research workflow that investigates a query, assesses source credibility, resolves conflicts, and synthesizes a coherent report. It operates at three depths: Quick, Standard, and Deep.

## Why

Agents need to ground claims in evidence. The research skill separates evidence gathering from synthesis, tracks source quality, and flags uncertainty rather than fabricating consensus.

## Rules

1. **Use for complex or multi-source questions.** Do not use for simple lookups (`web_search` directly), code implementation, or when you already have enough information.
2. **Penny is a router.** Agents communicate via mempalace (`skills/research-<session_id>`); Penny only sees summaries.
3. **Mode is auto-detected but can be overridden.** Use `constraints.mode` only when the default detection is wrong.
4. **Credibility tiers are mandatory.** Echo classifies every source as T1–T4; Synthia uses those tiers when assigning confidence.
5. **Deep mode adds critique gates.** Plan critique and report critique catch gaps and overclaiming.
6. **The skill returns a report, not decisions.** Do not execute recommendations without user approval.

## Procedure

### Invocation

```typescript
skill({
  skill_name: "research",
  goal: "What are the tradeoffs of microservices vs monoliths?",
  project_root: "/path/to/project",
})
```

Optional constraints:

| Constraint | Values | Default | Description |
|------------|--------|---------|-------------|
| `mode` | `auto`, `quick`, `standard`, `deep` | `auto` | Research depth |
| `report_format` | `default`, `brief`, `academic`, `executive` | `default` | Output style |
| `max_sub_queries` | int | mode-dependent | Override parallel sub-query limit |

### Mode detection

| Mode | Triggers |
|------|----------|
| **Quick** | Short single-question queries containing "what is", "define", "overview", "quickly" |
| **Deep** | Phrases like "deep research", "comprehensive", "thorough", "detailed analysis" |
| **Standard** | Everything else |

### State machine phases

#### Quick mode

```
intake → researching → synthesizing → complete
```

Agents: `echo` → `synthia`

#### Standard mode

```
intake → planning → researching → synthesizing → report_writing → complete
```

Agents: `piper` → parallel `echo` → `synthia`

#### Deep mode

```
intake → planning → critiquing_plan → researching → synthesizing → critiquing_report → report_writing → complete
```

Agents: `piper` → `carren` → parallel `echo` → `synthia` → `carren`

### State descriptions

| State | Agent | Purpose |
|-------|-------|---------|
| `intake` | — | Validate query, detect mode |
| `planning` | `piper` | Decompose query into sub-queries |
| `critiquing_plan` | `carren` | Review sub-query quality (deep only) |
| `revising_plan` | — | Fix plan issues (deep only) |
| `researching` | `echo` | Gather evidence for one sub-query per agent invocation; runs in parallel |
| `synthesizing` | `synthia` | Merge findings into a coherent report |
| `critiquing_report` | `carren` | Review synthesis for overclaiming and bias (deep only) |
| `revising_report` | — | Fix report issues (deep only) |
| `report_writing` | `synthia` | Format final report |
| `complete` | — | Return report metadata |
| `unknown` / `awaiting_clarification` | — | UNKNOWN_STATE protocol |
| `error` | — | Terminal failure |

### Credibility framework

| Tier | Name | Examples |
|------|------|----------|
| T1 | Primary / Authoritative | Official docs, RFCs, arXiv papers, specs |
| T2 | Expert / Established | ACM Queue, official blogs, recognized experts |
| T3 | Community / Practitioner | High-vote Stack Overflow, dev.to, tutorials |
| T4 | Unverified / Commercial | Product pages, SEO content, unknown blogs |

Confidence markers used in the report:

| Marker | Meaning |
|--------|---------|
| ✅ High | Multiple authoritative sources agree |
| ⚠️ Medium | Some credible support |
| ❓ Low | Thin or lower-tier evidence |
| ⚡ Conflicting | Sources disagree |

### Deep-mode quality gates

1. **Plan critique** — Carren reviews Piper's sub-query plan before dispatch.
2. **Report critique** — Carren reviews Synthia's final report for overclaiming, bias, and fairness to conflicting evidence.
3. **Conflict resolution** — Uses a 5-step hierarchy: tier authority → recency → consensus → context match → escalation.

### Mempalace room organization

Room: `skills/research-<session_id>`

| Drawer | Content |
|--------|---------|
| `{sid} state` | FSM state blob |
| `{sid} plan` | Sub-queries, scope, rationale |
| `{sid} echo-{n}` | Findings for sub-query N |
| `{sid} validation` | Validation report, conflicts (deep mode) |
| `{sid} synthesis` | Final report |
| `{sid} critique-plan` | Plan critique verdict (deep mode) |
| `{sid} critique-report` | Report critique verdict (deep mode) |

## Constraints

| Mode | Min sub-queries | Max sub-queries | Min tool invocations |
|------|-----------------|-----------------|----------------------|
| Quick | 1 | 1 | 3 |
| Standard | 2 | 3 | 5 |
| Deep | 3 | 4 | 7 |

- Parallel sub-query dispatch is bounded by mode.
- Malformed or empty agent summaries stop the FSM (no fabricated defaults).
- Sessions can be interrupted and resumed from mempalace.

## Verification

- [ ] Report includes executive summary, key findings, source count/quality, recommendations, and constraints.
- [ ] Every key finding has a confidence marker.
- [ ] Conflicting evidence is reported, not smoothed over.
- [ ] Sources are classified T1–T4.
- [ ] Deep mode includes both plan critique and report critique.

## Files

| File | Purpose |
|------|---------|
| `.pi/skills/research/SKILL.md` | Skill definition and invocation |
| `.pi/skills/research/README.md` | Architecture, state machine, and credibility framework |
| `.pi/skills/research/scripts/orchestrate.py` | Python FSM and CLI |
| `.pi/skills/research/assets/prompts/*.md` | Agent prompts |
| `.pi/skills/research/tests/test_*.py` | Unit, integration, and E2E tests |
| `docs/humans/capabilities/research-skill/research-skill.md` | Human-facing overview |
