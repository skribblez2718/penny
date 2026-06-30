# Orchestration Integration — State machines in `orchestrate.py`

## What

This document describes how a `python-statemachine` `StateChart` runs inside a skill's `orchestrate.py` and emits JSON action directives that Penny consumes.

## Why

Penny invokes `orchestrate.py` as a subprocess. The JSON action protocol decouples skill logic from agent invocation. The state machine tracks where the skill is; Penny handles agent dispatch, tool access, and memory. This also makes every skill resumable and testable outside the main agent loop.

## Rules

1. **`orchestrate.py` is the only runtime entry point.** The `StateChart` runs inside it, not in the top-level agent.
2. **Three subcommands are required:** `start`, `step`, and `result` (or `status`).
   - `start` creates or resumes a session and emits the first action.
   - `step` consumes the previous agent result and emits the next action.
   - `result` returns final output metadata.
3. **Stdout must contain only JSON directives.** One JSON object per line. Use stderr for logging.
4. **Session state survives subprocess boundaries.** Persist to `/tmp/<skill>-<session_id>.json` between invocations.
5. **Agent SUMMARY is the only payload passed back to the orchestrator.** Full agent output belongs in Mempalace.
6. **`on_enter` callbacks may dispatch agents; they must not execute work directly.**
7. **Recover from agent failures with state-machine transitions**, not by catching errors inline and silently continuing.

## Procedure/Constraints

### Three-layer model

```
┌─────────────────────────────────────────────────────────────┐
│                    scripts/orchestrate.py                    │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │              StateChart (python-statemachine)           │ │
│  │   ┌───────┐    ┌───────┐    ┌───────┐    ┌───────┐      │ │
│  │   │ idle  │───▶│ work  │───▶│ check │───▶│ done  │      │ │
│  │   └───────┘    └───────┘    └───────┘    └───────┘      │ │
│  └─────────────────────────────────────────────────────────┘ │
│                         │                                   │
│     ┌───────────────────┼───────────────────┐               │
│     ▼                   ▼                   ▼               │
│  ┌────────┐       ┌──────────┐       ┌──────────┐           │
│  │ Subagent│       │ Mempalace │       │ LocalState │          │
│  │ (dispatch)│      │ (T2/T3)  │       │ (/tmp json)│          │
│  └────┬───┘       └────┬─────┘       └────┬─────┘           │
│       │                │                  │                 │
│       ▼                ▼                  ▼                 │
│   JSON to stdout    memory_add_drawer   session file         │
└─────────────────────────────────────────────────────────────┘
```

| Layer | Responsibility | Implementation |
| --- | --- | --- |
| **StateChart** | Tracks phase, guards, callbacks, errors | `python-statemachine` |
| **Subagent** | Executes tasks using the full Pi tool set | Pi subagent tool |
| **Mempalace / LocalState** | Cross-session knowledge and recoverable session data | `memory_*` tools, `/tmp` JSON |

### `on_enter` callbacks dispatch agents

A callback emits an action directive by writing JSON to stdout and returning control to Penny. The machine itself does not block on the agent.

```python
async def on_enter_working(self):
    print(json.dumps({
        "action": "invoke_agent",
        "agent": "coder",
        "task_summary": f"Implement failing tests for {self.model.feature}",
        "session_room": "coding",
        "state": self.extract_state(),
    }), flush=True)
```

For parallel work, emit `invoke_agents_parallel`:

```python
print(json.dumps({
    "action": "invoke_agents_parallel",
    "tasks": [
        {"agent": "researcher", "task_summary": "Gather sources"},
        {"agent": "analyst", "task_summary": "Frame criteria"},
    ],
    "session_room": "research",
    "state": self.extract_state(),
}))
```

### Results flow back via `step`

Penny calls `orchestrate.py step --session-id <id> --result '<json>'`. The script restores the machine, feeds the result into the current state, and emits the next directive.

```python
async def run_step(session_id: str, agent_result: dict):
    machine = load_session(session_path(session_id))

    # Update local state with the agent summary
    machine.model.results.append(agent_result.get("summary"))

    # Decide next transition based on the result
    if machine.working.is_active:
        if machine.model.results[-1].get("ok"):
            machine.finish()
        else:
            machine.fail()

    save_session(machine, session_path(session_id))
    emit_next_action(machine)
```

### Data flow

#### Starting a session

1. Parse CLI args: `start --session-id <id> --input '<json>'`.
2. Load prior session state from `/tmp/<skill>-<session_id>.json` if it exists.
3. If new, query Mempalace for relevant T2/T3 context.
4. Initialize the `StateChart` and local model.
5. Emit the first action directive.

