# Perform TDD - Technical Reference

Detailed technical reference for the TDD skill.

## State Machine Details

### Transition Graph

```
         ┌─────────────────────────────────────────────────────────────┐
         │                                                              │
         │   ┌─────────┐     ┌─────────┐     ┌───────────┐            │
         │   │   red   │────▶│  green  │────▶│  refactor │            │
         │   └─────────┘     └─────────┘     └───────────┘            │
         │        ▲               │               │                   │
         │        │               │               │                   │
         │        │               ▼               ▼                   │
         │        │        (tests_pass)    (refactor_done)           │
         │        │                                          │        │
         │        │               │                          ▼        │
         │        │               │                   ┌───────────┐  │
         │        │               │                   │  document │  │
         │        │               │                   └───────────┘  │
         │        │               │                          │        │
         │        │          (still_failing)               │        │
         │        │               │                          ▼        │
         │        │               │                      (complete)   │
         │        └───────────────┘                                   │
         │                                                            │
         │   ┌─────────┐                                              │
         │   │  error  │◀──── error_execution (from any state)        │
         │   └─────────┘                                              │
         │                                                            │
         └─────────────────────────────────────────────────────────────┘

Guard Conditions:
- tests_pass(): failing_tests is empty
- can_retry(): iteration < max_iterations
- needs_more_tests(): refactor revealed missing coverage
- refactor_done(): refactor_passes >= 1
```

### State Details

#### `red` State

**Entry Action:**

1. Check iteration limit
2. Query Mempalace for TDD patterns
3. Load RED prompt template
4. Interpolate with context variables
5. Execute `coder` subagent
6. Parse result for test file and failing tests

**Exit Conditions:**

- `test_written`: Transition to `green`

**Error Handling:**

- Unhandled exception → `error_execution` → `error`

#### `green` State

**Entry Action:**

1. Load GREEN prompt template
2. Interpolate with failing tests list
3. Execute `coder` subagent
4. Parse result for remaining failures and passing tests

**Exit Conditions:**

- `still_failing` → `red` (if `can_retry()` and tests fail)
- `all_pass` → `refactor` (if `tests_pass()`)

**Error Handling:**

- Unhandled exception → `error_execution` → `error`

#### `refactor` State

**Entry Action:**

1. Load REFACTOR prompt template
2. Interpolate with implementation details
3. Execute `coder` subagent
4. Parse result for changes and suggestions

**Exit Conditions:**

- `needs_more` → `red` (if `needs_more_tests()`)
- `refactored` → `document` (if `refactor_done()`)

**Error Handling:**

- Unhandled exception → `error_execution` → `error`

#### `document` State

**Entry Action:**

1. Load DOCUMENT prompt template
2. Interpolate with files to document
3. Execute `coder` subagent
4. Parse result for updated docs
5. Store learnings in Mempalace

**Exit Conditions:**

- Automatic → `complete` (final state)

**Error Handling:**

- Unhandled exception → `error_execution` → `error`

## Subagent Integration

### Coder Subagent

Used for all phases. Provides:

- File reading/writing/editing
- Command execution (tests, linting)
- Project context awareness

### Prompt Template Interpolation

Variables available in all prompts:

| Variable        | Source    | Description                    |
| --------------- | --------- | ------------------------------ |
| `feature_name`  | Context   | Feature being implemented      |
| `test_file`     | Context   | Path to test file              |
| `impl_file`     | Context   | Path to implementation         |
| `context`       | Mempalace | Previous patterns and sessions |
| `failing_tests` | State     | List of failing test names     |

## Mempalace Integration

### Context Sources

| Wing    | Room        | Query                      | Purpose                      |
| ------- | ----------- | -------------------------- | ---------------------------- |
| `penny` | `technical` | `"TDD patterns {feature}"` | Similar features implemented |
| `penny` | `skills`    | `"TDD session {feature}"`  | Previous TDD sessions        |
| `penny` | `decisions` | KG query for `{feature}`   | Related decisions            |

### Query Pattern

```python
async def _get_context(self) -> str:
    # Technical patterns
    patterns = await memory_smart_search(
        f"TDD patterns {self.model.feature_name}",
        wing="penny",
        room="technical",
        limit=3
    )

    # Previous sessions
    sessions = await memory_smart_search(
        f"TDD session {self.model.feature_name}",
        wing="penny",
        room="skills",
        limit=2
    )

    return f"Patterns:\n{patterns}\n\nSessions:\n{sessions}"
```

