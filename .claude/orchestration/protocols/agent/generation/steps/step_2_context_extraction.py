from __future__ import annotations
import sys
from pathlib import Path
from typing import Any
sys.path.insert(0, str(Path(__file__).parent.parent.parent))
from steps.base import BaseAgentStep, AgentExecutionState

class Step(BaseAgentStep):
    _step_num = 2
    def execute(self) -> dict[str, Any]: return {"action": "context_extraction"}

if __name__ == "__main__":
    Step.main()