```python
def run_start(session_id: str, input_data: dict):
    path = session_path(session_id)
    if path.exists():
        machine = load_session(path)
    else:
        model = SkillContext(session_id=session_id, **input_data)
        machine = SkillFlow(model=model)
        # Optional: preload T2/T3 context
    emit_next_action(machine)
```

#### During execution

1. Penny invokes the dispatched agent.
2. The agent writes full output to Mempalace and returns a concise summary.
3. Penny calls `orchestrate.py step` with the summary.
4. The script restores the machine, applies the result, saves state, and emits the next directive.

#### Completing a session

1. Enter a final state (`complete` or `error`).
2. Store learnings in Mempalace.
3. Remove or mark the `/tmp` session file.
4. Emit a `complete` or `error` directive.

```python
async def on_enter_complete(self):
    await memory_add_drawer(
        wing="penny",
        room="skills",
        content=f"Skill completed: {self.model.session_id}\nResults: {self.model.results}"
    )

    print(json.dumps({
        "action": "complete",
        "result": {
            "session_id": self.model.session_id,
            "summary": self.model.results[-1],
        }
    }))
```

### Session persistence patterns

Use a small helper to keep `orchestrate.py` focused on the protocol.

```python
import json
from datetime import datetime
from pathlib import Path

SESSION_DIR = Path("/tmp")

def session_path(skill_name: str, session_id: str) -> Path:
    return SESSION_DIR / f"{skill_name}-{session_id}.json"

def save_session(machine, skill_name: str, session_id: str):
    path = session_path(skill_name, session_id)
    path.write_text(json.dumps({
        "session_id": session_id,
        "state": machine.current_state.id,
        "model": machine.model.__dict__,
        "timestamp": datetime.now().isoformat(),
    }, indent=2))

def load_session(skill_name: str, session_id: str, machine_cls, model_cls):
    path = session_path(skill_name, session_id)
    data = json.loads(path.read_text())
    model = model_cls(**data["model"])
    machine = machine_cls(model=model)
    machine.current_state = data["state"]
    return machine
```

### Error recovery with retry logic

Use `error.execution` transitions plus a `retrying` state. The agent result can include an error flag, or a callback can raise to trigger `error.execution`.

```python
class ResilientFlow(StateChart):
    working = State(initial=True)
    retrying = State()
    failed = State(final=True)
    completed = State(final=True)

    process = working.to(working, on="do_work")
    finish = working.to(completed)

    error_execution = working.to(retrying)
    retry = retrying.to(working, cond="can_retry")
    give_up = retrying.to(failed, cond="max_retries_exceeded")

    retries: int = 0
    max_retries: int = 3

    def can_retry(self) -> bool:
        return self.retries < self.max_retries

    def max_retries_exceeded(self) -> bool:
        return self.retries >= self.max_retries

    async def on_enter_retrying(self):
        self.retries += 1
        # Optionally back off, log to Mempalace, or emit a retry directive
        print(json.dumps({
            "action": "invoke_agent",
            "agent": "coder",
            "task_summary": f"Retry attempt {self.retries}/{self.max_retries}",
            "state": self.extract_state(),
        }))
```

### Action directive reference

| Action | Purpose | Required fields |
| --- | --- | --- |
| `invoke_agent` | Dispatch a single agent | `agent`, `task_summary`, `session_room` |
| `invoke_agents_parallel` | Dispatch agents in parallel | `tasks[]` with `agent`, `task_summary` |
| `escalate_to_user` | Pause for user input | `questions[]`, `unknown_reason`, `previous_state` |
| `complete` | Skill finished | `result` |
| `error` | Skill failed | `error` |

## Verification

- [ ] `start` initializes or resumes a session and emits exactly one JSON directive.
- [ ] `step` restores state, consumes the agent summary, saves state, and emits the next directive.
- [ ] `result` returns structured final output metadata.
- [ ] No non-JSON output is written to stdout.
- [ ] Full agent output is stored in Mempalace; only the summary is passed back.
- [ ] Session file round-trips through `extract_state()` / `restore_state()` without losing phase or model data.
- [ ] `error.execution` or explicit error transitions route failures to a retry or terminal state.

## Files

| File | Purpose |
| --- | --- |
| `docs/agents/state-management/orchestration-integration.md` | This guide |
| `docs/agents/state-management/state-machine-reference.md` | `python-statemachine` API reference |
| `docs/agents/state-management/skill-patterns.md` | Reusable workflow patterns |
| `docs/agents/skills/orchestration.md` | Full skill orchestration standard |
