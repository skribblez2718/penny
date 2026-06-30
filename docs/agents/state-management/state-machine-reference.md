# State Machine Reference — `python-statemachine` for skills

## What

Agent reference for implementing skill state machines with the `python-statemachine` library. Use this document when you need to declare states, transitions, guards, callbacks, compound states, parallel states, async handlers, and error recovery inside a Penny skill.

## Why

Skills have non-trivial workflows (red-green-refactor, gather-analyze-synthesize, frame-explore-evaluate-decide). State machines replace nested conditionals with explicit phases and valid transitions, which makes recovery, visualization, and subprocess round-trips straightforward.

**Canonical library choice:** `python-statemachine`

| Library | Maintenance | Key features | Fit |
| --- | --- | --- | --- |
| **python-statemachine** | Active (v3.0) | Compound/parallel states, history, async, `error.execution` | ★★★★★ |
| `transitions` | Stale gap | Requires extensions for compound/async | ★★★☆☆ |
| LangGraph | Active | Tool-wrapping overhead, orchestration layer | ★★☆☆☆ |

Reasons for the canonical choice: SCXML-style processing model, built-in compound/parallel states, async-native callbacks, and first-class `error.execution` events.

## Rules

1. **Inherit from `StateChart`**. Use `from statemachine import StateChart, State`.
2. **Keep machine state minimal.** Only store data needed by guards and transition logic.
3. **Do work in subagents.** `on_enter` callbacks may dispatch agents; they must not perform long-running work themselves.
4. **Keep cross-session knowledge in Mempalace.** Do not use the state machine as a long-term store.
5. **Persist session state between subprocess calls.** Write serializable snapshots to `/tmp/<skill>-<session_id>.json`.
6. **Use `error.execution` for runtime errors.** Catch failures in a dedicated state instead of swallowing exceptions.
7. **Guards must be side-effect free.** Guards return booleans; they do not mutate state or call tools.
8. **`orchestrate.py` stdout is JSON-only.** Any output not intended for Penny routing goes to stderr.

### What state machines should and should NOT do

| Should | Should NOT |
| --- | --- |
| Track the current phase and valid next phases | Execute code, run tests, or write files directly |
| Enforce transition guards | Store cross-session knowledge |
| Fire callbacks that dispatch subagents | Print non-JSON output to stdout |
| Persist enough state to resume a session | Replace outcome-ledger or Mempalace records |
| Recover from errors with `error.execution` | Hide or silently swallow exceptions |

## Procedure/Constraints

### StateChart class structure

```python
from dataclasses import dataclass, field
from typing import List
from statemachine import StateChart, State

@dataclass
class SkillContext:
    session_id: str
    feature: str = ""
    results: List[str] = field(default_factory=list)

class MySkill(StateChart[SkillContext]):
    idle = State(initial=True)
    working = State()
    done = State(final=True)

    start = idle.to(working)
    finish = working.to(done)
```

Use `final=True` for terminal states. A machine reaches `is_terminated` when it enters a final state.

### States and transitions

```python
class ResearchFlow(StateChart):
    question = State(initial=True)
    gathering = State()
    analyzing = State()
    complete = State(final=True)

    # Simple transition
    start = question.to(gathering)

    # Conditional transition
    analyze = gathering.to(analyzing, cond="has_enough_data")

    # Reflexive transition when guard fails
    keep_gathering = gathering.to.itself(cond="needs_more_data")

    # Eventless (auto-fires when condition becomes true)
    analyzing.to(complete, cond="is_complete")
```

### Guards

Guards are boolean methods referenced by name on the transition. They are evaluated when the transition is attempted.

```python
def has_enough_data(self) -> bool:
    return len(self.model.sources) >= 3

def needs_more_data(self) -> bool:
    return len(self.model.sources) < 3

def is_complete(self) -> bool:
    return self.model.confidence >= 0.8
```

### Callbacks

`on_enter_<state>` and `on_exit_<state>` run when entering or leaving a state. `before_<event>` and `after_<event>` run around a transition.

