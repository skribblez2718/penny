"""
steps package
=============

Individual step scripts for the Mandatory Reasoning Protocol.

Each step script:
1. Loads state from the provided state file
2. Reads its markdown content from content/steps/
3. Prints the step instructions to stdout (becomes AI context)
4. Updates state with step completion
5. Prints directive for next step

The base module provides the abstract base class that
all step scripts inherit from.
"""

from pathlib import Path
import sys

# Add parent directory (protocols/reasoning/) to path for imports
# This allows `from steps.base import BaseStep` to work
_STEPS_DIR = Path(__file__).resolve().parent
_REASONING_ROOT = _STEPS_DIR.parent
if str(_REASONING_ROOT) not in sys.path:
    sys.path.insert(0, str(_REASONING_ROOT))

from steps.base import BaseStep

__all__ = ["BaseStep"]
