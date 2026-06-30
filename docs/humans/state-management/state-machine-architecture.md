# State Machine Architecture for Skills

This document explains how state machines integrate with Penny's skill system, including subagent execution and Mempalace knowledge management.

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────────┐
│                         SKILL.md                                │
│  (Skill definition, phases, success criteria)                   │
└──────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│                    scripts/orchestrate.py                        │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │                    StateChart (State Machine)              │  │
│  │                                                             │  │
│  │   ┌─────────┐    ┌─────────┐    ┌─────────┐               │  │
│  │   │  phase1 │───▶│  phase2 │───▶│  phase3 │               │  │
│  │   └─────────┘    └─────────┘    └─────────┘               │  │
│  │        │              │              │                     │  │
│  │        ▼              ▼              ▼                     │  │
│  │   on_enter       on_enter       on_enter                  │  │
│  │   callbacks      callbacks      callbacks                 │  │
│  └────────────────────────────────────────────────────────────┘  │
│                              │                                   │
│         ┌────────────────────┼────────────────────┐             │
│         ▼                    ▼                    ▼             │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐         │
│  │ Subagent    │    │ Mempalace   │    │ Local State │         │
│  │ (execution) │    │ (knowledge) │    │ (session)  │         │
│  └─────────────┘    └─────────────┘    └─────────────┘         │
│         │                    │                                    │
│         │      ┌─────────────┴─────────────┐                   │
│         │      │                           │                   │
│         │      ▼                           ▼                   │
│         │  Load context            Store learnings              │
│         │  (before phases)        (after completion)            │
└──────────────────────────────────────────────────────────────────┘
```

## Three-Layer Model

### Layer 1: State Machine (What Phase?)

The `StateChart` tracks **where we are** in the workflow:

```python
from statemachine import StateChart, State

class TDDSession(StateChart):
    """State machine for TDD workflow"""

    # States represent phases
    red = State(initial=True)
    green = State()
    refactor = State()
    doc = State(final=True)

    # Transitions represent valid moves
    test_written = red.to(green)
    still_failing = green.to(red)
    code_passes = green.to(refactor)
    refactored = refactor.to(doc)

    # Guards enforce conditions
    def tests_pass(self) -> bool:
        return self.failing_count == 0
```

**Responsibilities:**

- Track current phase
- Enforce transition guards
- Fire callbacks on enter/exit
- Provide visualization
- Handle errors gracefully

**Does NOT:**

- Execute code directly (use subagent)
- Store long-term knowledge (use Mempalace)
- Persist between sessions (use JSON)

### Layer 2: Subagent (Do the Work)

The Pi subagent executes **actual work**:

```python
async def on_enter_red(self):
    """Called when entering red phase"""

    # Get context from Mempalace
    context = await memory_smart_search(
        f"TDD patterns for {self.feature_name}",
        room="technical"
    )

    # Execute via subagent
    result = await subagent(
        agent="coder",
        task=f"""Write a failing test for {self.feature_name}.

        Context from previous sessions:
        {context}

        File: {self.test_file}
        """,
        cwd=self.project_root
    )

    # Update local state
    self.failing_tests = result.get("failing_tests", [])
    self.test_written = True
```

**Responsibilities:**

- Execute code, run commands, write files
- Access ALL Pi tools (read, write, bash, edit, web_search, etc.)
- Return structured results to state machine
- Report errors for state machine to handle

**Does NOT:**

- Maintain state (that's the StateChart's job)
- Know about other skills (isolation)
- Store learnings (that's Mempalace's job)

### Layer 3: Mempalace (Knowledge)

Mempalace provides **cross-session knowledge**:

```python
async def on_enter_completed(self):
    """Called when workflow completes successfully"""

    # Store learnings for future sessions
    await memory_add_drawer(
        wing="penny",
        room="skills",
        content=f"""
        TDD Session: {self.session_id}
        Feature: {self.feature_name}
        Tests written: {len(self.tests)}
        Refactorings: {self.refactor_count}
        Key decisions: {self.decisions}
        Lessons learned: {self.lessons}
        """
    )

    # Store relationships in knowledge graph
    await memory_kg_add(
        subject=f"TDDSession:{self.session_id}",
        predicate="implemented",
        object=f"Feature:{self.feature_name}"
    )
