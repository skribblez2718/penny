---
name: code
description: Write, refactor, or fix code — verified by passing tests at the applicable tiers, with security and coding-standard compliance built in. Use when the task requires implementing a feature, fixing a bug, or refactoring; runs standalone or as a prd → code chain (a PRD + IDEAL_STATE is used when available, otherwise lightweight criteria are synthesized from the goal). Do not use when the change is fully specified and trivial (just do it), for pure planning or architecture work (the plan skill), or for non-code deliverables (skribble or synthia).
license: MIT
metadata:
  penny:
    engine: orchestration
    mempalace: true
    subagents: [echo, annie, carren, piper, skribble]
---

# Code Skill

Ralph Wiggum Loop skill for coding tasks. Works from an IDEAL STATE — supplied by the prd skill when chained, or synthesized from the goal when run standalone — then explores context, analyzes risks, plans implementation, writes code and its tests, verifies output, and iterates until the IDEAL STATE is achieved.

## P0 Completion Contract

Every schema-v2 run selects schema-versioned artifacts for the IDEAL STATE, target profile, Piper plan, and one immutable, non-waivable six-dimension quality floor: **security, scope-appropriate production readiness, target idiom, harmful duplication avoidance, unnecessary complexity avoidance, and regression freedom**. Every stage references that same selected floor version; dependent stages consume the exact selected upstream artifact versions available to them rather than reconstructing content.

`result.met=true` and public success/complete are permitted only after final verification and 100% typed coverage. Command-verifiable obligations require a valid same-run execution receipt from the trusted owner; judgment-only obligations require an independent durable disposition. Unresolved findings block success. A human-accepted residual risk requires complete human acceptance and remains in the structured result and outcome. A terminal miss emits `incomplete`, never public success.

Both human gates carry complete, non-truncated structural questionnaire content from the selected artifact, visibly including its ID/version/digest. Plain caller text cannot authorize a gate. Greenfield, ambiguous, or insufficient target-profile evidence routes to clarification before planning or implementation; selected project-native tooling is never replaced by a universal fallback. Legacy pending runs resume in a fresh process with missing proof explicitly unverified. Release compares against the immutable full-eval baseline and named contract/drift matrix.

## When to Use

- User requests code generation, implementation, or bug fixes
- User mentions writing, building, creating, fixing, or refactoring code
- Task involves file modifications (write, edit)
- Task mentions programming languages or file extensions (.py, .ts, .js, etc.)
- A PRD from the prd skill exists and the user is ready to implement

## When Not to Use

- The goal is too vague to synthesize criteria from — run `prd` first (recommended, not required)
- Simple text edits or one-line file changes (execute directly)
- Pure exploration or research questions (use `echo` agent directly)
- User explicitly says "just do it" without a clear specification

## PRD / IDEAL_STATE (Optional)

The code skill **uses** a PRD + IDEAL_STATE when one is available, but does **not** require it — it runs standalone or as a `prd → code` chain. `start()` resolves an IDEAL_STATE from `constraints` two ways:

- **Direct** — `constraints.ideal_state` is a dict carrying `success_criteria`.
- **Chain fallback** — `constraints.prd_room` is a room id of the form `"skills/prd-…"`; the skill looks that drawer up in MemPalace (the prd skill writes IDEAL_STATE there).

If neither yields an IDEAL_STATE with `success_criteria`, `start()` synthesizes lightweight criteria from the goal (`ideal_state_from_goal`) and proceeds — Carren still judges them in `checking_criteria`; when the user requests a change, Piper authors it separately in `refining_criteria`. The verify/test battery remains the real acceptance bar. The quality loop stays; only the PRD mandate is optional.

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
         (P0 refine/accept; legacy skip) │
                 │ refine             │
                 ▼                    │
          refining_criteria ─valid──► checking_criteria
                 │ invalid            │
                 └────► criteria_gate │
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
- `learning` `gap=true` **budget spent** → terminal `incomplete` with `result.met=false` for P0 (never emits public complete/success); legacy records retain their compatible terminal representation.

Escalation & terminals:

