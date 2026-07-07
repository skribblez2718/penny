# Python Coding Standards — Style, patterns, idioms, and testing

## What

All Python code in this project follows these conventions. Applies to skill orchestrators, tool wrappers, watchers, and scripts.

## Why

Consistent style reduces cognitive load when reading code across skills. Agents writing Python must produce code that passes lint, format, and typecheck.

## Rules

1. **Lint passes with zero errors.** `flake8 . --max-line-length=120 --extend-ignore=E203,E501,W503,W504`
2. **Format passes.** `black . --config pyproject.toml`
3. **Typecheck passes.** `mypy . --config-file pyproject.toml`
4. **Use `python-statemachine` for state machines.** Canonical implementation. No custom FSM.
5. **Use `pathlib.Path` for filesystem paths.** Not `os.path` or string concatenation.
6. **Use dataclasses for state containers.** Not dicts with string keys.
7. **Type hints on all public functions.** Return types required.

## Testing

- **pytest** for all Python tests
- **Unit tests** per module in `tests/test_unit.py`
- **Integration tests** in `tests/test_integration.py`
- **E2E tests** in `tests/test_e2e.py`
- **Run:** `python3 -m pytest tests/ -v`

## Constraints

- **No `console.log` equivalent.** Use the shared logger from `.pi/lib/logger/logger.ts` (TypeScript) or structured logging (Python).
- **No hardcoded paths.** Use `pathlib.Path` relative to project root or configurable via env.
- **No `sys.path` hacks for imports.** Use proper package structure.

## Verification

- [ ] `flake8` passes with zero errors
- [ ] `black --check` passes
- [ ] `mypy` passes
- [ ] All tests pass

## Files

| File | Purpose |
|------|---------|
| `pyproject.toml` | Black, mypy, pytest config |
| `.flake8` | Flake8 config |
