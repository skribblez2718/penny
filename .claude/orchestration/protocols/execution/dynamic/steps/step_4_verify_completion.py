"""
step_4_verify_completion.py
===========================

Step 4 of Dynamic Skill Sequencing Protocol: Verify Completion

This step verifies that all cognitive functions completed successfully.
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


class Step4VerifyCompletion(BaseStep):
    """
    Step 4: Verify Completion

    Ensures all cognitive functions completed successfully by checking
    that memory files were created for each invoked skill.
    """
    _step_num = 4
    _step_name = "VERIFY_COMPLETION"
    _protocol_type = ProtocolType.DYNAMIC_SKILL_SEQUENCING

    def process_step(self) -> Dict[str, Any]:
        """
        Process the completion verification.

        Claude should verify that memory files were created for each
        skill that was invoked in Step 3.
        """
        return {
            "verification_required": True,
            "checks": [
                "Each skill invoked in Step 3 created a memory file",
                "Memory files contain non-empty output",
                "No critical errors occurred during skill execution"
            ],
            "instruction": "Verify all skills completed by checking memory files exist"
        }


# Allow running as script
if __name__ == "__main__":
    sys.exit(Step4VerifyCompletion.main())
