---
name: perform-tdd
description: Execute Test-Driven Development workflow. Use when implementing new features, fixing bugs with tests, or when user explicitly requests TDD approach.
license: MIT
metadata:
  version: "1.0.0"
  penny:
    state_machine: true
    mempalace: true
    subagents:
      - coder
---

## When to Use

- Implementing a new feature from scratch
- User explicitly requests TDD approach
- Adding new functionality to existing codebase
- Fixing bugs where test coverage would help
- Starting a new component or module
- Code requires clear interface contracts first

## When Not to Use

- Emergency hotfixes requiring immediate deployment
- Exploratory prototyping (use perform-research instead)
- Simple configuration changes
- One-off scripts that won't be maintained
- Existing well-tested code that needs minor tweaks
- When perform-fix is more appropriate for isolated bug fixes

## Launch

Entry point (state machine handles all phases):

```bash
python scripts/orchestrate.py --session-id <session-id> --feature <feature-name> [options]
```

## Options

| Flag               | Required | Description                                                |
| ------------------ | -------- | ---------------------------------------------------------- |
| `--session-id`     | Yes      | Unique session identifier                                  |
| `--feature`        | Yes      | Feature name to implement                                  |
| `--project-root`   | No       | Project root directory (default: current)                  |
| `--test-file`      | No       | Test file path (optional, auto-generated if not specified) |
| `--max-iterations` | No       | Maximum TDD iterations (default: 10)                       |

## Phases

The state machine automatically invokes these phases:

1. **RED** - Write failing test
2. **GREEN** - Make test pass
3. **REFACTOR** - Improve code quality
4. **DOCUMENT** - Add documentation
