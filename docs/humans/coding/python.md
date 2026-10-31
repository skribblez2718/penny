# Python Coding Best Practices

A human-readable guide to writing clean, maintainable, and secure Python code.

## Project Toolchain

The commands and TypeScript-only orchestration rule below apply to Penny-owned code.
Caller-owned Python uses its own toolchain and architecture; the type, validation, and
test principles transfer without imposing Penny's root commands. Implementation runs
applicable gates; review/diagnosis assesses evidence and gaps; planning identifies
required evidence without claiming it exists.

Penny requires Python 3.12 or newer. `uv` owns the Python environment and
`uv.lock`; use frozen syncs for setup and checks. Black formats Python, Flake8
lints it, mypy checks typed production code, and pytest runs Python tests.
Workflow orchestration remains TypeScript under `apps/orchestration/` and uses
Bun; do not implement skill workflows in Python.

The configured commands are:

```bash
make setup-dev              # frozen Bun and uv development dependencies
bun run py:format:check     # Black, configured by pyproject.toml
bun run py:lint             # Flake8, configured by .flake8
bun run py:typecheck        # mypy, configured by pyproject.toml
.venv/bin/python -m pytest <path> -p no:cacheprovider --tb=short -q
```

`make lint` runs the Python format/lint gates with the repository's other
checks. `make test` runs Bun unit tests, repository guards, and the applicable
Python test directories in isolated pytest processes.

## The Zen of Python

Before writing Python, internalize these principles (run `import this` in a Python REPL):

1. **Beautiful is better than ugly** — Write code you'd be proud to show in a code review.
2. **Explicit is better than implicit** — Don't hide logic behind clever tricks.
3. **Simple is better than complex** — If you need a comment to explain it, simplify it.
4. **Readability counts** — Code is read many more times than it's written.
5. **Errors should never pass silently** — Catch specific exceptions, not everything.
6. **There should be one obvious way to do it** — Follow conventions, not personal preference.
7. **Now is better than never** — Fix technical debt before it compounds.

## Style and Formatting

### Indentation and Line Length

- **4 spaces** for indentation (never tabs)
- **100 characters** max line length (the configured Black and Flake8 limit)
- If a line is too long, use implicit line continuation inside parentheses:

```python
# Good
result = some_function(
    very_long_argument_name,
    another_long_argument,
    optional_param=True,
)

# Bad
result = some_function(very_long_argument_name, another_long_argument, optional_param=True)
```

### Naming Conventions

| What      | Convention                 | Example              |
| --------- | -------------------------- | -------------------- |
| Modules   | lowercase_with_underscores | `data_loader.py`     |
| Classes   | CapWords                   | `DataLoader`         |
| Functions | lowercase_with_underscores | `load_data()`        |
| Constants | UPPER_CASE                 | `MAX_RETRIES = 3`    |
| Private   | leading underscore         | `_internal_helper()` |

### Imports

Group and sort imports in this order:

1. `from __future__` imports
2. Standard library
3. Third-party packages
4. Local modules

```python
from __future__ import annotations

import json
import sys
from pathlib import Path

import requests
from pydantic import BaseModel

from myproject.utils import helper
```

## Modern Python Patterns

### pathlib Over os.path

The `pathlib` module provides an object-oriented, cross-platform way to handle paths:

```python
from pathlib import Path

# Instead of: os.path.join('data', 'processed')
data_dir = Path('data') / 'processed'
data_dir.mkdir(parents=True, exist_ok=True)

# Instead of: os.path.splitext(filepath)[0] + '.json'
json_path = filepath.with_suffix('.json')
```

### Dataclasses for Data Containers

Use `@dataclass` to reduce boilerplate for simple data structures:

```python
from dataclasses import dataclass

@dataclass
class User:
    name: str
    email: str
    active: bool = True

# Auto-generated: __init__, __repr__, __eq__
user = User(name="Alice", email="alice@example.com")
```

For validation, upgrade to **Pydantic**:

```python
from pydantic import BaseModel, EmailStr

class User(BaseModel):
    name: str
    email: EmailStr  # Validates email format
    age: int = 0
```

### Type Hints

Type hints improve readability and catch bugs early. Use them on all public APIs:

```python
def fetch_user(user_id: int, include_deleted: bool = False) -> User | None:
    """Fetch a user by ID."""
    ...

# Modern syntax (Python 3.10+)
def process(items: list[str]) -> dict[str, int]:
    ...
```

### Context Managers for Resources

Always use `with` statements for files, locks, database connections, and other resources:

```python
with open('data.txt', 'r') as f:
    content = f.read()
# File is automatically closed, even if an exception occurs
```

### List and Dict Comprehensions

Use comprehensions for simple transformations. Switch to loops for complex logic:

```python
# Good — simple and readable
squares = [x**2 for x in range(10)]
lookup = {item.id: item for item in items}

# Bad — too complex for one line
result = [(x, y) for x in range(10) for y in range(5) if x * y > 10]
```

