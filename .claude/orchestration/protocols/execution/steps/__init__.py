"""
steps/__init__.py
=================

Execution protocol step components.
"""

import sys
from pathlib import Path

# Ensure parent is importable
_STEPS_DIR = Path(__file__).resolve().parent
_EXECUTION_ROOT = _STEPS_DIR.parent
if str(_EXECUTION_ROOT) not in sys.path:
    sys.path.insert(0, str(_EXECUTION_ROOT))

from steps.base import (
    ExecutionBaseStep,
    BaseStep,  # Backward compatibility alias
)

__all__ = [
    "ExecutionBaseStep",
    "BaseStep",
]
