"""
step_4_create_memory.py
=======================

Step 4 of Skill Orchestration: Create Memory File
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


class Step4CreateMemory(ExecutionBaseStep):
    """Step 4: Create Memory File"""
    _step_num = 4
    _step_name = "CREATE_MEMORY"
    _protocol_type = ProtocolType.SKILL_ORCHESTRATION

    def get_extra_context(self) -> str:
        """Include workflow definition from Step 3."""
        context_parts = []

        # Get Step 1 (task-id)
        step1 = self.state.get_step_output(1)
        if step1 and "orchestrator_response" in step1:
            context_parts.append("TASK ID (from Step 1):")
            context_parts.append(step1["orchestrator_response"][:200])
            context_parts.append("")

        # Get Step 2 (domain)
        step2 = self.state.get_step_output(2)
        if step2 and "orchestrator_response" in step2:
            context_parts.append("DOMAIN (from Step 2):")
            context_parts.append(step2["orchestrator_response"][:200])
            context_parts.append("")

        # Get Step 3 (workflow)
        step3 = self.state.get_step_output(3)
        if step3 and "orchestrator_response" in step3:
            context_parts.append("WORKFLOW (from Step 3):")
            context_parts.append(step3["orchestrator_response"][:400])

        return "\n".join(context_parts)


if __name__ == "__main__":
    sys.exit(Step4CreateMemory.main())
