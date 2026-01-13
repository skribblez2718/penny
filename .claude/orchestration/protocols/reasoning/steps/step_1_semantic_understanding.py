"""
step_1_semantic_understanding.py
================================

Step 1 of the Mandatory Reasoning Protocol: Semantic Understanding

This step interprets the semantic meaning behind the user's query,
identifies the task domain, and determines the appropriate approach.
"""

from __future__ import annotations

import sys
from pathlib import Path

# Path setup - add protocols directory for fully-qualified imports
# This prevents collision between reasoning/config and skill/config
_STEPS_DIR = Path(__file__).resolve().parent
_REASONING_ROOT = _STEPS_DIR.parent
_PROTOCOLS_DIR = _REASONING_ROOT.parent
if str(_PROTOCOLS_DIR) not in sys.path:
    sys.path.insert(0, str(_PROTOCOLS_DIR))

from reasoning.steps.base import BaseStep


class Step1SemanticUnderstanding(BaseStep):
    """
    Step 1: Semantic Understanding

    Interprets query intent, identifies task domain, and determines approach.
    """
    _step_num = 1
    _step_name = "SEMANTIC_UNDERSTANDING"

    def get_extra_context(self) -> str:
        """
        Step 1 has no previous step, so no extra context.
        """
        return ""


# Allow running as script
if __name__ == "__main__":
    sys.exit(Step1SemanticUnderstanding.main())