```python
async def on_enter_gathering(self):
    context = await memory_smart_search(self.model.feature, limit=3)
    self.model.context = context
    # Dispatch handled by orchestration layer; see orchestration-integration.md

def on_exit_analyzing(self):
    self.model.temp_files.clear()

def before_start(self, source: State, target: State):
    logger.info(f"{source.id} -> {target.id}")
```

### Compound states

Use compound states for sequential sub-phases that belong to a single parent phase.

```python
class DocumentFlow(StateChart):
    class editing(State.Compound):
        draft = State(initial=True)
        review = State()
        revise = State()

        submit = draft.to(review)
        request_changes = review.to(revise)
        back_to_draft = revise.to(draft)

    published = State(final=True)

    approve = editing.to(published)
```

### Parallel states

Use parallel states only for independent concurrent tracks that must both complete before the parent can finish.

```python
class DeployFlow(StateChart):
    class deploy(State.Parallel):
        class build(State.Compound):
            compiling = State(initial=True)
            built = State(final=True)
            done = compiling.to(built)

        class tests(State.Compound):
            running = State(initial=True)
            passed = State(final=True)
            done = running.to(passed)

    released = State(final=True)

    # Auto-fires once every parallel region reaches a final state
    deploy.to(released)
```

### Error handling with `error.execution`

```python
class ResilientFlow(StateChart):
    working = State(initial=True)
    retrying = State()
    failed = State(final=True)
    completed = State(final=True)

    process = working.to(working, on="do_work")
    finish = working.to(completed)

    # Catches unhandled exceptions raised inside callbacks
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
        await memory_add_drawer(
            wing="penny",
            room="sessions",
            content=f"Retry {self.retries}/{self.max_retries} for {self.model.session_id}"
        )
```

### Async support

`python-statemachine` supports async `on_enter`, `on_exit`, and action callbacks. Use `await` for subagent and Mempalace calls.

```python
class AsyncFlow(StateChart):
    idle = State(initial=True)
    processing = State()
    done = State(final=True)

    start = idle.to(processing)
    finish = processing.to(done)

    async def on_enter_processing(self):
        result = await subagent(agent="worker", task="process data")
        self.model.result = result
        self.finish()
```

### Serialization for subprocess round-trips

`orchestrate.py` is invoked once per skill turn, so the machine must be restorable.

```python
import json
from pathlib import Path

class MySkill(StateChart[SkillContext]):
    # ... states and transitions ...

    def extract_state(self) -> dict:
        return {
            "state": self.current_state.id,
            "context": self.model.__dict__,
        }

    @classmethod
    def restore_state(cls, data: dict) -> "MySkill":
        model = SkillContext(**data["context"])
        machine = cls(model=model)
        machine.current_state = data["state"]
        return machine

def save_session(machine: MySkill, path: Path):
    path.write_text(json.dumps(machine.extract_state(), indent=2))

def load_session(path: Path) -> MySkill:
    data = json.loads(path.read_text())
    return MySkill.restore_state(data)
```

## Verification

- [ ] Skill inherits from `StateChart` and imports `State` from `python-statemachine`.
- [ ] Guards are pure boolean checks with no side effects.
- [ ] `on_enter` callbacks dispatch subagents rather than performing work directly.
- [ ] Compound states group sub-phases under a single parent.
- [ ] Parallel states are only used for genuinely independent concurrent tracks.
- [ ] `error.execution` transitions route errors to a recovery or failure state.
- [ ] Async callbacks use `await` for subagent and Mempalace calls.
- [ ] `extract_state()` / `restore_state()` produce a machine that resumes in the same phase.

## Files

| File | Purpose |
| --- | --- |
| `docs/agents/state-management/state-machine-reference.md` | This reference |
| `docs/agents/state-management/orchestration-integration.md` | Wiring state machines into `orchestrate.py` |
| `docs/agents/state-management/skill-patterns.md` | Ready-to-use workflow patterns |
