# Skill Orchestration — State machine protocol for skill orchestrators

## What

Every skill orchestrator (`orchestrate.py`) is a Python state machine that emits JSON action directives to stdout. Penny reads each directive and routes to the appropriate agent or tool.

## Why

The JSON action protocol decouples skill logic from Penny's execution. Skills define what to do; Penny handles how to invoke agents and tools.

## Rules

1. **Three subcommands required.** `start`, `step`, `result` (or `status`). `start` initializes; `step` processes agent results; `result` returns final output.
2. **Output JSON to stdout.** One JSON object per line. No other output on stdout.
3. **Use `python-statemachine` library.** Canonical FSM implementation.
4. **Session state survives subprocess boundaries.** Write to `/tmp/<skill>-<session_id>.json` between invocations.

## Action Directives

| Action | Purpose | Required Fields |
|--------|---------|----------------|
| `invoke_agent` | Dispatch single agent | `agent`, `task_summary`, `session_room` |
| `invoke_agents_parallel` | Dispatch multiple agents | `tasks[]` with `agent`, `task_summary` |
| `escalate_to_user` | Pause for user input | `questions[]`, `unknown_reason`, `previous_state` |
| `complete` | Skill finished | `result` with output metadata |
| `error` | Skill failed | `error` with failure details |

## State Machine Pattern

```python
from statemachine import StateMachine, State

class MyWorkflow(StateMachine):
    intake = State(initial=True)
    working = State()
    complete = State(final=True)
    error = State(final=True)

    start = intake.to(working)
    finish = working.to(complete)
    fail = working.to(error)
```

## Constraints

- **No stdout output except JSON directives.** Use stderr for logging.
- **State must be serializable.** `extract_state()` and `restore_state()` required.
- **Agent SUMMARY is the only data passed back to orchestrator.** Full agent output stays in mempalace.

## Verification

- [ ] `start` initializes and returns first action
- [ ] `step` processes agent result and returns next action
- [ ] State survives round-trip through `extract_state()` / `restore_state()`
- [ ] `complete` returns structured result metadata

## Files

| File | Purpose |
|------|---------|
| `docs/agents/skills/skill-standard.md` | Full skill standard |
| `docs/agents/skills/resilience.md` | Error handling and recovery |
