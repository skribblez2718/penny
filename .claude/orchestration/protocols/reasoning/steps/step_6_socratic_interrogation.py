"""
step_6_socratic_interrogation.py
================================

Step 6 of the Mandatory Reasoning Protocol: Socratic Self-Interrogation

This step challenges the approach through systematic questioning,
examining assumptions, evidence, and blind spots.
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


class Step6SocraticInterrogation(BaseStep):
    """
    Step 6: Socratic Self-Interrogation

    Challenges the approach through systematic questioning.
    """
    _step_num = 6
    _step_name = "SOCRATIC_INTERROGATION"

# Allow running as script
if __name__ == "__main__":
    sys.exit(Step6SocraticInterrogation.main())
