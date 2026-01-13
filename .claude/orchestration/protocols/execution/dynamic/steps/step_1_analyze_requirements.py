"""
step_1_analyze_requirements.py
==============================

Step 1 of Dynamic Skill Sequencing Protocol: Analyze Task Requirements

This step analyzes the user's request to determine which cognitive functions
are needed and in what order they should be invoked.
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


class Step1AnalyzeRequirements(BaseStep):
    """
    Step 1: Analyze Task Requirements

    Determines which cognitive functions this task needs.
    """
    _step_num = 1
    _step_name = "ANALYZE_REQUIREMENTS"
    _protocol_type = ProtocolType.DYNAMIC_SKILL_SEQUENCING

    def process_step(self) -> Dict[str, Any]:
        """
        Process the requirements analysis.

        The actual analysis is done by the orchestrator when processing the step content.
        This method provides structure for capturing the output.
        """
        return {
            "analysis_pending": True,
            "instruction": "Capture cognitive function requirements from the orchestrator's analysis"
        }


# Allow running as script
if __name__ == "__main__":
    sys.exit(Step1AnalyzeRequirements.main())
