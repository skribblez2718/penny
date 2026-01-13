"""
step_6_complete_workflow.py
===========================

Step 6 of Skill Orchestration: Complete Workflow
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


class Step6CompleteWorkflow(ExecutionBaseStep):
    """Step 6: Complete Workflow"""
    _step_num = 6
    _step_name = "COMPLETE_WORKFLOW"
    _protocol_type = ProtocolType.SKILL_ORCHESTRATION

    def get_extra_context(self) -> str:
        """Include agent execution summary from Step 5."""
        context_parts = []

        # Get task-id
        step1 = self.state.get_step_output(1)
        if step1 and "orchestrator_response" in step1:
            context_parts.append("TASK ID:")
            context_parts.append(step1["orchestrator_response"][:100])
            context_parts.append("")

        # Get agent execution summary
        step5 = self.state.get_step_output(5)
        if step5 and "orchestrator_response" in step5:
            context_parts.append("AGENT EXECUTION SUMMARY (from Step 5):")
            context_parts.append(step5["orchestrator_response"][:600])

        return "\n".join(context_parts)


if __name__ == "__main__":
    sys.exit(Step6CompleteWorkflow.main())
