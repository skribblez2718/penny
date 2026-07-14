# Plan Skill — Structured planning workflow

## What

A skill that breaks complex goals into actionable, execution-grade plans. It explores context (parallel), synthesizes a plan, optionally gates high-stakes plans for user confirmation, critiques the plan, and converts it into a structured task list. Penny presents the result for approval before any step is executed.

## Why

Complex tasks with dependencies, high stakes, or multiple execution paths benefit from explicit planning. The skill separates planning from execution so the user can approve or refine the approach before work begins.

## Engine model

The plan skill runs on the shared orchestration engine at `apps/orchestration/`. The workflow is the `PlanPlaybook` (`apps/orchestration/src/orchestration/playbooks/plan.py`), a `BasePlaybook` subclass with custom-named states, per-state SUMMARY contracts, a planned verification gate, model-emitted parallel explore fan-out, and needs-clarification escalation.

**Exploration topology is the model's runtime output** (arrangement 4, Bitter-Lesson compliance): a `scoping` state (piper) emits `explore_branches`, which `route_after` turns into `ctx.extras["dynamic_branches"]`; the engine fans out one read-only `echo` branch per focus, bounded by `constraints["max_fan_width"]` (default 8). The legacy fixed 3-branch split (`entrypoints`/`tests`/`config`) survives only as the tagged LOAN `plan_default_explore_topology` (`PLAN_EXPLORE_DEFAULT`) — used when scoping emits no valid topology and the loan is enabled; ablated, an invalid topology escalates. `constraints["explore_branches"]` lets a caller supply the topology and skip scoping. **Critique is evidence-gated** (Rec 4): `PLAN_CRITIQUE` requires a non-empty `evidence` field — what carren examined — which flows to `ctx.verify_evidence` and the outcome ledger. Clarification resumes at `scoping`.

`.pi/skills/plan/scripts/orchestrate.py` is a ~5-line delegate to `orchestration.cli.main(default_playbook="plan")`. There is no per-skill FSM, no `--state`/`--state-data` argv, no `/tmp/plan-<session_id>.json` session file, and no `extract_state`/`restore_state`/`_validate_summary` helpers. State lives in a durable SQLite checkpointer keyed by `run_id`; crash-resume is automatic (a run interrupted mid-step re-issues that step). Summary validation is the engine's job (`contracts.py`); empty or malformed summaries are rejected and the run does not advance on fabricated defaults.

## Rules

1. **Use for multi-step or high-stakes goals.** Do not use for typos, single-step fixes, or when the user says "just do it".
2. **Penny is a router.** Agents (`echo`, `piper`, `carren`, `tabitha`) communicate via mempalace (`skills/plan-<session_id>`); Penny only sees SUMMARY contracts.
3. **Approval is required before execution.** The run completes and returns `requires_approval: true`; the user approves/refines/denies before any step runs.
4. **`needs_clarification` escalates.** An agent emitting `needs_clarification: true` (with `clarifying_questions`) drives the machine to `unknown → awaiting_clarification` and pauses the run. Escalation is driven by `needs_clarification`, not a confidence field.
5. **High-stakes plans enter the verify gate.** When verification is warranted, the run pauses in `verify_gate` for explicit user confirmation before critiquing.

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
| `verification_mode` | `default`, `strict`, `relaxed`, `off` | Controls the verify gate (see below) |
| `non_goals` | list | Passed through to the result payload |

### States and transitions

```
intake ──start_explore──▶ exploring ──explore_done──▶ planning
                            ▲   ▲                         │
                            │   │            plan_to_verify│ plan_to_critique
   critique_retry_explore   │   │                         ▼           │
                            │   │                    verify_gate       │
                            │   │        verify_revise │  │ verify_confirm
                            │   └──────────────────────┘  ▼           ▼
                            │                          critiquing ◀────┘
                            │        critique_retry_plan │  │  │
                            └── (via planning) ──────────┘  │  │
                                                critique_pass│  │critique_exhausted
                                                             ▼  ▼
                                                         taskifying ──taskify_done──▶ complete
                                    critiquing ──critique_blocked (verdict BLOCKED)──▶ complete (met=False)

  exploring│planning│critiquing│taskifying ──to_unknown──▶ unknown ──escalate──▶ awaiting_clarification ──clarify──▶ exploring
  any non-terminal state ──abort──▶ error
```

| State | Agent | Purpose | Mempalace header |
|-------|-------|---------|------------------|
| `intake` | — | Validate non-empty goal, seed `ctx.extras["plan"]` | — |
| `exploring` | `echo` ×3 | Parallel fan-out (entrypoints, tests, config) | `<session> Explore — <focus>` |
| `planning` | `piper` | Synthesize findings into an execution-grade plan; emit `plan_steps` + `stakes` | `<session> Planner` |
| `verify_gate` | — | Planned HITL gate for high-stakes plans | — |
| `critiquing` | `carren` | CREST critique; verdict `APPROVE`, `NEEDS_REVISION`, or `BLOCKED` + issues | `<session> Critique` |
| `taskifying` | `tabitha` | Convert approved plan to structured task list; emit `title` + `step_count` | `<session> Taskifier` |
| `complete` | — | Terminal success; return result payload | — |
| `unknown` / `awaiting_clarification` | — | Escalation seam (paused run) | Clarification questions |
| `error` | — | Terminal failure | — |

