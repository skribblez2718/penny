"""
step_2_classify_domain.py
=========================

Step 2 of Skill Orchestration: Classify Task Domain
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


class Step2ClassifyDomain(ExecutionBaseStep):
    """Step 2: Classify Domain"""
    _step_num = 2
    _step_name = "CLASSIFY_DOMAIN"
    _protocol_type = ProtocolType.SKILL_ORCHESTRATION

    def get_extra_context(self) -> str:
        """Include task-id from Step 1."""
        prev = self.get_previous_output()
        if prev and "orchestrator_response" in prev:
            return f"FROM STEP 1:\n{prev['orchestrator_response'][:500]}"
        return ""


if __name__ == "__main__":
    sys.exit(Step2ClassifyDomain.main())
