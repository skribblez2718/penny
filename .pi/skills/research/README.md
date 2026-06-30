# Research Skill

Structured, production-grade research workflow with Quick/Standard/Deep modes. Orchestrates parallel evidence gathering, validation, and synthesis into coherent reports.

## Architecture

```
┌─────────────────────────────────────────────┐
│  Penny invokes skill tool                   │
│  skill({ skill_name: "research", goal: "..." }) │
└──────────────────┬──────────────────────────┘
                   │
┌──────────────────▼──────────────────────────┐
│  Skill Extension (TypeScript)               │
│  ┌─────────────────────────────────────┐    │
│  │ Loop:                               │    │
│  │  1. Python orchestrate.py → Action  │    │
│  │  2. Subagent tool → Agent result    │    │
│  │  3. Extract SUMMARY → Feed to Python│    │
│  │  4. Repeat until complete/error     │    │
│  └─────────────────────────────────────┘    │
└──────────────────┬──────────────────────────┘
                   │
┌──────────────────▼──────────────────────────┐
│  Python State Machine (orchestrate.py)      │
│  intake → planning → [critiquing_plan] →   │
│  researching → [validating] → synthesizing │
│  → [critiquing_report] → complete          │
└──────────────────┬──────────────────────────┘
                   │
┌──────────────────▼──────────────────────────┐
│  Subagents (fresh context each)             │
│  Piper → Echo (parallel) → Vera → Synthia  │
│  All read/write via mempalace               │
│  Only SUMMARY goes back to orchestrator    │
└─────────────────────────────────────────────┘
```

**Key principle: Penny's context stays clean.** Agents communicate via mempalace — Penny never sees full agent output. The orchestrator only receives structured summaries.

## State Machine

```
Quick Mode:
┌─────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────┐
│  intake │ ──▶ │ researching │ ──▶ │ synthesizing│ ──▶ │ complete│
└─────────┘     └─────────────┘     └─────────────┘     └─────────┘

Standard Mode:
┌─────────┐     ┌─────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────┐
│  intake │ ──▶ │ planning│ ──▶ │ researching │ ──▶ │ synthesizing│ ──▶ │ complete│
└─────────┘     └─────────┘     └─────────────┘     └─────────────┘     └─────────┘

Deep Mode:
┌─────────┐     ┌─────────┐     ┌──────────────┐     ┌─────────────┐
│  intake │ ──▶ │ planning│ ──▶ │critiquing_plan│ ──▶ │ researching │
└─────────┘     └─────────┘     └──────────────┘     └─────────────┘
                                              │
                                              ▼
┌─────────────┐     ┌─────────────┐     ┌──────────────┐     ┌─────────┐
│  validating │ ──▶ │ synthesizing│ ──▶ │critiquing_rep│ ──▶ │ complete│
└─────────────┘     └─────────────┘     └──────────────┘     └─────────┘
```

### States

| State                    | Description           | Entry Action                           |
| ------------------------ | --------------------- | -------------------------------------- |
| `intake`                 | Initial state         | Detect mode from query, validate goal  |
| `planning`               | Decompose query       | Run Piper agent with research context  |
| `critiquing_plan`        | Validate plan quality | Run Carren agent (deep only)           |
| `researching`            | Gather evidence       | Run parallel Echo agents per sub-query |
| `validating`             | Cross-check findings  | Run Vera agent (deep only)             |
| `synthesizing`           | Generate report       | Run Synthia agent                      |
| `critiquing_report`      | Validate synthesis    | Run Carren agent (deep only)           |
| `unknown`                | Uncertainty detected  | Escalate to user for clarification     |
| `awaiting_clarification` | Waiting for user      | Store user response, resume            |
| `complete`               | Research done         | Store outcome, return report metadata  |
| `error`                  | Terminal failure      | Log error, return diagnostics          |

### Transitions

