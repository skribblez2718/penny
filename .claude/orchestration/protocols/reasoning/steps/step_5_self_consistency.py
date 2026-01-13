"""
step_5_self_consistency.py
==========================

Step 5 of the Mandatory Reasoning Protocol: Self-Consistency Verification

This step verifies the routing decision through multiple reasoning chains
and documents the confidence level.
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


class Step5SelfConsistency(BaseStep):
    """
    Step 5: Self-Consistency Verification

    Verifies the routing decision through multiple reasoning chains.
    """
    _step_num = 5
    _step_name = "SELF_CONSISTENCY"

# Allow running as script
if __name__ == "__main__":
    sys.exit(Step5SelfConsistency.main())