### Parallel exploration

`exploring` always fans out (`PARALLEL_BY_STATE = {"exploring": PLAN_EXPLORE}`) into three `echo` branches, each with a distinct focus:

1. `entrypoints` — entry points and call graph
2. `tests` — tests and build pipeline
3. `config` — configurations and dependencies

Each branch writes findings to the shared mempalace room; `planning` reads them. On a critique-driven re-explore, the branches receive the prior critique issues to fill gaps (header suffixed `(Revision N)`).

### Verify gate

`GATE_STATES = {"verify_gate"}`. After `planning`, `_needs_verification` decides whether to enter the gate based on `verification_mode` and the plan's `stakes`:

| `verification_mode` | Gate entered when stakes are… |
|---------------------|-------------------------------|
| `off` | never |
| `relaxed` (default) | never |
| `default` | `high` |
| `strict` | `high` or `medium` |

At the gate the engine presents `gate_questions` (proposed approach, stakes, counter-argument, alternative). `route_user` maps the answer: `confirm`/`approve`/`proceed`/`yes` → `verify_confirm` (to `critiquing`); anything else → `verify_revise` (back to `planning` with the note as `clarification_text`).

### Critique revision loop

`critiquing` verdict `APPROVE` → `critique_pass` → `taskifying`. On `NEEDS_REVISION`, while `ctx.iteration + 1 < ctx.max_iterations`:

- first two revisions re-explore (`critique_retry_explore`, tracked by `explore_rounds < 2`) so `echo` can fill the gaps;
- thereafter revisions go straight back to `planning` (`critique_retry_plan`).

The loop is bounded by `ctx.max_iterations`. On true budget exhaustion it takes `critique_exhausted` to `taskifying` and **completes honestly with `met=False`**, reporting `unresolved_issues` — it never force-sets `verdict=APPROVE`. If the same issues persist across revisions with no measurable progress, `progress_check` detects the stall and escalates to the user instead of spinning. A `verdict == BLOCKED` (a plan the critic judges categorically unsafe) does **not** enter the retry loop at all: `critique_blocked` halts the run at `complete` with `met=False` and a `blocked` flag, so an unsafe plan is never re-planned into acceptance or taskified.

### Escalation path

`ESCALATABLE_STATES = {"exploring", "planning", "critiquing", "taskifying"}`. `progress_check` returns a reason when:

- a SUMMARY has `needs_clarification: true` (returns the clarifying questions), or
- `critiquing` is stalled (verdict not `APPROVE` and issues unchanged across revisions).

`exploring` is escalatable so a parallel `echo` branch can surface a blocking ambiguity. The parallel fan-in only inspects **aggregated confidence**, so a branch needing clarification must also set `confidence == UNCERTAIN` (its questions ride in `clarifying_questions`); `echo.md` requires this pairing, otherwise the questions would be silently dropped.

A returned reason drives `to_unknown → escalate` into `awaiting_clarification`, pausing the run. The user's answer resumes the **same run** (keyed by `run_id`) via a `user` step; the driver passes the response through `constraints.user_response`. `clarify` resumes at `exploring`. `previous_state` lives in `ctx` and is checkpointed — there is no state blob threaded back on the wire.

### Approval cycle

The run completes with `requires_approval: true`. Penny then:

1. Fetches the plan and task breakdown from mempalace room `skills/plan-<session_id>`.
2. Presents both via `questionnaire`: **Approve**, **Refine**, **Deny**.
3. On **approve**: begin executing plan steps.
4. On **refine**: re-invoke with `constraints: { refinement_context: "<notes>" }`.
5. On **deny**: stop.

## Result payload

`result_payload` returns `met`, `iterations`, `title`, `step_count`, `steps`, `goal`, `non_goals`, `session_id`, `session_room`, `requires_approval: true`, `critique_passed`, `exhausted`, and `unresolved_issues` (populated only when exhausted). `done_predicate` succeeds only when the critique verdict is `APPROVE` **and** the taskifier reported `complete`.

## Verification

- [ ] Plan contains concrete steps with dependencies and acceptance criteria.
- [ ] Carren critique returned `APPROVE`, or the run completed with `met=False` and `unresolved_issues` reported (no fabricated approval).
- [ ] High-stakes plans (per `verification_mode`) received explicit confirmation at `verify_gate`.
- [ ] No agent emitted `needs_clarification` without the run pausing at `awaiting_clarification`.
- [ ] User approved the plan before execution began.

## Files

| File | Purpose |
|------|---------|
| `apps/orchestration/src/orchestration/playbooks/plan.py` | `PlanPlaybook` — states, contracts, routing, verify gate, escalation |
| `apps/orchestration/tests/test_plan_playbook.py` | Playbook tests |
| `.pi/skills/plan/SKILL.md` | Skill definition (`metadata.penny.engine: orchestration`) and post-completion procedure |
| `.pi/skills/plan/scripts/orchestrate.py` | ~5-line delegate to the engine CLI |
| `.pi/skills/plan/assets/prompts/*.md` | Agent domain prompts |
| `docs/humans/capabilities/plan-skill/plan-skill.md` | Human-facing overview |
