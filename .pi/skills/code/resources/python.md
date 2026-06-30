# Python Coding Standards

Reference for skribble. Always read before writing Python code.

## Project Conventions (Detect First)
Before writing, check these files. If they exist, follow their conventions:
- `pyproject.toml` — dependencies, tool config, project metadata
- `.pre-commit-config.yaml` — lint hooks
- `.venv/` — virtual environment (always activate: `. .venv/bin/activate`)

## Package Management (CRITICAL)
- **ALWAYS** use `uv` for package management. NEVER use bare `pip`.
- **ALWAYS** use `.venv/` — activate it first. NEVER install globally.
- Add dependencies: `uv pip install <package>`
- Sync lockfile: `uv pip sync uv.lock`

## Style
- Follow project's existing style (indentation, naming, imports, docstrings)
- If no conventions detected: PEP 8, 4-space indentation, snake_case, type hints on all public functions
- Max line length: follow project config; default 120

## Testing (CRITICAL)
- Use `pytest` (project default unless overridden in pyproject.toml)
- Test files: `test_<module>.py` in `tests/` directory
- Write failing test FIRST (RED), then implementation (GREEN), then refactor
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
