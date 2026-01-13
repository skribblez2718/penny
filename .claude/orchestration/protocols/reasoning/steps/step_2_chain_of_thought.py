"""
step_2_chain_of_thought.py
==========================

Step 2 of the Mandatory Reasoning Protocol: Chain of Thought Decomposition

This step breaks down the problem into explicit logical steps,
showing internal work and connecting steps to conclusions.
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


class Step2ChainOfThought(BaseStep):
    """
    Step 2: Chain of Thought Decomposition

    Decomposes the problem into logical steps with transparent reasoning.
    """
    _step_num = 2
    _step_name = "CHAIN_OF_THOUGHT"

# Allow running as script
if __name__ == "__main__":
    sys.exit(Step2ChainOfThought.main())
