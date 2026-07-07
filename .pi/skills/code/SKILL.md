---
name: code
description: "Generate, refactor, or fix code using the Ralph Wiggum Loop (RED → GREEN → REFACTOR → VERIFY → LEARN) — a TDD-first workflow with mandatory security and coding-standard compliance. Use when the task requires writing, refactoring, or fixing code — signals like 'implement', 'write the code', 'fix this bug', 'refactor', 'add a feature', 'make the tests pass'. Requires PRD + IDEAL_STATE from the prd skill (hard dependency). Do not use when the change is already fully specified and trivial (just do it), for pure planning/architecture work (the plan skill), or for non-code deliverables (skribble or synthia)."
license: MIT
metadata:
  penny:
    engine: orchestration
    mempalace: true
    subagents: [echo, annie, carren, piper, skribble]
---

# Code Skill

Ralph Wiggum Loop skill for coding tasks. Takes IDEAL STATE from the prd skill, explores context, analyzes risks, plans implementation, writes code via TDD, verifies output, and iterates until IDEAL STATE is achieved.

## When to Use

- User requests code generation, implementation, or bug fixes
- User mentions writing, building, creating, fixing, or refactoring code
- Task involves file modifications (write, edit)
- Task mentions programming languages or file extensions (.py, .ts, .js, etc.)
- A PRD from the prd skill exists and the user is ready to implement

## When Not to Use

- The user has not yet defined what to build (invoke `prd` skill first)
- Simple text edits or one-line file changes (execute directly)
- Pure exploration or research questions (use `echo` agent directly)
- User explicitly says "just do it" without a clear specification

## PRD Dependency (Hard)

The code skill requires a complete PRD + IDEAL_STATE from the `prd` skill before it can run. `start()` resolves the IDEAL_STATE from `constraints` two ways:

- **Direct** — `constraints.ideal_state` is a dict carrying `success_criteria`.
- **Chain fallback** — `constraints.prd_room` is a room id of the form `"skills/prd-…"`; the skill looks that drawer up in MemPalace (the prd skill writes IDEAL_STATE there).

If neither yields an IDEAL_STATE with `success_criteria`, `start()` raises with chain-contract instructions and the run terminates.

### Chain Contract

```
skill({
  chain: [
    { skill_name: "prd", goal: "<your goal>" },
    { skill_name: "code", goal: "<your goal>" }
  ]
})
```

In chain mode the prd skill writes IDEAL_STATE to `skills/prd-{session_id}/` and injects `constraints.prd_room` for the code skill — the passthrough is automatic.

## Invocation

Invoke via the `skill` tool. The code skill runs on the shared orchestration engine (`orchestration.playbooks.code:CodePlaybook`) — the thin `scripts/orchestrate.py` delegate only routes `start`/`step`/`status`/`recover` to it. Penny's context stays clean: agents communicate via mempalace, and Penny only sees structured per-state summaries.

```
skill({
  skill_name: "code",
  goal: "Your coding goal here",
  project_root: "/path/to/project",
  constraints: { ideal_state: { ... } }   // or prd_room in chain mode
})
```

There is **no `--state-data`**. Run state lives in the engine's durable SQLite checkpointer keyed by `run_id`; an interrupted run auto-resumes from its last checkpoint on the next `step`.

## States

The `CodeMachine` FSM (`orchestration.playbooks.code`) drives:

```
intake → exploring → analyzing → checking_criteria
                                      │
                        ┌────gap──────┤
                        ▼             │ no gap
                  criteria_gate       │
              (refine/accept/skip)    │
                        └─────────────▼
                                  planning
                                      │
                                  plan_gate
                          (approve/refine/deny)
                            │        │        │
                        approve   refine     deny
                            │        └─►planning │
                            ▼                     ▼
                      implementing              error
                            │
                            ▼
                        verifying ⇄ learning
```

Loop semantics:

- `verifying` → `learning`: carren judges the gap between output and IDEAL STATE.
- `learning` `gap=false` → one **final** `verifying` pass → `complete` (regressions loop back to `learning`).
- `learning` `gap=true` **within iteration budget** → `implementing` (Ralph Wiggum retry with the gap findings).
- `learning` `gap=true` **budget spent** → `complete` with `met=False` (never fakes success — records the miss).

Escalation & terminals:

- Any working state (`exploring`, `analyzing`, `checking_criteria`, `planning`, `implementing`, `verifying`, `learning`) → `unknown` → `awaiting_clarification` → resumes at `exploring` once the user clarifies. Triggered by `UNCERTAIN` confidence, or (at `learning`) a stalled retry / repeated failed strategy caught by the engine's progress check.
- `plan_gate` **deny** → `error` (terminal).
- Terminal states: `complete`, `error`.

## Agents

| State | Agent(s) | Role |
|-------|----------|------|
| exploring | echo | Deep dive into affected code areas, find impacted files, verify IDEAL_STATE is achievable |
| analyzing | annie | Security risks, integration surface, dependencies |
| **checking_criteria** | **carren** | **Evaluates the IDEAL_STATE criteria for quality BEFORE planning begins. Checks: is each criterion measurable, achievable, precise, non-overlapping?** |
| criteria_gate | *(HITL)* | **If carren found a gap in the criteria, presents a questionnaire showing which criteria need fixing and why. User can refine, accept as-is, or skip validation.** |
| planning | piper | TDD implementation plan with dependency chains |
| **plan_gate** | *(HITL)* | **Presents the full plan summary (build order, deliverables, criteria) for explicit user approval before any code is written. User can approve, refine, or deny.** |
| implementing | skribble | Write code: RED → GREEN → REFACTOR |
| verifying | skribble | Run lint, type-check, unit, integration, E2E |
| learning | carren | Compare output to IDEAL STATE, decide: iterate or complete |

