# Plan Skill — Structured planning workflow

## What

A skill that breaks complex goals into actionable, execution-grade plans. It gathers evidence, synthesizes a plan, critiques it, and converts it into a structured task list. Penny presents the result for approval before any step is executed.

## Why

Complex tasks with dependencies, high stakes, or multiple execution paths benefit from explicit planning. The skill separates planning from execution so the user can approve or refine the approach before work begins.

## Rules

1. **Use for multi-step or high-stakes goals.** Do not use for typos, single-step fixes, or when the user says "just do it".
2. **Penny is a router.** Agents (`echo`, `piper`, `carren`, `tabitha`) communicate via mempalace (`skills/plan-<session_id>`); Penny only sees summaries.
3. **Approval is required before execution.** The skill stops at `complete` and waits for user approval/refinement/denial.
4. **UNCERTAIN confidence triggers UNKNOWN_STATE.** Any agent returning `confidence: UNCERTAIN` pauses for user clarification.
5. **High-stakes plans enter a verification gate.** When stakes are high, the FSM pauses in `verifying` for explicit user confirmation.

## Procedure

### Invocation

```typescript
skill({
  skill_name: "plan",
  goal: "Refactor the authentication system to use OAuth2",
  project_root: "/path/to/project",
})
```

Optional constraints:

| Constraint | Values | Effect |
|------------|--------|--------|
| `stakes` | `high`, `medium`, `low` | Drives verification threshold |
| `verification_mode` | `default`, `strict`, `relaxed`, `off` | Controls verification behavior |

### State machine phases

```
                 ┌─────────────┐
                 │  verifying  │ (high-stakes gate)
                 └──────┬──────┘
                        │ confirm / reject / escalate
┌─────────┐    ┌────────▼─────┐    ┌─────────┐    ┌───────────┐    ┌──────────┐
│  intake │───▶│   exploring  │───▶│ planning│───▶│ critiquing │───▶│ taskify  │
└─────────┘    └──────────────┘    └─────────┘    └───────────┘    └──────────┘
      │                │                │               │
      │                └────────────────┘               │
      │            (revising → exploring or planning)        │
      └────────────────────────────────────────────────────┘
                 (revising → taskifying on critique pass)
```

| State | Agent | Purpose | Output to mempalace |
|-------|-------|---------|----------------------|
| `intake` | — | Validate goal | — |
| `exploring` | `echo` | Gather context from files, web, mempalace | Findings, files, unknowns |
| `planning` | `piper` | Synthesize findings into execution-grade plan | Full plan text |
| `verifying` | — | High-stakes user confirmation gate | Escalation question |
| `critiquing` | `carren` | Validate plan quality (CREST framework) | Verdict, issues |
| `revising` | — | Decide whether to re-explore or re-plan | — |
| `taskifying` | `tabitha` | Convert approved plan into structured JSON | Structured plan JSON |
| `complete` | — | Return plan summary | — |
| `unknown` / `awaiting_clarification` | — | UNKNOWN_STATE protocol | Clarification questions |
| `error` | — | Terminal failure | Errors |

### Parallel exploration

For goals containing keywords like `migrate`, `refactor`, `implement`, `integrate`, `architecture`, or `system`, the explore phase splits into parallel tracks:

1. Entry points and call graph
2. Tests and build pipeline
3. Configuration and dependencies

Results are merged before planning.

### Approval cycle

After `complete`:

1. Fetch the strategic plan and task breakdown from mempalace.
2. Present both via `questionnaire` with options: **Approve**, **Refine**, **Deny**.
3. On **approve**: begin executing plan steps.
4. On **refine**: re-invoke with `constraints: { refinement_context: "<notes>" }`.
5. On **deny**: stop.

### UNKNOWN_STATE resume options

When the FSM enters `awaiting_clarification`, the user can choose:

| Value | Effect |
|-------|--------|
| `restart` | Abandon the session |
| `skip` | Clear the blocker and resume the previous state |
| `retry` (default) | Resume the previous state with the same context |

## Constraints

- Max revision cycles are bounded (default `PLAN_MAX_ITERATIONS=3`).
- Parallel explore is enabled by default (`PLAN_EXPLORE_PARALLEL=true`) with a cap.
- Safe default summaries never claim completion; empty or malformed agent output stops the FSM.
- Session state is persisted for resilience across subprocess boundaries.

## Verification

- [ ] Plan contains concrete steps with dependencies and acceptance criteria.
- [ ] Carren critique returned `APPROVE` (or was satisfied after revisions).
- [ ] High-stakes plans received explicit user confirmation in `verifying`.
- [ ] No agent returned `confidence: UNCERTAIN` without escalation.
- [ ] User approved the plan before execution began.

## Files

| File | Purpose |
|------|---------|
| `.pi/skills/plan/SKILL.md` | Skill definition and post-completion procedure |
| `.pi/skills/plan/README.md` | Architecture, domains, and failure modes |
| `.pi/skills/plan/scripts/orchestrate.py` | Python FSM and CLI |
| `.pi/skills/plan/assets/prompts/*.md` | Agent prompts |
| `.pi/skills/plan/tests/test_*.py` | Unit, integration, and E2E tests |
| `docs/humans/capabilities/plan-skill/plan-skill.md` | Human-facing overview |