### f-strings for Formatting

Use f-strings for all string formatting:

```python
# Good
message = f"Hello {name}, you have {count} items"

# Bad
message = "Hello " + name + ", you have " + str(count) + " items"
```

### Guard Clauses for Early Returns

Reduce nesting by handling edge cases first:

```python
# Good
def process_payment(order, user):
    if not order.is_valid:
        return False
    if not user.has_payment_method:
        return False
    # Main logic here (no deep nesting)

# Bad — deeply nested
def process_payment(order, user):
    if order.is_valid:
        if user.has_payment_method:
            # Main logic
```

## Error Handling

### Catch Specific Exceptions

Never use bare `except:` — it catches `SystemExit`, `KeyboardInterrupt`, and more:

```python
# Bad
try:
    process()
except:
    pass  # Silently swallows EVERYTHING

# Good
try:
    process()
except ValueError as e:
    logger.warning(f"Invalid input: {e}")
except ConnectionError:
    logger.error("Network failure")
```

### Don't Use assert for Runtime Validation

`assert` statements can be disabled with `-O` flag. Use them only for internal invariants:

```python
# Bad — assert can be skipped
assert minimum >= 1024, "Minimum port must be at least 1024"

# Good
if minimum < 1024:
    raise ValueError(f"Minimum port must be ≥1024, got {minimum}")
```

## Testing

### pytest Best Practices

Install the locked development environment with `make setup-dev` (or
`uv sync --frozen --offline --all-extras` when following the underlying command).
Never use bare `pip` or install project dependencies globally.

```python
# test_calculator.py
def test_add_two_numbers():
    # Arrange
    calc = Calculator()

    # Act
    result = calc.add(2, 3)

    # Assert
    assert result == 5

def test_divide_by_zero_raises():
    calc = Calculator()
    with pytest.raises(ZeroDivisionError):
        calc.divide(1, 0)
```

### Test-Driven Development (TDD)

1. **Red**: Write a failing test that describes the desired behavior
2. **Green**: Write the minimum code to make the test pass
3. **Refactor**: Clean up the code while keeping tests green

## Formatting, Linting, and Type Checking

Use the tools and checked-in configuration the repository actually invokes:

```bash
bun run py:format          # Black writes formatting changes
bun run py:format:check    # Black check only
bun run py:lint            # Flake8, zero errors required
bun run py:typecheck       # mypy production-code gate
```

Black and Flake8 both use a 100-character line limit. Mypy targets Python 3.12
and excludes tests, which remain governed by pytest plus the
repository's test-discovery and compliance checks. Ruff is not part of Penny's
configured Python toolchain.

## Dependency Management

**Always use `uv`** for Python dependency and environment management:

```bash
make setup                 # uv sync --frozen --offline for runtime dependencies
make setup-dev             # uv sync --frozen --offline --all-extras
uv add <package>           # deliberately update pyproject.toml and uv.lock
```

Do not use `uv pip install`, `uv pip sync`, bare `pip`, or global installs for
the project. A dependency change must update and review both `pyproject.toml`
and `uv.lock`; normal setup and verification consume the lock in frozen mode.

## Common Anti-Patterns

| Anti-Pattern                  | Why It's Bad                          | Solution                                 |
| ----------------------------- | ------------------------------------- | ---------------------------------------- |
| Mutable default args          | Shared across calls                   | `def f(items=None): items = items or []` |
| Bare `except:`                | Catches KeyboardInterrupt, SystemExit | `except SpecificError as e:`             |
| `== None`                     | Works by accident for falsy values    | `is None` / `is not None`                |
| Global mutable state          | Untestable, unpredictable             | Pure functions with explicit params      |
| String concatenation in loops | Quadratic time                        | `''.join(items)`                         |
| `from module import *`        | Pollutes namespace                    | Explicit imports                         |

## Docstrings

Document all public APIs with clear docstrings:

```python
def fetch_user(user_id: int) -> User | None:
    """Fetch a user by ID.

    Args:
        user_id: The unique user identifier.

    Returns:
        User object if found, None otherwise.

    Raises:
        DatabaseError: If the database connection fails.
    """
```

## Security Reminders

- Never hardcode secrets — load from environment variables
- Use parameterized queries to prevent SQL injection
- Validate all user input with Pydantic or manual checks
- Use `subprocess` module, never `os.system`
- For full security guidance, see the secure-coding documentation

## Further Reading

- [PEP 8 — Style Guide for Python Code](https://peps.python.org/pep-0008/)
- [Google Python Style Guide](https://google.github.io/styleguide/pyguide.html)
- [uv Documentation](https://docs.astral.sh/uv/)
- [Black Documentation](https://black.readthedocs.io/)
- [Flake8 Documentation](https://flake8.pycqa.org/)
- [mypy Documentation](https://mypy.readthedocs.io/)
- [pytest Documentation](https://docs.pytest.org/)
