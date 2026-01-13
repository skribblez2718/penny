"""
step_3_tree_of_thought.py
=========================

Step 3 of the Mandatory Reasoning Protocol: Tree of Thought Exploration

This step generates 2-3 alternative solution approaches,
evaluates their viability, and selects the optimal path.

After Step 3 completes, directs to Step 3b (Skill Detection) before Step 4.
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
from reasoning.config.config import STEPS_DIR, format_mandatory_directive


class Step3TreeOfThought(BaseStep):
    """
    Step 3: Tree of Thought Exploration

    Explores multiple solution approaches before committing.
    After completion, directs to Step 3b (Skill Detection).
    """
    _step_num = 3
    _step_name = "TREE_OF_THOUGHT"

    def print_next_directive(self) -> None:
        """
        Override to direct to Step 3b (Skill Detection) instead of Step 4.

        Step 3b performs semantic skill matching to detect applicable skills
        before the routing decision in Step 4.
        """
        step_3b_script = STEPS_DIR / "step_3b_skill_detection.py"

        directive = format_mandatory_directive(
            f"python3 {step_3b_script} --state {self.state.state_file_path}",
            "Step 3 complete. Execute Step 3b (Skill Detection) before routing. "
        )
        print(directive)


# Allow running as script
if __name__ == "__main__":
    sys.exit(Step3TreeOfThought.main())
