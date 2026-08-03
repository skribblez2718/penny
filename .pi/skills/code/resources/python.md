# Python Coding Standards

Reference for skribble when implementing Penny itself in Python. For a target project, the selected target profile and its source evidence are authoritative; never replace project-native tooling with this resource.

## Project Conventions (Detect First)
Before writing, check these files. If they exist, follow their conventions:
- `pyproject.toml` — dependencies, tool config, project metadata
- `.pre-commit-config.yaml` — lint hooks
- `.venv/` — virtual environment (always activate: `. .venv/bin/activate`)

## Package Management (CRITICAL)
- In Penny, use the established `uv` lock/workspace tooling; in another target, use only the package manager evidenced by its selected target profile.
- In Penny, activate `.venv/`; never install globally.
- Add dependencies: `uv pip install <package>`
- Sync lockfile: `uv pip sync uv.lock`

## Style
- Follow project's existing style (indentation, naming, imports, docstrings)
- If no conventions detected: PEP 8, 4-space indentation, snake_case, type hints on all public functions
- Max line length: follow project config; default 120

## Testing (CRITICAL)
- Use `pytest` (project default unless overridden in pyproject.toml)
- Test files: `test_<module>.py` in `tests/` directory
- Tests are required at the tiers the IDEAL STATE marks applicable (lint/type/unit/integration/e2e); the sequencing (test-first, test-alongside, or test-after) is your call — the non-negotiable outcome is code + passing tests at those tiers, not a specific authoring rhythm. Never add a tier the project doesn't warrant.
- Every public function: ≥1 test
- Use fixtures for shared setup
- Mock external dependencies (APIs, databases, file I/O)

## Type Checking
- All public functions must have type hints
- Run `mypy` or `pyright` — project convention determines which
- Zero type errors allowed

## Linting
- Run `ruff check .` — zero errors
- Run `ruff format --check .` — must pass

## Anti-Patterns (AVOID)
- Bare `except:` — always specify exception type
- `import *` — explicit imports only
- Mutable default arguments (`def foo(x=[])`)
- Global mutable state without explicit justification
- Hardcoded secrets, API keys, or credentials
