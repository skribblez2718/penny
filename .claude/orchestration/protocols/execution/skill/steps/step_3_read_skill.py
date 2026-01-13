"""
step_3_read_skill.py
====================

Step 3 of Skill Orchestration: Read Skill Definition
"""

from __future__ import annotations

import sys
from pathlib import Path

# Path setup - navigate to execution protocol root
_STEPS_DIR = Path(__file__).resolve().parent
_PROTOCOL_DIR = _STEPS_DIR.parent
_EXECUTION_ROOT = _PROTOCOL_DIR.parent
if str(_EXECUTION_ROOT) not in sys.path:
    sys.path.insert(0, str(_EXECUTION_ROOT))

from steps.base import ExecutionBaseStep
from config.config import ProtocolType


class Step3ReadSkill(ExecutionBaseStep):
    """Step 3: Read Skill Definition"""
    _step_num = 3
    _step_name = "READ_SKILL"
    _protocol_type = ProtocolType.SKILL_ORCHESTRATION

    def get_extra_context(self) -> str:
        """Include domain classification from Step 2."""
        prev = self.get_previous_output()
        if prev and "orchestrator_response" in prev:
            return f"FROM STEP 2 (Domain Classification):\n{prev['orchestrator_response'][:500]}"
        return ""


if __name__ == "__main__":
    sys.exit(Step3ReadSkill.main())
