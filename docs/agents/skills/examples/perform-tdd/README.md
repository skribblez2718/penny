# Perform TDD Skill

Execute Test-Driven Development workflow for feature implementation.

## Universal Standards

\*\*All Python must have:"

- Lint passes (`ruff check scripts/`)
- Unit tests (`pytest tests/test_unit.py`)
- Integration tests (`pytest tests/test_integration.py`)
- E2E tests (`pytest tests/test_e2e.py -m e2e`)

**TDD for ALL coding.**

## Overview

- **Purpose**: Guide TDD workflow from red to green to refactor
- **Use When**: Implementing features, fixing bugs with tests, explicit TDD requests
- **Outcome**: Tested, refactored, documented implementation

## State Machine

```
┌─────────────────────────────────────────────────────────────────────┐
│                                                                      │
│   ┌─────────┐     ┌─────────┐     ┌───────────┐     ┌───────────┐  │
│   │   red   │────▶│  green  │────▶│  refactor │────▶│  document │  │
│   └─────────┘     └─────────┘     └───────────┘     └───────────┘  │
│        ▲               │                                                  │
│        │               │                                                  │
│        └───────────────┘                                                  │
│            still_failing                                                  │
│                                                                          │
│   ┌─────────┐                                                            │
│   │  error  │ ◀─── error_execution (from any state)                      │
│   └─────────┘                                                            │
│                                                                          │
└─────────────────────────────────────────────────────────────────────┘
```

### States

| State      | Description          | Entry Action                                           |
| ---------- | -------------------- | ------------------------------------------------------ |
| `red`      | Write failing test   | Query Mempalace for patterns, invoke coder subagent    |
| `green`    | Make test pass       | Invoke coder with failing test, minimal implementation |
| `refactor` | Improve code quality | Invoke coder to refactor while keeping tests green     |
| `document` | Update docs          | Invoke coder to add docstrings, update README          |
| `error`    | Failure state        | Log error, optionally retry                            |

### Transitions

| Transition        | From     | To       | Guard             | Description          |
| ----------------- | -------- | -------- | ----------------- | -------------------- |
| `test_written`    | red      | green    | None              | Test file created    |
| `still_failing`   | green    | red      | `iteration < max` | Tests still failing  |
| `all_pass`        | green    | refactor | `tests_pass()`    | All tests passing    |
| `needs_more`      | refactor | red      | `iteration < max` | More tests needed    |
| `refactored`      | refactor | document | `refactor_done()` | Refactoring complete |
| `complete`        | document | (final)  | None              | Documentation done   |
| `error_execution` | \*       | error    | None              | Unhandled exception  |

## Subagents Used

| Subagent | Purpose                 | Prompt File                  |
| -------- | ----------------------- | ---------------------------- |
| `coder`  | Write failing test      | `assets/prompts/red.md`      |
| `coder`  | Make test pass          | `assets/prompts/green.md`    |
| `coder`  | Refactor implementation | `assets/prompts/refactor.md` |
| `coder`  | Add documentation       | `assets/prompts/document.md` |

## Mempalace Integration

### Context Retrieved (before workflow)

| Wing    | Room        | Query                          |
| ------- | ----------- | ------------------------------ |
| `penny` | `technical` | "TDD patterns {feature_name}"  |
| `penny` | `skills`    | "TDD session {feature_name}"   |
| `penny` | `decisions` | KG query for related decisions |

### Learnings Stored (after completion)

| Wing    | Room     | Content                                              |
| ------- | -------- | ---------------------------------------------------- |
| `penny` | `skills` | Session summary, iterations, decisions               |
| KG      | -        | `TDDSession:{id}` → `implemented` → `Feature:{name}` |

## Files

```
perform-tdd/
├── SKILL.md                    # AgentSkills.io format
├── README.md                   # This file
├── scripts/
│   └── orchestrate.py          # State machine + entry point
├── assets/
│   ├── prompts/
│   │   ├── red.md              # RED phase prompt
│   │   ├── green.md            # GREEN phase prompt
│   │   ├── refactor.md         # REFACTOR phase prompt
│   │   └── document.md         # DOCUMENT phase prompt
│   └── templates/
│       └── test_template.md    # Test file template
├── resources/
│   └── reference.md            # Detailed reference
└── .context/
    └── {session_id}.json       # Session state (auto-generated)
```

## Usage

### Via Agent Discovery

The skill is automatically discovered by Pi/agent when:

1. User mentions "TDD" or "test-driven development"
2. User asks to "implement with tests"
3. Agent detects new feature implementation context

### Direct Invocation (Testing)

```bash
cd .pi/skills/perform-tdd
python scripts/orchestrate.py \
    --session-id "tdd-user-auth-2026-04-09" \
    --project-root "/home/user/projects/myapp" \
    --feature "User Authentication" \
    --test-file "tests/test_auth.py"
```

## Example Session

```
User: "Implement user authentication using TDD"

Agent: Activating perform-tdd skill...

[RED PHASE]
- Query Mempalace for "TDD patterns authentication"
- Invoke coder with RED prompt
- Create tests/test_auth.py with failing tests
- Tests: test_login_returns_token, test_logout_clears_session

[GREEN PHASE]
- Invoke coder with GREEN prompt
- Create src/auth.py with minimal implementation
- Tests: 2 passing, 0 failing

[REFACTOR PHASE]
- Invoke coder with REFACTOR prompt
- Extract TokenManager class
- Improve password hashing
- All tests still passing

[DOCUMENT PHASE]
- Invoke coder with DOCUMENT prompt
- Add docstrings to TokenManager
- Update README.md with auth section

[COMPLETE]
- Store session in Mempalace:
  - Session: tdd-user-auth-2026-04-09
  - Iterations: 2
  - Decisions: Extracted TokenManager class
  - Lessons: Consider refresh token pattern

✅ TDD workflow completed successfully
```

## Error Handling

### Error States

| Error                     | Cause                     | Recovery                              |
| ------------------------- | ------------------------- | ------------------------------------- |
| `max_iterations_exceeded` | Too many red-green cycles | Store partial progress in Mempalace   |
| `test_file_not_created`   | RED phase failed          | Prompt user for clarification         |
| `implementation_failed`   | GREEN phase failed        | Store failing state, suggest rollback |

### Retry Strategy

- **Max iterations**: 10 (configurable)
- **Backoff**: None (immediate retry)
- **Recovery**: Restore from `.context/{session_id}.json`

## Configuration

| Environment Variable  | Default    | Description                   |
| --------------------- | ---------- | ----------------------------- |
| `TDD_MAX_ITERATIONS`  | 10         | Maximum red-green cycles      |
| `TDD_REFACTOR_PASSES` | 2          | Refactor iterations           |
| `TDD_SESSION_DIR`     | `.context` | Session persistence directory |

## Testing

```bash
# Unit tests
cd .pi/skills/perform-tdd
python -m pytest tests/

# Integration test
python scripts/orchestrate.py \
    --session-id test-001 \
    --feature "Test Feature" \
    --test-file "tests/test_example.py"
```

## Testing

```bash
# Lint
ruff check scripts/

# Unit tests
pytest tests/test_unit.py -v

# Integration tests
pytest tests/test_integration.py -v

# E2E tests
pytest tests/test_e2e.py -v -m e2e

# All tests
pytest scripts/ -v
```

## Version History

- **1.0.0** - Initial release with RED-GREEN-REFACTOR-DOCUMENT cycle