### Learning Storage

| Wing    | Room     | Content                                              |
| ------- | -------- | ---------------------------------------------------- |
| `penny` | `skills` | Full session summary                                 |
| KG      | -        | `TDDSession:{id}` → `implemented` → `Feature:{name}` |

### Storage Pattern

```python
async def _store_learnings(self):
    await memory_add_drawer(
        wing="penny",
        room="skills",
        content=f"""
        TDD Session: {self.model.session_id}
        Feature: {self.model.feature_name}

        Files: {self.model.test_file}, {self.model.impl_file}
        Iterations: {self.model.iteration}
        Refactor passes: {self.model.refactor_passes}

        Decisions: {self.model.decisions}
        Lessons: {self.model.lessons}
        """
    )

    await memory_kg_add(
        subject=f"TDDSession:{self.model.session_id}",
        predicate="implemented",
        object=f"Feature:{self.model.feature_name}"
    )
```

## Session Persistence

### File Structure

```
.context/
└── {session_id}.json
```

### Schema

```json
{
  "session_id": "tdd-feature-2026-04-09",
  "current_state": "green",
  "phase": "green",
  "context": {
    "feature_name": "User Authentication",
    "test_file": "tests/test_auth.py",
    "impl_file": "src/auth.py",
    "failing_tests": ["test_refresh_token"],
    "passing_tests": ["test_login", "test_logout"],
    "iteration": 3,
    "refactor_passes": 0,
    "decisions": ["Extracted TokenManager class"],
    "lessons": []
  },
  "timestamp": "2026-04-09T14:30:00Z"
}
```

### Persistence Points

| Event            | Action                          |
| ---------------- | ------------------------------- |
| Session start    | Load if exists, else create new |
| State transition | Save session                    |
| Error            | Save session                    |
| Completion       | Delete session file             |

## Error Handling

### Iteration Limit

```python
if self.model.iteration > self.model.max_iterations:
    raise RuntimeError(f"Max iterations ({self.max_iterations}) exceeded")
```

### Subagent Errors

```python
async def _subagent(self, agent: str, task: str) -> Dict[str, Any]:
    try:
        result = await subagent(agent=agent, task=task)
        return result
    except Exception as e:
        # Triggers error_execution transition
        raise
```

### Error State Recovery

```python
# In error state callback
async def on_enter_error(self):
    # Session already saved by persistence
    print(f"Session paused due to error")
    print(f"Resume with: --session-id {self.model.session_id}")
```

## Configuration

### Environment Variables

| Variable              | Default    | Description              |
| --------------------- | ---------- | ------------------------ |
| `TDD_MAX_ITERATIONS`  | `10`       | Maximum red-green cycles |
| `TDD_REFACTOR_PASSES` | `1`        | Minimum refactor passes  |
| `TDD_SESSION_DIR`     | `.context` | Session file directory   |

### Configuration in Code

```python
@dataclass
class TDDContext:
    max_iterations: int = 10
    # ... other fields

# Override via CLI
parser.add_argument(
    "--max-iterations",
    type=int,
    default=10,
    help="Maximum TDD iterations"
)
```

## Testing

### Unit Tests

```python
# tests/test_workflow.py

def test_initial_state():
    context = TDDContext(session_id="test")
    workflow = TDDWorkflow(model=context)
    assert workflow.red.is_active

def test_red_to_green_transition():
    context = TDDContext(session_id="test", test_file="test.py")
    workflow = TDDWorkflow(model=context)
    workflow.test_written()
    assert workflow.green.is_active

def test_guard_blocks_invalid_transition():
    context = TDDContext(session_id="test")
    context.failing_tests = ["test_fail"]
    workflow = TDDWorkflow(model=context)
    assert not workflow.tests_pass()
```

### Integration Test

```python
# tests/test_integration.py

@pytest.mark.asyncio
async def test_full_tdd_cycle():
    manager = TDDSessionManager(
        session_id="test-integration",
        feature_name="Test Feature",
        project_root=Path("/tmp/test-project")
    )

    success = await manager.run()
    assert success
    assert manager.machine.is_terminated
```