| Transition          | From              | To                | Condition                |
| ------------------- | ----------------- | ----------------- | ------------------------ |
| `start`             | intake            | planning          | has_goal AND not quick   |
| `quick_research`    | intake            | researching       | is_quick_mode            |
| `plan_done`         | planning          | critiquing_plan   | is_deep_mode             |
| `plan_to_research`  | planning          | researching       | is_standard_mode         |
| `critique_pass`     | critiquing_plan   | researching       | critique_approved        |
| `critique_revise`   | critiquing_plan   | revising_plan     | has_issues               |
| `revise_plan`       | revising_plan     | planning          | —                        |
| `research_done`     | researching       | validating        | is_deep_mode             |
| `research_to_synth` | researching       | synthesizing      | is_standard_mode         |
| `validate_done`     | validating        | synthesizing      | validation_complete      |
| `quick_to_synth`    | researching       | synthesizing      | is_quick_mode            |
| `synthesize_done`   | synthesizing      | critiquing_report | is_deep_mode             |
| `synth_to_complete` | synthesizing      | complete          | not deep                 |
| `report_pass`       | critiquing_report | complete          | report_critique_approved |
| `report_revise`     | critiquing_report | revising_report   | report_has_issues        |
| `revise_report`     | revising_report   | synthesizing      | —                        |

## Agent Responsibilities

| Agent       | When Invoked              | What It Does                           | Mode           |
| ----------- | ------------------------- | -------------------------------------- | -------------- |
| **Piper**   | After intake              | Decomposes query into sub-queries      | Standard, Deep |
| **Carren**  | After planning (deep)     | Critiques sub-query quality            | Deep only      |
| **Carren**  | After synthesis (deep)    | Critiques report legitimacy            | Deep only      |
| **Echo**    | After planning            | Researches ONE sub-query in parallel   | All            |
| **Vera**    | After research            | Validates findings, resolves conflicts | Deep only      |
| **Synthia** | After research/validation | Synthesizes all findings into report   | All            |

## Mempalace Room Organization

**Room:** `skills/research-{session_id}`

| Drawer                  | Written By   | Content                       |
| ----------------------- | ------------ | ----------------------------- |
| `{sid} state`           | Orchestrator | FSM state blob                |
| `{sid} plan`            | Piper        | Sub-queries, scope, rationale |
| `{sid} echo-{n}`        | Echo         | Findings for sub-query N      |
| `{sid} validation`      | Vera         | Validation report, conflicts  |
| `{sid} synthesis`       | Synthia      | Final report                  |
| `{sid} critique-plan`   | Carren       | Plan critique verdict         |
| `{sid} critique-report` | Carren       | Report critique verdict       |

## Credibility Framework

Embedded in Echo's domain guidance (`assets/prompts/echo.md`):

**Source Tiers:**

- ✓T1 — Primary/Authoritative (official docs, RFCs, arXiv)
- ○T2 — Expert/Established (ACM Queue, official blogs)
- ◇T3 — Community/Practitioner (SO, dev.to, tutorials)
- ?T4 — Unverified/Commercial (product pages, SEO)

**Confidence Markers:** ✅ High | ⚠️ Medium | ❓ Low | ⚡ Conflicting

**Quality Gate (deep):** 2+ T1 sources OR 3+ T2 sources.

## Error Handling

| Error Type              | Behavior                                                        |
| ----------------------- | --------------------------------------------------------------- |
| Agent SUMMARY malformed | Log error, retry once, then transition to `error`               |
| Agent SUMMARY empty     | Log error, transition to `error`                                |
| Parallel task failure   | Mark task failed, continue with remaining tasks if ≥1 succeeded |
| All parallel tasks fail | Transition to `unknown` → questionnaire → resume                |
| State restore failure   | Redirect to `planning` with error context preserved             |
| Mempalace write failure | Log error, transition to `error`                                |

## Failure Modes

See `SKILL.md` for escalation handling. The orchestrator is resilient to:

- SSE timeouts (returns error, does not fabricate)
- Missing `message_end` signals (returns error)
- Malformed agent output (validates SUMMARY, rejects on failure)
- State corruption (restores from mempalace, falls back to `planning`)

## Testing

| Test File                   | What It Tests                                     |
| --------------------------- | ------------------------------------------------- |
| `tests/test_unit.py`        | State machine transitions, guards, mode detection |
| `tests/test_integration.py` | Mempalace read/write, state serialization         |
| `tests/test_e2e.py`         | Full skill invocation for each mode               |
