# Plan Skill Reference

Technical reference for the Plan skill. The authoritative source is the engine playbook `PlanPlaybook` in `apps/orchestration/src/orchestration/playbooks/plan.py`; this file mirrors its FSM. State lives in the durable checkpointer keyed by `run_id` — there are no session files, no `force_state`, and no `--state` argv.

## State Machine

### States

| State                    | Kind            | Agent      | Description                                              |
| ------------------------ | --------------- | ---------- | ------------------------------------------------------- |
| `intake`                 | initial         | —          | Validate non-empty goal; seed `plan` extras             |
| `exploring`              | parallel        | `echo` × 3 | Fan out entrypoints / tests / config exploration        |
| `planning`               | primitive       | `piper`    | Write plan; emit `plan_steps` + `stakes`                |
| `verify_gate`            | planned gate    | — (user)   | HITL confirm/revise a high-stakes plan                  |
| `critiquing`             | primitive       | `carren`   | Critique plan (CREST); emit `verdict` + `issues`        |
| `taskifying`             | primitive       | `tabitha`  | Convert plan to structured task list; emit `step_count` |
| `unknown`                | transient       | —          | Escalation staging                                      |
| `awaiting_clarification` | HITL            | — (user)   | Paused for clarification                                |
| `complete`               | final           | —          | Success                                                 |
| `error`                  | final           | —          | Failure                                                 |

`GATE_STATES = {verify_gate}`. `ESCALATABLE_STATES = {exploring, planning, critiquing, taskifying}`. `PARALLEL_BY_STATE = {exploring: PLAN_EXPLORE}`.

### Transitions

| Event                    | From                                                                 | To                       | Guard / condition                                              |
| ------------------------ | -------------------------------------------------------------------- | ------------------------ | -------------------------------------------------------------- |
| `start_explore`          | `intake`                                                             | `exploring`              | non-empty goal (else `intake` raises)                          |
| `explore_done`           | `exploring`                                                          | `planning`               | echo branches fanned in                                        |
| `plan_to_verify`         | `planning`                                                           | `verify_gate`            | `_needs_verification` true                                     |
| `plan_to_critique`       | `planning`                                                           | `critiquing`             | `_needs_verification` false                                    |
| `verify_confirm`         | `verify_gate`                                                        | `critiquing`             | user response ∈ {confirm, approve, proceed, yes}               |
| `verify_revise`          | `verify_gate`                                                        | `planning`               | any other user response (becomes clarification text)           |
| `critique_pass`          | `critiquing`                                                         | `taskifying`             | `verdict == APPROVE`                                           |
| `critique_retry_explore` | `critiquing`                                                         | `exploring`              | `NEEDS_REVISION`, `iteration+1 < max_iterations`, `explore_rounds < 2` |
| `critique_retry_plan`    | `critiquing`                                                         | `planning`               | `NEEDS_REVISION`, `iteration+1 < max_iterations`, `explore_rounds >= 2` |
| `critique_exhausted`     | `critiquing`                                                         | `taskifying`             | iteration cap reached; sets `exhausted`, run completes `met=False` |
| `critique_blocked`       | `critiquing`                                                         | `complete`               | `verdict == BLOCKED` — halt honestly, `met=False`, `blocked` flag set |
| `taskify_done`           | `taskifying`                                                         | `complete`               | —                                                              |
| `to_unknown`             | `exploring` \| `planning` \| `critiquing` \| `taskifying`          | `unknown`                | escalation trigger (see below)                                 |
| `escalate`               | `unknown`                                                            | `awaiting_clarification` | —                                                              |
| `clarify`                | `awaiting_clarification`                                             | `exploring`              | user provided clarification                                   |
| `abort`                  | any working state (`intake`…`awaiting_clarification`)               | `error`                  | unrecoverable failure                                          |

### Verification gate (`_needs_verification`)

Driven by `constraints.verification_mode` (default `relaxed`) and the plan's `stakes`:

| Mode                | Gate condition          |
| ------------------- | ----------------------- |
| `off`               | never                   |
| `relaxed` (default) | never                   |
| `strict`            | `stakes` ∈ {high, medium} |
| `default`           | `stakes == high`        |

`verify_gate` questions surface the proposed action, stakes, a counter-argument, and one alternative. `route_user` maps a confirm-like response to `verify_confirm`; anything else records the note as `clarification_text` and fires `verify_revise`.

### Escalation (`progress_check`)

Only escalatable states reach the HITL path. The engine escalates when, in an escalatable state:

- the agent SUMMARY sets `needs_clarification` (questions surfaced to the user), or reports `UNCERTAIN` confidence; or
- in `critiquing`, the `verdict != APPROVE` and the loop is stalled — the same issues persist across revisions with no measurable progress.

