# Plan Skill

Creates structured, execution-grade plans for any domain using a validated lifecycle: explore → plan → (verify) → critique → taskify.

## Overview

- **Purpose**: Create actionable plans from goals and context
- **Domains**: Code, Life, Research, Communication, Learning, Events, General
- **Outcome**: Structured plan with steps, resources, acceptance criteria, risks, and execution notes

## Engine Architecture

The plan skill runs on the shared **orchestration engine**. It is defined as a `BasePlaybook` subclass, `PlanPlaybook`, in `apps/orchestration/src/orchestration/playbooks/plan.py`. That class is the single source of truth for the states, transitions, gates, loops, and agents.

- `scripts/orchestrate.py` is a thin delegate — it calls `orchestration.cli:main(default_playbook="plan")` and routes `start` / `step` / `status` / `recover`. It contains no FSM logic, no state serialization, and no `/tmp` checkpoints.
- Run state lives in a durable **SQLite checkpointer keyed by `run_id`**. There is no `--state` argv, no session file, and no `extract_state` / `restore_state`.
- Agents run in fresh context and communicate through the **mempalace** room `skills/plan-{session_id}`. Only a structured SUMMARY is returned to the engine per step; Penny never sees full agent output.
- Human-in-the-loop pauses (the verify gate and clarification escalation) are **engine seams**. A paused run is resumed by re-issuing `step` with `agent="user"` and the user's response — the engine rehydrates by `run_id` (no transition replay, no orchestrator state passed back).

**Key principle: Penny's context stays clean.** The engine only receives structured summaries (e.g. `explore_complete`, `verdict`, `step_count`).

## States

| State                   | Agent            | Purpose                                                     |
| ----------------------- | ---------------- | ---------------------------------------------------------- |
| `intake`                | — (initial)      | Validate a non-empty goal; seed `plan` extras              |
| `scoping`               | `piper`          | Emit the runtime exploration topology (`explore_branches`) |
| `exploring`             | `echo` × N       | Parallel fan-out over the model-emitted (or default) foci  |
| `planning`              | `piper`          | Write the execution-grade plan; emit `plan_steps` + stakes |
| `verify_gate`           | — (HITL gate)    | Confirm or revise a high-stakes plan before critique       |
| `critiquing`            | `carren`         | Critique the plan (CREST); verdict APPROVE / NEEDS_REVISION |
| `taskifying`            | `tabitha`        | Convert the approved plan into a structured task list       |
| `unknown`               | — (transient)    | Escalation staging state                                    |
| `awaiting_clarification`| — (HITL)         | Paused for user clarification                               |
| `complete`              | — (final)        | Success                                                     |
| `error`                 | — (final)        | Failure (`abort` from any working state)                   |

## Flow

1. `intake → scoping` (`start_scope`); or `intake → exploring` (`start_explore`) when `constraints.explore_branches` supplies the topology. Empty goal raises at intake.
2. `scoping → exploring` (`scope_done`) — piper's `explore_branches` become `ctx.extras["dynamic_branches"]`; the engine fans out one read-only echo branch per focus (bounded by `max_fan_width`). The legacy fixed 3-branch split is a tagged LOAN fallback; ablated, an invalid topology escalates. `exploring → planning` (`explore_done`) after fan-in.

**Critique is evidence-gated** (Rec 4): `PLAN_CRITIQUE` requires a non-empty `evidence` field, so carren cannot APPROVE/BLOCK on a bare assertion; the evidence rides to the outcome ledger. Clarification resumes at `scoping` (`clarify → scoping`).
3. `planning` routes on the verification gate:
   - `plan_to_verify → verify_gate` when `_needs_verification` is true.
   - `plan_to_critique → critiquing` otherwise.
