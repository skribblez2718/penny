"""
step_8_knowledge_transfer.py
============================

Step 8 of the Mandatory Reasoning Protocol: Knowledge Transfer Checkpoint

This is the FINAL step with THREE-WAY CONDITIONAL logic:
- If contradiction detected → LOOP BACK to Step 4 (max 3 iterations)
- If ambiguity exists → HALT for clarification
- If all clear → PROCEED to execution

This step:
1. Validates the routing decision from Step 4 based on Steps 5-7 analysis
2. Implements the SHARE/PROBE/MAP/DELIVER framework for clarification
3. Triggers loop-back to Step 4 if contradiction detected
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


class Step8KnowledgeTransfer(BaseStep):
    """
    Step 8: Knowledge Transfer Checkpoint

    Final check before execution with THREE-WAY conditional logic:
    - LOOP BACK: Contradiction detected, re-evaluate routing
    - HALT: Ambiguity exists, request clarification
    - PROCEED: All clear, execute with validated routing
    """
    _step_num = 8
    _step_name = "KNOWLEDGE_TRANSFER"

    def get_iteration_info(self) -> tuple:
        """
        Get current iteration information for display.

        Returns:
            Tuple of (current_iteration, max_iterations, preliminary_route)
        """
        from reasoning.core.fsm import ReasoningFSM

        iteration = self.state.iteration_count + 1  # 1-indexed for display
        max_iter = ReasoningFSM.MAX_ITERATIONS
        route = self.state.get_current_preliminary_route() or "NOT SET"
        return iteration, max_iter, route

    def get_extra_context(self) -> str:
        """
        Display iteration context only - prior step content is in conversation context.
        """
        iteration, max_iter, route = self.get_iteration_info()
        return f"ROUTING VALIDATION ITERATION: {iteration} of {max_iter}\nPRELIMINARY ROUTE: {route}\n"

    def format_content(self, content: str) -> str:
        """
        Override to inject iteration placeholders into markdown content.
        """
        iteration, max_iter, route = self.get_iteration_info()
        content = content.replace("{iteration}", f"{iteration} of {max_iter}")
        content = content.replace("{preliminary_route}", route)
        return content

    def print_next_directive(self) -> None:
        """
        Override to add THREE-WAY conditional logic.

        Step 8 has three possible outcomes:
        1. LOOP BACK to Step 4 (if contradiction detected, max 3 iterations)
        2. HALT for clarification (if ambiguity detected)
        3. PROCEED to execution (if all clear)
        """
        from reasoning.config.config import ORCHESTRATION_ROOT

        iteration, max_iter, route = self.get_iteration_info()
        can_loop = self.state.can_loop_back()

        # Output essential commands only
        step4_script = ORCHESTRATION_ROOT / "protocols/reasoning" / "steps" / "step_4_task_routing.py"
        set_route_script = ORCHESTRATION_ROOT / "protocols/reasoning" / "set_route.py"

        if can_loop:
            print(f"**LOOP BACK (contradiction):** `python {step4_script} --state {self.state.state_file_path} --loop-back`")
        else:
            print(f"Max iterations ({max_iter}) reached - cannot loop back")

        # Output exact command - DO NOT modify or add arguments
        # set_route.py only accepts: --state, --route, --reason (optional)
        print(f"**PROCEED (validated):** `python {set_route_script} --state {self.state.state_file_path} --route {route} --reason \"Routing validated through Steps 5-7\"`")


# Allow running as script
if __name__ == "__main__":
    sys.exit(Step8KnowledgeTransfer.main())
