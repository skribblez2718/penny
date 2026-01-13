"""
step_2_plan_sequence.py
=======================

Step 2 of Dynamic Skill Sequencing Protocol: Plan Skill Sequence

This step plans the order of orchestrate-* skill invocations based on
the cognitive functions identified in Step 1.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any, Dict

# Path setup - navigate to execution protocol root
_STEPS_DIR = Path(__file__).resolve().parent
_PROTOCOL_DIR = _STEPS_DIR.parent
_EXECUTION_ROOT = _PROTOCOL_DIR.parent
if str(_EXECUTION_ROOT) not in sys.path:
    sys.path.insert(0, str(_EXECUTION_ROOT))

from steps.base import BaseStep
from config.config import ProtocolType


class Step2PlanSequence(BaseStep):
    """
    Step 2: Plan Skill Sequence

    Determines the order of orchestrate-* skill invocations.
    """
    _step_num = 2
    _step_name = "PLAN_SEQUENCE"
    _protocol_type = ProtocolType.DYNAMIC_SKILL_SEQUENCING

    def process_step(self) -> Dict[str, Any]:
        """
        Process the sequence planning.

        The actual planning is done by the orchestrator when processing the step content.
        This method provides structure for capturing the output.
        """
        return {
            "sequence_pending": True,
            "instruction": "Capture skill sequence plan from the orchestrator's analysis"
        }


# Allow running as script
if __name__ == "__main__":
    sys.exit(Step2PlanSequence.main())