4. `verify_gate` (HITL): `verify_confirm → critiquing` if the user proceeds; `verify_revise → planning` otherwise (the user's note becomes clarification text).
5. `critiquing` routes on the verdict and the revision budget:
   - `critique_pass → taskifying` when the verdict is `APPROVE`.
   - `critique_retry_explore → exploring` when `NEEDS_REVISION`, budget remains, and fewer than 2 explore rounds have run.
   - `critique_retry_plan → planning` when `NEEDS_REVISION`, budget remains, and explore rounds are exhausted.
   - `critique_exhausted → taskifying` when the iteration cap is reached — the run completes with `met=False` and reports the unresolved issues (it does **not** force-approve).
6. `taskifying → complete` (`taskify_done`).

### Verification gate

`verify_gate` is entered only when a plan warrants confirmation. The decision is `_needs_verification`, driven by `constraints.verification_mode` and the plan's `stakes`:

| `verification_mode` | Gate condition           |
| ------------------- | ------------------------ |
| `off`               | never                    |
| `relaxed` (default) | never                    |
| `strict`            | stakes ∈ {high, medium}  |
| `default`           | stakes == high           |

### Escalation

`planning`, `critiquing`, and `taskifying` are escalatable. The engine escalates (`to_unknown → unknown`, `escalate → awaiting_clarification`) when:

- an agent SUMMARY sets `needs_clarification`, or reports `UNCERTAIN` confidence; or
- the critique loop stalls — the same issues persist across revisions with no measurable progress (escalate rather than force-approve).

The user's clarification resumes the run via `clarify → exploring`.

## Parallel Exploration

`exploring` always fans out three `echo` branches, each with a distinct focus:

1. `entrypoints` — entry points and call graph
2. `tests` — tests and build pipeline
3. `config` — configurations and dependencies

The branches write to the session room and fan in before planning. Revision rounds re-run exploration with the critique issues as the focus.

## Mempalace Room

Each invocation uses the room `skills/plan-{session_id}`. Agents read prior results from and write new results to this room. Drawer headers (verbatim):

| Agent    | Header                                                       |
| -------- | ----------------------------------------------------------- |
| echo     | `{session_id} Explore — {focus}` (revisions: `Explore (Revision N) — {focus}`) |
| piper    | `{session_id} Planner` (revisions: `Planner (Revision N)`)  |
| carren   | `{session_id} Critique`                                     |
| tabitha  | `{session_id} Taskifier`                                    |

On completion the engine writes the run outcome automatically; SKILL.md's post-completion queries read from this room.

## Supported Domains

| Domain            | Description                      | Focus Areas                          |
| ----------------- | -------------------------------- | ------------------------------------ |
| **Code/Projects** | Features, refactors, migrations  | Files, dependencies, tests, patterns |
| **Life Planning** | Goals, decisions, career         | Timeline, resources, stakeholders    |
| **Research**      | Studies, investigations          | Sources, methodology, analysis       |
| **Communication** | Documents, emails, presentations | Audience, format, timing             |
| **Learning**      | Skills, courses, certifications  | Prerequisites, resources, practice   |
| **Events**        | Trips, parties, conferences      | Logistics, timeline, budget          |
| **General**       | Any multi-step goal              | Steps, resources, verification       |

## Result Payload

`taskify_done` / `critique_exhausted` produce a result with: `met`, `iterations`, `title`, `step_count`, `steps`, `goal`, `non_goals`, `session_id`, `session_room`, `requires_approval` (always `true`), `critique_passed`, `exhausted`, and `unresolved_issues` (populated only when exhausted).

## Files

| File                     | Purpose                                              |
| ------------------------ | ---------------------------------------------------- |
| `SKILL.md`               | Skill definition and invocation                      |
| `README.md`              | This documentation                                   |
| `scripts/orchestrate.py` | Thin delegate to the orchestration engine            |
| `assets/prompts/*.md`    | Domain-agnostic agent prompts                        |
| `resources/reference.md` | State/transition/agent reference                     |
| `resources/flow.mmd`     | Mermaid state diagram (matches the playbook FSM)     |
