"""
step_7_constitutional_critique.py
=================================

Step 7 of the Mandatory Reasoning Protocol: Constitutional Self-Critique

This step applies principled revision before execution,
critiquing against accuracy, completeness, clarity, and efficiency.
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


class Step7ConstitutionalCritique(BaseStep):
    """
    Step 7: Constitutional Self-Critique

    Applies principled revision against core principles.
    """
    _step_num = 7
    _step_name = "CONSTITUTIONAL_CRITIQUE"

# Allow running as script
if __name__ == "__main__":
    sys.exit(Step7ConstitutionalCritique.main())