```

**Responsibilities:**

- Store learnings after completion
- Provide context before workflow start
- Track entity relationships
- Enable semantic search across sessions

**Does NOT:**

- Execute work (that's subagent's job)
- Maintain workflow state (that's StateChart's job)
- Handle real-time coordination (that's orchestrate.py)

## Data Flow

### Starting a Session

```python
class ResearchSkill(StateChart):
    question = State(initial=True)
    gathering = State()
    analyzing = State()
    complete = State(final=True)

    async def on_enter_question(self):
        """Load context when session starts"""

        # 1. Retrieve relevant context from Mempalace
        context = await memory_smart_search(
            f"research on {self.topic}",
            limit=5
        )

        # 2. Store in local state for use by subagents
        self.context = context

        # 3. Initialize session data
        self.sources = []
        self.findings = []
```

### During Execution

```python
async def on_enter_gathering(self):
    """Gather information using subagent"""

    result = await subagent(
        agent="researcher",
        task=f"""
        Research topic: {self.topic}

        Previous context:
        {self.context}

        Gather sources and summarize key findings.
        Return JSON with:
        - sources: list of source URLs/titles
        - findings: list of key insights
        """,
        cwd=self.project_root
    )

    # Update local state
    self.sources.extend(result["sources"])
    self.findings.extend(result["findings"])
```

### Completing a Session

```python
async def on_exit_analyzing(self):
    """Store learnings when analysis complete"""

    await memory_add_drawer(
        wing="penny",
        room="research",
        content=f"""
        Research Session: {self.session_id}
        Topic: {self.topic}
        Sources: {self.sources}
        Key Findings: {self.key_findings}
        Confidence: {self.confidence}
        """
    )
```

## Session Persistence

State machines should persist for recovery:

```python
import json
from pathlib import Path

class TDDSkill:
    def __init__(self, session_id: str, project_root: Path):
        self.session_id = session_id
        self.project_root = project_root
        self.state_file = project_root / ".sessions" / f"{session_id}.json"

        # Load or create state machine
        if self.state_file.exists():
            self.machine = self._load_session()
        else:
            self.machine = TDDSession()

    def _load_session(self) -> TDDSession:
        """Restore state from previous session"""
        data = json.loads(self.state_file.read_text())

        # Create state machine
        machine = TDDSession()
        machine.test_file = data.get("test_file")
        machine.failing_tests = data.get("failing_tests", [])

        # Restore state
        machine.current_state = data.get("state", "red")

        return machine

    def save_session(self):
        """Persist current state"""
        self.state_file.parent.mkdir(exist_ok=True)
        self.state_file.write_text(json.dumps({
            "session_id": self.session_id,
            "state": self.machine.current_state,
            "test_file": self.machine.test_file,
            "failing_tests": self.machine.failing_tests,
            "timestamp": datetime.now().isoformat()
        }, indent=2))
```

## Error Recovery

```python
class ResilientSkill(StateChart):
    working = State(initial=True)
    retrying = State()
    failed = State(final=True)
    completed = State(final=True)

    # Normal flow
    process = working.to(working, on="do_work")
    finish = working.to(completed)

    # Error handling
    error_execution = working.to(retrying)

    # Retry logic
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

        # Log retry attempt
        await memory_add_drawer(
            wing="penny",
            room="sessions",
            content=f"Retry {self.retries}/{self.max_retries} for {self.session_id}"
        )
```

## Async Integration

All callbacks can be async - the engine handles it:

```python
class AsyncSkill(StateChart):
    idle = State(initial=True)
    processing = State()
    done = State(final=True)

    start = idle.to(processing)
    finish = processing.to(done)

    async def on_enter_processing(self):
        """Async callbacks just work"""

        # Async subagent call
        result = await subagent(agent="worker", task="process data")

        # Async Mempalace call
        await memory_add_drawer(wing="penny", room="sessions", content=result)

        # Auto-transition when done
        self.finish()
```

## Best Practices

1. **Keep state minimal** - Only store what's needed for guards and transitions
2. **Do work in subagents** - State machine orchestrates, subagent executes
3. **Store learnings in Mempalace** - Cross-session knowledge persistence
4. **Use compound states for complex workflows** - Hierarchical organization
5. **Handle errors with `error.execution`** - Graceful degradation
6. **Persist session state** - Enable recovery from interruption
7. **Visualize early** - Generate diagrams before implementing
8. **Test transitions** - Each guard and callback should be unit-testable