`exploring` is escalatable so a fan-out `echo` branch can surface a blocking ambiguity: because the parallel fan-in only inspects aggregated **confidence**, a branch that needs clarification must set `confidence == UNCERTAIN` (its questions travel in `clarifying_questions`) — `echo.md` requires this pairing.

Escalation fires `to_unknown` then `escalate`, pausing at `awaiting_clarification`. The user's reply resumes via `clarify → exploring`. The loop is **not** force-approved at the iteration cap; instead it either escalates (stall) or completes with `met=False` (`critique_exhausted`). A `verdict == BLOCKED` (a plan the critic judges categorically unsafe) short-circuits the retry loop entirely: `critique_blocked` halts the run at `complete` with `met=False` and the `blocked` flag set, rather than re-planning or taskifying an unsafe plan.

### Revision loop bounds

- `max_iterations` bounds critique revision cycles (`ctx.iteration` increments per `NEEDS_REVISION`).
- `explore_rounds` (capped at 2) determines whether a revision re-explores (`critique_retry_explore`) or fixes in the plan (`critique_retry_plan`).

## Per-state SUMMARY contracts

Each agent returns a SUMMARY validated against the state's contract before the FSM advances. `confidence`, `needs_clarification`, `clarifying_questions`, and `mempalace_drawer` are optional on every contract.

| State        | Primitive        | Required fields                          | Notable optional fields                                              |
| ------------ | ---------------- | ---------------------------------------- | ------------------------------------------------------------------- |
| `exploring`  | `PLAN_EXPLORE_*` | `explore_complete: bool`                 | `findings_count`, `files_count`, `unknowns_count`                   |
| `planning`   | `PLAN_PLAN`      | `plan_complete: bool`, `plan_steps: list`| `stakes`, `alternatives`, `counter_argument`, `proposed_action`, `step_count` |
| `critiquing` | `PLAN_CRITIQUE`  | `verdict: str`, `issues: list`           | —                                                                   |
| `taskifying` | `PLAN_TASKIFY`   | `title: str`, `step_count: int`, `complete: bool` | —                                                          |

## Agents

| State        | Agent     | Prompt file             | Reads / writes                                        |
| ------------ | --------- | ----------------------- | ---------------------------------------------------- |
| `exploring`  | `echo`    | `assets/prompts/echo.md`| Writes findings to `skills/plan-{session_id}`        |
| `planning`   | `piper`   | `assets/prompts/piper.md` | Reads explore findings, writes the plan            |
| `critiquing` | `carren`  | `assets/prompts/carren.md` | Reads plan, writes critique                        |
| `taskifying` | `tabitha` | `assets/prompts/tabitha.md` | Reads plan + critique, writes structured task list |

### Parallel exploration branches

`PLAN_EXPLORE` (a `ParallelSpec`) fans out three `echo` branches:

| Branch id     | Focus (`task_hint`)              |
| ------------- | -------------------------------- |
| `entrypoints` | entry points and call graph      |
| `tests`       | tests and build pipeline         |
| `config`      | configurations and dependencies  |

## Mempalace Integration

Room: `skills/plan-{session_id}`. Drawer headers (verbatim):

| Agent   | Header                                                                          |
| ------- | ------------------------------------------------------------------------------- |
| echo    | `{session_id} Explore — {focus}` / `{session_id} Explore (Revision N) — {focus}` |
| piper   | `{session_id} Planner` / `{session_id} Planner (Revision N)`                     |
| carren  | `{session_id} Critique`                                                          |
| tabitha | `{session_id} Taskifier`                                                         |

The engine records the run outcome automatically on completion.

## Resume

A paused run (verify gate or clarification) is resumed by re-issuing `step` with `agent="user"` and the user's response as the result payload. The engine rehydrates the run by `run_id` from the checkpointer and dispatches through `route_user` (gate) or `clarify` (escalation). No orchestrator state is passed back to the caller; no transition replay is performed.

## Result Payload

| Field               | Meaning                                                    |
| ------------------- | ---------------------------------------------------------- |
| `met`               | Whether the goal was met                                   |
| `iterations`        | Critique revision cycles run                               |
| `title`             | Taskifier plan title                                       |
| `step_count`        | Structured step count                                      |
| `steps`             | `plan_steps` from planning                                 |
| `goal`              | Original goal                                              |
| `non_goals`         | `constraints.non_goals`                                    |
| `session_id`        | Session id                                                 |
| `session_room`      | `skills/plan-{session_id}`                                 |
| `requires_approval` | Always `true`                                              |
| `critique_passed`   | `critique_verdict == APPROVE`                              |
| `exhausted`         | Iteration cap reached without approval                     |
| `unresolved_issues` | Outstanding critique issues (only when `exhausted`)        |
