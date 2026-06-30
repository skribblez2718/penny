# Skill State Management with python-statemachine

This guide covers state management for Penny skills using the `python-statemachine` library. State machines enable robust, declarative skill orchestration with clear phases, transitions, and error handling.

## Why State Machines for Skills?

Skills often have complex workflows:

- **TDD Skill**: red → green → refactor → doc → completed
- **Research Skill**: question → gather → analyze → synthesize → report
- **Decision Skill**: frame → explore → evaluate → decide → document

Without state management, these become tangled if/else chains. State machines provide:

- **Clarity**: Current phase is always known
- **Guarards**: Conditions must be met before transitions
- **Callbacks**: Automatic actions on enter/exit
- **Visualization**: Generate diagrams for understanding
- **Error Handling**: Catch errors and recover gracefully

## Library Choice: python-statemachine

Based on our evaluation (April 2026), we chose `python-statemachine` over alternatives:

| Library                 | Maintenance               | Features                                    | Fit   |
| ----------------------- | ------------------------- | ------------------------------------------- | ----- |
| **python-statemachine** | ✅ Active (v3.0 Feb 2026) | Compound states, parallel, history, async   | ★★★★★ |
| transitions             | ⚠️ 9mo gap                | Basic FSM, requires extensions              | ★★★☆☆ |
| LangGraph               | ✅ Active                 | Tool wrapping overhead, orchestration layer | ★★☆☆☆ |

**Key advantages:**

- SCXML-compliant processing model
- Compound and parallel states built-in
- History pseudo-states
- Async-native (no extension needed)
- `error.execution` event for graceful error handling
- Active maintenance and modern Python support

## Quick Start

```bash
pip install python-statemachine
```

```python
from statemachine import StateChart, State

class TDDSession(StateChart):
    """TDD workflow state machine for a single session."""

    red = State(initial=True)
    green = State()
    refactor = State()
    completed = State(final=True)

    # Transitions
    test_written = red.to(green)
    still_failing = green.to(red)

    # Eventless transition (auto-fires when condition met)
    all_pass = green.to(refactor, cond="tests_pass")
    refactored = refactor.to(completed)

    # Internal data
    test_file: str = ""
    failing_tests: list = []

    def tests_pass(self) -> bool:
        return len(self.failing_tests) == 0

    def on_enter_red(self):
        print(f"🔴 Writing failing test for: {self.test_file}")

    def on_enter_green(self):
        print(f"🟢 Making the test pass")

    async def on_enter_completed(self):
        print(f"✅ TDD session complete!")

# Usage
session = TDDSession()
session.test_file = "test_user.py"
session.test_written()  # red → green
```

## Architecture Integration

```
SKILL.md
    └── scripts/orchestrate.py
            ├── StateChart (python-statemachine)
            │      • Tracks phases, transitions, guards
            │      • Handles callbacks and errors
            │      • Provides visualization
            │
            ├── Pi Subagent Tool
            │      • Executes tasks
            │      • Has ALL Pi tools available
            │      • Returns results to state machine
            │
            └── Mempalace
                   • Query context before workflow
                   • Store learnings after completion
                   • Cross-session knowledge
```

### Separation of Concerns

| Layer         | Responsibility                      | Tool                  |
| ------------- | ----------------------------------- | --------------------- |
| **State**     | What phase? What transitions valid? | `python-statemachine` |
| **Execution** | Do the work                         | Pi subagent           |
| **Knowledge** | Context & learnings                 | Mempalace             |

## Key Concepts

### States

States represent phases in a skill workflow:

```python
class ResearchSkill(StateChart):
    # Simple states
    idle = State(initial=True)
    gathering = State()
    analyzing = State()
    complete = State(final=True)

    # Compound states (hierarchical)
    class research(State.Compound):
        """Research phase with sub-states"""
        searching = State(initial=True)
        reading = State()
        summarizing = State()

    # Final state
    done = State(final=True)
```

### Transitions

Transitions define valid moves between states:

```python
# Simple transition
start = idle.to(gathering)

# Conditional transition with guard
analyze = gathering.to(analyzing, cond="has_enough_data")

# Multiple transitions with same trigger
cycle = (
    gathering.to(analyzing, cond="ready")
    | gathering.to.itself()  # reflexive if not ready
)

# Eventless transition (auto-fires)
research.to(done, cond="sufficient_answers")
```

### Guards (Conditions)

Guards prevent invalid transitions:

```python
def has_enough_data(self) -> bool:
    return len(self.sources) >= 3

def sufficient_answers(self) -> bool:
    return all(q.answered for q in self.questions)
```

### Callbacks

Execute code at state transitions:

```python
async def on_enter_gathering(self):
    # Query Mempalace for relevant context
    context = await memory_smart_search(self.topic)
    self.context = context

def on_exit_analyzing(self):
    # Clean up intermediate results
    self.temp_files.clear()

def before_analyze(self, source: State, target: State):
    # Log transition
    logger.info(f"Transitioning from {source.id} to {target.id}")
```

### Compound States

Hierarchical states for complex workflows:

```python
class DocumentSkill(StateChart):
    class editing(State.Compound):
        """Editing phase with sub-states"""
        draft = State(initial=True)
        review = State()
        revise = State()

        submit = draft.to(review)
        request_changes = review.to(revise)
        accept = review.to(draft)  # back to parent

    published = State(final=True)

    approve = editing.to(published)
```

### Parallel States

Concurrent execution paths:

```python
class DeploymentSkill(StateChart):
    class deploy(State.Parallel):
        """Deploy runs build and tests in parallel"""
        class build(State.Compound):
            compiling = State(initial=True)
            compiled = State(final=True)
            finish_build = compiling.to(compiled)

        class tests(State.Compound):
            running = State(initial=True)
            passed = State(final=True)
            finish_tests = running.to(passed)

    released = State(final=True)

    # Auto-fires when both build and tests are final
    done_state_deploy = deploy.to(released)
```

### Error Handling

Built-in error handling via `error.execution` events:

```python
class ResilientSkill(StateChart):
    working = State(initial=True)
    failed = State(final=True)

    process = working.to(working, on="do_work")
    error_execution = working.to(failed)  # catches exceptions

    def do_work(self):
        raise RuntimeError("something broke")

# Usage - error is caught and routed
skill = ResilientSkill()
skill.send("process")
assert skill.failed.is_active  # True
```

## Documentation Index

| Document                        | Description                                                        |
| ------------------------------- | ------------------------------------------------------------------ |
| [Architecture](architecture.md) | How state machines integrate with skills, subagents, and Mempalace |
| [Patterns](patterns.md)         | Common skill patterns (TDD, Research, Decision)                    |
| [Examples](examples/)           | Working code examples                                              |

## Installation

```bash
# Basic installation
pip install python-statemachine

# With diagram generation support
pip install python-statemachine[diagrams]
```

## Next Steps

1. Read the [Architecture Guide](architecture.md) to understand integration
2. Review [Patterns](patterns.md) for common skill implementations
3. Explore [Examples](examples/) for working code
4. Check the [official docs](https://python-statemachine.readthedocs.io/) for API reference
