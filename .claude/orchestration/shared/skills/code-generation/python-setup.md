# Python Project Setup (MANDATORY)

**Importance:** ALL Python projects MUST follow these requirements without exception.

---

## Package Management

### Rules

| Rule | Status |
|------|--------|
| Use `uv` for all dependency management | **MUST** |
| Use `pip` directly for package installation | **NEVER** |
| Install packages globally | **NEVER** |
| Manage dependencies via `uv add <package>` | **MUST** |

---

## Import Rules (CRITICAL)

### Absolute Imports ONLY

| Rule | Status |
|------|--------|
| Use absolute imports | **ALWAYS** |
| Use relative imports | **NEVER** |

**WRONG:**
```python
from .utils import helper
from ..models import User
from . import config
```

**CORRECT:**
```python
from mypackage.utils import helper
from mypackage.models import User
from mypackage import config
```

**Reason:** Absolute imports are explicit, unambiguous, and work consistently regardless of how the module is executed.

### Why Absolute Imports (Detailed)

1. **Clarity**: Import path is unambiguous regardless of file location
2. **Refactoring Safety**: Moving files doesn't break imports
3. **Testing Compatibility**: pytest and other test runners work consistently
4. **IDE Support**: Better autocomplete and navigation
5. **Circular Dependency Detection**: Easier to spot and fix
6. **Execution Context Independence**: Works from any entry point

### Examples by Project Type

**MCP Servers (src/ as root):**
```python
# CORRECT
from src.config import Config
from src.tools.factory import ToolFactory
from src.services.client import APIClient

# WRONG
from .config import Config
from ..services.client import APIClient
```

**CLI Tools (package_name/ as root):**
```python
# CORRECT
from myapp.cli import main
from myapp.commands.deploy import DeployCommand
from myapp.utils.logger import get_logger

# WRONG
from .cli import main
from ..utils.logger import get_logger
```

**Libraries (package_name/ as root):**
```python
# CORRECT
from mylib.core.engine import Engine
from mylib.utils.helpers import format_data

# WRONG
from .core.engine import Engine
from ..utils.helpers import format_data
```

### Validation Requirements

**For Generation Agents:**
1. Write all imports using absolute paths from package root
2. Never use relative import syntax (`.` or `..`)
3. Document package root in module docstrings if ambiguous

**For Validation Agents:**
1. Scan all .py files for relative imports using pattern: `from \.|from \.\.`
2. BLOCK validation if any relative imports found
3. Report each file and line number with relative imports
4. Require remediation before workflow completion

**Automated Check:**
```bash
# Check for relative imports (should return nothing)
grep -r "^from \.\|^from \.\." --include="*.py" src/

# If output exists, relative imports present - FAIL validation
```

---

## Virtual Environment

### Rules

| Rule | Status |
|------|--------|
| Create venv using `uv venv` in project root | **MUST** |
| Virtual environment directory: `.venv/` | **MUST** |
| `.venv/` must be git-ignored | **MUST** |
| Run tests via `uv run pytest` | **MUST** |
| Run code via `uv run python` | **MUST** |
| Virtual environment is project-local, not global | **MUST** |

---

## Project Structure

### Required Files

```
project/
├── .venv/                      # MANDATORY - Virtual environment (uv venv)
├── .gitignore                  # REQUIRED - Must include .venv/
├── pyproject.toml              # MANDATORY - Project metadata and dependencies
├── uv.lock                     # AUTO-GENERATED - Locked dependencies
├── src/
│   └── [package]/
│       ├── __init__.py
│       └── [modules].py
├── tests/
│   ├── __init__.py
│   └── test_[modules].py
└── README.md                   # Setup and usage instructions
```

---

## Mandatory Setup Sequence

### Step 1: Initialize Python project

```bash
uv init
```

### Step 2: Create virtual environment

```bash
uv venv
```

### Step 3: Add dependencies (NEVER use pip install)

```bash
uv add <package-name>
```

### Step 4: Add dev dependencies

```bash
uv add --dev pytest black ruff mypy
```

### Step 5: Run tests using venv

```bash
uv run pytest
```

### Step 6: Execute code using venv

```bash
uv run python -m <module>
# or
uv run python script.py
```

---

## Workflow Commands

| Action | Command |
|--------|---------|
| Sync dependencies | `uv sync` |
| Add dependency | `uv add requests numpy pandas` |
| Add dev dependency | `uv add --dev pytest black ruff mypy` |
| Run tests | `uv run pytest` |
| Run specific test | `uv run pytest tests/test_specific.py` |
| Run module | `uv run python -m mypackage` |
| Run script | `uv run python scripts/my_script.py` |
| Format code | `uv run black src/` |
| Lint code | `uv run ruff check src/` |
| Type check | `uv run mypy src/` |

---

## Critical Violations to Prevent

### WRONG

```bash
pip install requests           # Using pip directly
python -m pip install numpy    # Using pip via python
sudo pip install package       # Global installation
pip install --user package     # User-level installation
python script.py               # Running without venv
pytest                         # Testing without venv
source .venv/bin/activate      # Manual activation
```

### CORRECT

```bash
uv add requests                # Using uv for packages
uv add numpy                   # Using uv for packages
uv add package                 # Project-local installation
uv run python script.py        # Running with venv
uv run pytest                  # Testing with venv
```

---

## Validation Checklist

Before completing any Python project, verify:

- [ ] `.venv/` directory exists in project root
- [ ] `pyproject.toml` exists with all dependencies listed
- [ ] `uv.lock` exists (auto-generated)
- [ ] `.gitignore` includes `.venv/`
- [ ] All `pip install` commands converted to `uv add`
- [ ] All test commands use `uv run pytest`
- [ ] All execution commands use `uv run python`
- [ ] NO global package installations anywhere
- [ ] Virtual environment created with `uv venv`, not `python -m venv`
- [ ] ALL imports are absolute (no relative imports)

---

## pyproject.toml Template

```toml
[project]
name = "myproject"
version = "0.1.0"
description = "Project description"
readme = "README.md"
requires-python = ">=3.10"
dependencies = [
    # Add runtime dependencies here
]

[project.optional-dependencies]
dev = [
    "pytest>=8.0",
    "black>=24.0",
    "ruff>=0.4",
    "mypy>=1.10",
]

[tool.pytest.ini_options]
testpaths = ["tests"]
python_files = ["test_*.py"]

[tool.black]
line-length = 88
target-version = ['py310']

[tool.ruff]
line-length = 88
target-version = "py310"

[tool.mypy]
python_version = "3.10"
strict = true
```
