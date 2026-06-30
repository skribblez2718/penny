---
name: code
description: "Use for code generation, refactoring, or bug fixes using the Ralph Wiggum Loop (RED → GREEN → REFACTOR → VERIFY → LEARN). TDD-first workflow with mandatory security and coding standard compliance. Requires PRD + IDEAL_STATE from the prd skill (hard dependency). Do not use for: well-defined code changes the user has already specified in detail (just do it), pure planning/architecture work (use plan skill), or non-code deliverables."
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

The code skill requires a complete PRD + IDEAL_STATE from the `prd` skill before it can run. The prd skill writes IDEAL_STATE to mempalace room `skills/prd-{session_id}/`. The code skill reads from this room on startup via `--state-data`.

### Chain Contract

```
skill({
  chain: [
    { skill_name: "prd", goal: "<your goal>" },
    { skill_name: "code", goal: "<your goal>" }
  ]
})
```

If invoked without a prior PRD, the skill emits an `error` action with chain-contract instructions.

## Invocation

Invoke via the `skill` tool. The skill extension handles orchestration — agents communicate via mempalace, Penny receives structured summaries.

The skill extension handles the entire orchestration loop: Python orchestrator → subagent invocation → summary extraction → state advancement → repeat until complete. Penny's context stays clean — agents communicate via mempalace, and Penny only sees structured summaries.

```
skill({
  skill_name: "code",
  goal: "Your coding goal here",
  project_root: "/path/to/project",
  constraints: { /* optional */ }
})
```

If run as part of a chain with the `prd` skill, the chain mode handles PRD+IDEAL_STATE passthrough automatically.

## States

```
explore → analyze → criteria → plan → plan_approval → implement → verify → learn
              ↑            ↓            ↓                         ↑          ↓    ↓
              │      criteria_fix     plan refine               (loop)     verify  complete
              │      (user input)        │                                 (final)
              └──────────┘               └──────────────────────────────────────┘

Terminal: complete, error
Escalation: unknown → awaiting_clarification → resume → explore
```

## Agents

| State | Agent(s) | Role |
|-------|----------|------|
| explore | echo | Deep dive into affected code areas, find impacted files, verify IDEAL_STATE is achievable |
| analyze | annie | Security risks, integration surface, dependencies |
| **criteria** | **carren** | **Evaluates the IDEAL_STATE criteria for quality BEFORE planning begins. Checks: is each criterion measurable, achievable, precise, non-overlapping?** |
| criteria_fix | *(escalation)* | **If carren found gaps in the criteria, presents a questionnaire to the user showing which criteria need fixing and why. User can refine, accept as-is, or skip validation.** |
| plan | piper | TDD implementation plan with dependency chains |
| **plan_approval** | *(escalation)* | **Presents the full plan summary (build order, deliverables, criteria) for explicit user approval before any code is written. User can approve, deny, or request refinement.** |
| implement | skribble | Write code: RED → GREEN → REFACTOR |
| verify | skribble (tools) | Run lint, type-check, unit, integration, E2E |
| learn | carren | Compare output to IDEAL STATE, decide: iterate or complete |

## Interactive Gates

The code skill pauses for user input at two critical decision points:

### Gate 1 — Criteria Validation (after analyze, before plan)

Carren evaluates the IDEAL_STATE's `success_criteria` for:
1. Are they **measurable** (can we objectively tell if met)?
2. Are they **achievable** within project scope?
3. Are they **precise** (not vague like "works well" or "is fast")?
4. Are they **non-overlapping** (distinct from each other)?

If carren finds gaps, a questionnaire presents the specific issues and the user can:
- **Refine**: Provide improved criterion text → re-evaluated by carren
- **Accept as-is**: Use current criteria despite carren's concerns
- **Skip**: Skip criteria validation entirely

### Gate 2 — Plan Approval (after plan, before implement)

Piper's plan (build order, deliverables, success criteria, anti-criteria) is presented as a structured summary. The user must explicitly approve before any code is written:
- **Approve**: Begin implementation
- **Refine**: Rerun the plan phase with user's modifications
- **Deny**: Stop, no code written

### Gate 3 — Final Verification (after learn, before complete)

When carren says no-gap in the learn phase, the skill runs one final verify pass before emitting complete. This catches regressions from the last round of fixes.

## Mempalace Input Contract

The code skill reads the following from mempalace on startup:

| Drawer | Source Skill | Content |
|--------|-------------|---------|
| `skills/prd-{session_id}/IDEAL_STATE` | prd | Structured IDEAL STATE JSON matching canonical schema |
| `skills/prd-{session_id}/PRD Narrative` | prd | Prose PRD document (optional, for context) |

The `--state-data` CLI argument carries a JSON blob with at minimum:
```json
{
  "ideal_state": { ... },
  "goal": "What we're building"
}
```

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

The IDEAL STATE is produced by the prd skill and validated against `scripts/validate_ideal_state.py`. The code skill assumes the IDEAL STATE is valid on arrival.

## Post-Completion

After completion:
- Store session record in mempalace: `wing="penny", room="skills"`
- KG link: `memory_kg_add("CodeSession:<id>", "completed", "Skill:code")`
- Trigger outcome ledger feedback for any consequential decisions

## Storing Learnings

After the skill is complete, store learnings in mempalace:

```python
memory_add_drawer(
    wing="penny",
    room="skills",
    content="## Code Skill Session Summary\n\n**Session ID:** {session_id}\n**Goal:** {goal}\n**Success:** {is_success}\n**Steps:** {step_count}\n**Key Decisions:** {decisions}"
)

memory_kg_add(f"SkillSession:{session_id}", "completed", f"Skill:code:{goal[:50]}")
```
