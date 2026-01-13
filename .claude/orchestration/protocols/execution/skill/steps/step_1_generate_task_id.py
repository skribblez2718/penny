"""
step_1_generate_task_id.py
==========================

Step 1 of Skill Orchestration: Generate Task ID
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


class Step1GenerateTaskId(ExecutionBaseStep):
    """Step 1: Generate Task ID"""
    _step_num = 1
    _step_name = "GENERATE_TASK_ID"
    _protocol_type = ProtocolType.SKILL_ORCHESTRATION


if __name__ == "__main__":
    sys.exit(Step1GenerateTaskId.main())