- Any working state (`exploring`, `analyzing`, `checking_criteria`, `refining_criteria`, `planning`, `implementing`, `verifying`, `learning`) → `unknown` → `awaiting_clarification` → resumes at `exploring` once the user clarifies. Triggered by `UNCERTAIN` confidence, or (at `learning`) a stalled retry / repeated failed strategy caught by the engine's progress check.
- `plan_gate` **deny** → `error` (terminal).
- Public terminal actions: P0 `complete` only when `result.met=true`, otherwise `incomplete`; `error` is terminal for denial/abort.

## Agents

| State                 | Agent(s)   | Role                                                                                                                                                                       |
| --------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| exploring             | echo       | Deep dive into affected code areas, find impacted files, verify IDEAL_STATE is achievable                                                                                  |
| analyzing             | annie      | Security risks, integration surface, dependencies                                                                                                                          |
| **checking_criteria** | **carren** | **Judgment-only evaluation of criteria quality before planning: measurable, achievable, precise, non-overlapping. Carren never authors replacements.**                     |
| criteria_gate         | _(HITL)_   | **P0 presents the complete selected criteria artifact and findings for trusted-human refine or exact-artifact acceptance; skip exists only for legacy schema runs.**       |
| **refining_criteria** | **piper**  | **Authors a complete changed criteria proposal from the selected version, exact structured user instruction, current full IDEAL_STATE, and prior Carren findings/issues.** |
| planning              | piper      | Implementation plan with dependency chains + per-tier test strategy                                                                                                        |
| **plan_gate**         | _(HITL)_   | **Presents the full plan summary (build order, deliverables, criteria) for explicit user approval before any code is written. User can approve, refine, or deny.**         |
| implementing          | skribble   | Write code + tests to satisfy the IDEAL STATE (sequencing is the model's call)                                                                                             |
| verifying             | skribble   | Run lint, type-check, unit, integration, E2E                                                                                                                               |
| learning              | carren     | Compare output to IDEAL STATE, decide: iterate or complete                                                                                                                 |

## Interactive Gates

The code skill pauses for user input at two HITL gates, plus a final verification pass:

### Gate 1 — criteria_gate (checking_criteria gap, before planning)

Carren evaluates the IDEAL_STATE's `success_criteria` for:

1. Are they **measurable** (can we objectively tell if met)?
2. Are they **achievable** within project scope?
3. Are they **precise** (not vague like "works well" or "is fast")?
4. Are they **non-overlapping** (distinct from each other)?

If Carren finds gaps, a questionnaire presents the specific issues and the user can:

- **Refine**: Provide an exact instruction. Piper receives it once as structured data with the selected version, current full criteria/IDEAL_STATE, and prior Carren findings/issues. A valid changed proposal is canonically validated, committed, then independently re-evaluated by Carren; invalid, unchanged, stale, or corrupt-ledger proposals return to the gate with explicit errors.
- **Accept as-is**: Use current criteria despite Carren's concerns.
- **Skip**: Legacy-only compatibility. P0 does not allow skip/waive/not-applicable for any active criterion or quality-floor dimension.

### Gate 2 — plan_gate (planning, before implementing)

Piper's plan (build order, deliverables, success criteria, anti-criteria) is presented as a structured summary. The user must explicitly decide before any code is written:

- **Approve**: Begin implementation
- **Refine**: Rerun the planning state with the user's modifications
- **Deny**: Terminate the run in `error`; no code is written

### Final Verification (learning no-gap, before complete)

When carren reports no gap in `learning`, the skill runs one final `verifying` pass before emitting `complete`. This catches regressions from the last round of fixes; a failing final verify loops back to `learning`.

## Input Contract

`start()` reads the IDEAL_STATE from `constraints` (see **PRD / IDEAL_STATE (Optional)** above): either `constraints.ideal_state` directly, or `constraints.prd_room` (`"skills/prd-…"`), which is resolved against the following mempalace drawers written by the prd skill. When neither is supplied, `start()` synthesizes the criteria from the goal instead:

| Drawer                                  | Source Skill | Content                                               |
| --------------------------------------- | ------------ | ----------------------------------------------------- |
| `skills/prd-{session_id}/IDEAL_STATE`   | prd          | Structured IDEAL STATE JSON matching canonical schema |
| `skills/prd-{session_id}/PRD Narrative` | prd          | Prose PRD document (optional, for context)            |

There is no `--state-data` transport. Run state (current node, iteration count, per-state summaries) is persisted in the engine's durable SQLite checkpointer keyed by `run_id`; an interrupted run auto-resumes on the next `step`.

## Mandatory Gates

Before any code is written (implement state):

1. Read language-specific coding standards from `resources/<language>.md`
2. Read security checklist from `resources/security-checklist.md`
3. Read the real generic security index at `docs/agents/coding/security/AGENTS.md` and the applicable indexed documents; task security-domain labels are not invented filenames
4. Read `resources/resilience.md` — defensive patterns for all projects
5. If AI frameworks detected: read `resources/ai-application.md`
6. If web UI frameworks detected: read `resources/web-ui.md`

## Resources

- `resources/python.md` — Python coding standards
- `resources/typescript.md` — TypeScript coding standards
- `resources/security-checklist.md` — Mandatory pre-code security review
- `resources/server-startup-tests.md` — proven server-startup test patterns (a reference to draw on) for any project that ships a server (FastAPI, Flask, Express, etc.). The verify phase fails if the server-startup **outcomes** aren't demonstrated by evidence.
- `resources/ai-application.md` — **Auto-injected** when AI framework imports detected (transformers, openai, langchain, etc.). Covers generation parameters, streaming patterns, system prompt design, model loading, hardware detection, context windows.
- `resources/web-ui.md` — **Auto-injected** when web UI framework detected (Lit, React, etc.). Covers CSS selector hygiene, theme system interaction, state synchronization, UI patterns, framework-specific gotchas.
- `resources/resilience.md` — **Always injected**. Language-agnostic defensive patterns: error-boundary state, garbage collection, loading UX, idempotency, graceful degradation.

## Server-Project Verification (Mandatory)

If the project is a server, the orchestrator automatically enables an additional verification tier: **`verification.server_startup`**. Detection is **model-first** when `PI_CODE_DETECT_MODEL` is set (a cheap model names the framework from the project manifests — open-vocabulary, so it catches frameworks no table lists); it falls back to a dependency-manifest / source-import scan (FastAPI / Flask / Express / etc.) when the model is off or unavailable. The plan, implement, and verify phases all gain server-specific instructions:

- **plan** — piper plans the test strategy that will prove the server-startup outcomes.
- **implement** — skribble is given the server-startup **outcomes** that must hold (real server serves real HTTP; each entry-point's import chain holds from its own cwd; CORS preflight correct if applicable; a happy path runs end-to-end) plus `resources/server-startup-tests.md` as a proven-pattern reference — the test shape is the model's call.
- **verify** — skribble must confirm each outcome is **demonstrated by captured evidence** and FAIL verification for any outcome not proven. Passing unit tests alone do not satisfy a server project.

The outcomes are enforced by evidence, not by a fixed checklist of test names. Unit tests with mocked framework classes consistently miss a class of real-world bugs (CORS misconfiguration, import-chain breakage when cwd changes, port conflicts, lifespan-event typos), which is why the functional/server tier is required. See `resources/server-startup-tests.md` for the full rationale and copy-pastable patterns.

## IDEAL STATE Validation and Revision Ledger

`start()` enriches the active IDEAL_STATE with server detection, validates it through the canonical `scripts/validate_ideal_state.py::validate_json` boundary, then records the exact enriched payload as v1 in `ctx.extras.code.ideal_state_revision_ledger`.

Criteria refinement is fail-closed. The playbook deep-copies the selected payload, replaces only `success_criteria`, exact-shape-validates the known runtime verification metadata (`server_framework`, `server_entry_points`, `server_evidence`, `multi_server_services`, `multi_server_evidence`), projects only those metadata fields away for canonical validation, and rejects every other non-boolean verification value. It validates ledger schema, records, parent links, selected pointer, active-payload equality, stale base version, and a real criteria change before committing the new ledger + active IDEAL_STATE + `ctx.success_criteria` together.

Fresh runs carry v1 after detection. Legacy checkpoints with no ledger are wrapped lazily only when a valid refinement commits, preserving the exact prior payload as v1. Malformed or future-version ledgers are diagnosed and never overwritten.

## Run State and Notes

The engine's durable checkpointer is the source of truth for run state: current node,
iteration count, per-state summaries, and the P0 artifact registry, all keyed by
`run_id`. The structured terminal result (`met`, resolved `success_criteria`,
iteration count, selected artifacts) is returned in the completion directive.
Agents write their working notes to the mempalace room `skills/code-{session_id}`
during the run.