## Interactive Gates

The code skill pauses for user input at two HITL gates, plus a final verification pass:

### Gate 1 — criteria_gate (checking_criteria gap, before planning)

Carren evaluates the IDEAL_STATE's `success_criteria` for:
1. Are they **measurable** (can we objectively tell if met)?
2. Are they **achievable** within project scope?
3. Are they **precise** (not vague like "works well" or "is fast")?
4. Are they **non-overlapping** (distinct from each other)?

If carren finds gaps, a questionnaire presents the specific issues and the user can:
- **Refine**: Provide improved criterion text → re-evaluated by carren
- **Accept as-is**: Use current criteria despite carren's concerns
- **Skip**: Skip criteria validation entirely

### Gate 2 — plan_gate (planning, before implementing)

Piper's plan (build order, deliverables, success criteria, anti-criteria) is presented as a structured summary. The user must explicitly decide before any code is written:
- **Approve**: Begin implementation
- **Refine**: Rerun the planning state with the user's modifications
- **Deny**: Terminate the run in `error`; no code is written

### Final Verification (learning no-gap, before complete)

When carren reports no gap in `learning`, the skill runs one final `verifying` pass before emitting `complete`. This catches regressions from the last round of fixes; a failing final verify loops back to `learning`.

## Input Contract

`start()` reads the IDEAL_STATE from `constraints` (see **PRD Dependency** above): either `constraints.ideal_state` directly, or `constraints.prd_room` (`"skills/prd-…"`), which is resolved against the following mempalace drawers written by the prd skill:

| Drawer | Source Skill | Content |
|--------|-------------|---------|
| `skills/prd-{session_id}/IDEAL_STATE` | prd | Structured IDEAL STATE JSON matching canonical schema |
| `skills/prd-{session_id}/PRD Narrative` | prd | Prose PRD document (optional, for context) |

There is no `--state-data` transport. Run state (current node, iteration count, per-state summaries) is persisted in the engine's durable SQLite checkpointer keyed by `run_id`; an interrupted run auto-resumes on the next `step`.

## Mandatory Gates

Before any code is written (implement state):
1. Read language-specific coding standards from `resources/<language>.md`
2. Read security checklist from `resources/security-checklist.md`
3. Read applicable secure-coding docs from `docs/agents/secure-coding/`
4. Read `resources/resilience.md` — defensive patterns for all projects
5. If AI frameworks detected: read `resources/ai-application.md`
6. If web UI frameworks detected: read `resources/web-ui.md`

## Resources

- `resources/python.md` — Python coding standards
- `resources/typescript.md` — TypeScript coding standards
- `resources/security-checklist.md` — Mandatory pre-code security review
- `resources/server-startup-tests.md` — **Mandatory** server-startup integration-test checklist for any project that ships a server (FastAPI, Flask, Express, etc.). The verify phase will fail if these tests are missing.
- `resources/ai-application.md` — **Auto-injected** when AI framework imports detected (transformers, openai, langchain, etc.). Covers generation parameters, streaming patterns, system prompt design, model loading, hardware detection, context windows.
- `resources/web-ui.md` — **Auto-injected** when web UI framework detected (Streamlit, React, etc.). Covers CSS selector hygiene, theme system interaction, state synchronization, UI patterns, framework-specific gotchas.
- `resources/resilience.md` — **Always injected**. Language-agnostic defensive patterns: error-boundary state, garbage collection, loading UX, idempotency, graceful degradation.

## Server-Project Verification (Mandatory)

If the project is a server (detected by inspecting `pyproject.toml`, `package.json`, or source-file imports for FastAPI / Flask / Express / etc.), the orchestrator automatically enables an additional verification tier: **`verification.server_startup`**. The plan, implement, and verify phases all gain server-specific instructions:

- **plan** — piper's plan must include a server-startup integration-test phase.
- **implement** — skribble is given an explicit four-category checklist it must satisfy: (1) real server, real HTTP, (2) entry-point-script-from-its-own-directory, (3) CORS preflight if applicable, (4) end-to-end happy path.
- **verify** — skribble must explicitly check for tests in all four categories and FAIL verification if any are missing. Unit tests alone are not sufficient for a server project.

This is enforced, not optional. Unit tests with mocked framework classes consistently miss a class of real-world bugs (CORS misconfiguration, import-chain breakage when cwd changes, port conflicts, lifespan-event typos). See `resources/server-startup-tests.md` for the full rationale and copy-pastable patterns.

## IDEAL STATE Validation

The IDEAL STATE is produced and validated by the prd skill. The code skill assumes it is valid on arrival — `start()` only checks that it carries `success_criteria`, and enriches its `verification` block with server-startup detection before exploring begins.

## Outcome Capture

The engine records the run outcome automatically — no manual mempalace writes.
On completion it captures `met`, the resolved `success_criteria` (surfaced from the
IDEAL_STATE at `start()`), iteration count, and the per-state summaries against the
run's `run_id`. Agents write their working notes to the mempalace room
`skills/code-{session_id}` during the run; the engine's checkpointer is the source
of truth for run state.
