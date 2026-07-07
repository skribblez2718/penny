# Agent Skill Reference

The agent skill is `AgentPlaybook`, a `BasePlaybook` subclass on the shared
orchestration engine (`orchestration.playbooks.agent`). State lives in the
durable SQLite checkpointer keyed by `run_id`; there are no session files, no
`--state` argv, and no `force_state`. `scripts/orchestrate.py` is a thin
delegate to `orchestration.cli`.

## FSM (`AgentMachine`)

### States

| State                  | Kind    | Primitive / agent    | Description                                                             |
| ---------------------- | ------- | -------------------- | ---------------------------------------------------------------------- |
| intake                 | initial | —                    | Validate non-empty goal; read optional `constraints.agent_name` hint.  |
| exploring              |         | AGENT_EXPLORE / echo | Gather evidence on existing agents, schema, conventions.               |
| designing              |         | AGENT_DESIGN / piper | Design the agent definition (10-item design checklist).                |
| critiquing             |         | AGENT_CRITIQUE / carren | Validate design vs. the agent standard. Verdict APPROVE / NEEDS_REVISION / BLOCKED. |
| scaffolding            |         | AGENT_SCAFFOLD / skribble | Generate `.pi/agents/<name>.md` from the design spec.              |
| verifying              |         | AGENT_VERIFY / vera  | Validate the generated file vs. the standard; attach evidence.         |
| unknown                |         | —                    | Transient escalation staging state.                                    |
| awaiting_clarification |         | —                    | Run paused; waiting on a user response.                                |
| complete               | final   | —                    | Terminal success (or honest exhaustion with `met=False`).              |
| error                  | final   | —                    | Terminal failure.                                                      |

### Transitions

| Event                   | From                                  | To                     | Guard                                                        |
| ----------------------- | ------------------------------------- | ---------------------- | ------------------------------------------------------------ |
| start_explore           | intake                                | exploring              | non-empty goal                                               |
| explore_done            | exploring                             | designing              | —                                                            |
| design_done             | designing                             | critiquing             | —                                                            |
| critique_pass           | critiquing                            | scaffolding            | `verdict == APPROVE`                                         |
| critique_retry_explore  | critiquing                            | exploring              | `verdict != APPROVE`, `iter+1 < max`, `explore_rounds < 1`   |
| critique_retry_design   | critiquing                            | designing              | `verdict != APPROVE`, `iter+1 < max`, `explore_rounds >= 1`  |
| critique_exhausted      | critiquing                            | complete               | `verdict != APPROVE`, `iter+1 >= max` (met=False)            |
| scaffold_done           | scaffolding                           | verifying              | —                                                            |
| verify_pass             | verifying                             | complete               | all of yaml_valid, schema_valid, diff_applied                |
| verify_retry            | verifying                             | scaffolding            | checks fail, `verify_iter+1 < max`                           |
| verify_exhausted        | verifying                             | complete               | checks fail, `verify_iter+1 >= max` (met=False)              |
| to_unknown              | exploring/designing/critiquing/scaffolding/verifying | unknown | escalation triggered (see below)                             |
| escalate                | unknown                               | awaiting_clarification | —                                                            |
| clarify                 | awaiting_clarification                | exploring              | user response supplied on resume                             |
| abort                   | any non-final state                   | error                  | unrecoverable error                                          |

## Loops

- **Critique revision loop**: `critiquing → {exploring | designing} → … → critiquing`.
  The revision target is decided in `route_after`: the first non-APPROVE cycle
  re-explores (`explore_rounds < 1`), later cycles re-design. Bounded by
  `ctx.max_iterations`; on exhaustion the run completes with `met=False` and the
  unresolved critique issues in `unresolved_issues`.
- **Verify re-scaffold loop**: `verifying → scaffolding → verifying`. Bounded by
  `ctx.max_iterations`; on exhaustion the run completes with `met=False` and the
  failing checks in `unresolved_issues`.

There is no `revising` state — the legacy `revise_explore` / `revise_design`
transitions are replaced by `route_after` routing.

## Escalation gate (`progress_check` + `ESCALATABLE_STATES`)

`ESCALATABLE_STATES = {exploring, designing, critiquing, scaffolding, verifying}`.
Escalation (`to_unknown → escalate → awaiting_clarification`) fires when:

- an agent SUMMARY sets `needs_clarification: true` (questions passed through), or
- an agent reports `UNCERTAIN` confidence, or
- **stall** — in `critiquing`, the same critique issues persist across revisions
  with no progress (`is_stalled`); in `verifying`, the same checks keep failing
  across re-scaffolds.

Escalation always resumes into `exploring` via `clarify` once the user response
is supplied.

## Subagents

| Agent    | State       | Reads (mempalace)          | Writes header              | Prompt      |
| -------- | ----------- | -------------------------- | -------------------------- | ----------- |
| echo     | exploring   | prior explore results      | `<session_id> Explore`     | echo.md     |
| piper    | designing   | explore findings           | `<session_id> Design`      | piper.md    |
| carren   | critiquing  | design spec                | `<session_id> Critique`    | carren.md   |
| skribble | scaffolding | design spec                | (writes `.pi/agents/<name>.md`) | skribble.md |
| vera     | verifying   | generated agent file       | `<session_id> Verify`      | vera.md     |

Each state runs a single agent (no parallel fan-out). vera is the external oracle:
its VERIFY SUMMARY must ship non-empty `evidence` (the actual per-check output) or
it is rejected.

## Mempalace

- **Room**: `skills/agent-<session_id>` (wing `penny`).
- Agents write full findings to the room under their state header; the engine
  receives the SUMMARY only.

## Result payload

`result_payload` returns `met`, `iterations`, `verify_iterations`, `goal`,
`agent_name`, `agent_file_path`, `verification_result` (yaml_valid / schema_valid /
diff_applied), `critique_verdict`, `session_id`, `session_room`, `exhausted`, and
`unresolved_issues`. `done_predicate` is true only when all three verification
checks pass.
