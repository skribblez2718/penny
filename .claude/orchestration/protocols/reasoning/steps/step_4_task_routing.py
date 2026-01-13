"""
step_4_task_routing.py
======================

Step 4 of the Mandatory Reasoning Protocol: Task Routing Decision

This is the CRITICAL step that determines how the task will be executed.
It applies pre-checks and makes the preliminary routing decision.

This step can be entered in two ways:
1. Normal flow: From Step 3b (Skill Detection)
2. Loop-back: From Step 8 (Knowledge Transfer) when contradiction detected

When entered via loop-back, the iteration count is incremented and
previous routing decisions are available for comparison.

Note: Agent mode sessions skip Step 4 entirely and proceed from Step 3b
directly to Step 5 (Self-Consistency).
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Dict, Any

# Path setup - add protocols directory for fully-qualified imports
# This prevents collision between reasoning/config and skill/config
_STEPS_DIR = Path(__file__).resolve().parent
_REASONING_ROOT = _STEPS_DIR.parent
_PROTOCOLS_DIR = _REASONING_ROOT.parent
if str(_PROTOCOLS_DIR) not in sys.path:
    sys.path.insert(0, str(_PROTOCOLS_DIR))

from reasoning.steps.base import BaseStep
from reasoning.core.semantic_routing import generate_routing_prompt_from_state


class Step4TaskRouting(BaseStep):
    """
    Step 4: Task Routing Decision

    Makes the preliminary routing decision based on SEMANTIC understanding
    and tree of thought exploration.

    This step can be entered via:
    - Normal flow from Step 3b (Skill Detection)
    - Loop-back from Step 8 (contradiction detected)

    When loop-back occurs, previous routing attempts are shown for context.

    Routing is PURELY SEMANTIC - no keyword matching or confidence thresholds.
    The orchestrator decides based on understanding of DA.md patterns.

    Note: Agent mode sessions skip this step - they go from Step 3b directly
    to Step 5 (Self-Consistency).
    """

    _step_num = 4
    _step_name = "TASK_ROUTING"

    def __init__(self, state, is_loop_back: bool = False):
        """
        Initialize the step.

        Args:
            state: The protocol state
            is_loop_back: True if entering via loop-back from Step 8
        """
        super().__init__(state)
        self.is_loop_back = is_loop_back

    def get_extra_context(self) -> str:
        """
        Generate semantic routing prompt for the orchestrator to make the routing decision.

        PURELY SEMANTIC routing - no keyword matching or confidence thresholds.
        The orchestrator decides based on understanding of DA.md patterns.
        """
        context_parts = []

        # Show loop-back context if re-evaluating
        if self.is_loop_back and self.state.preliminary_routes:
            context_parts.append(f"**Loop-back iteration {self.state.iteration_count + 1}**")
            context_parts.append("Previous routing attempts:")
            for pr in self.state.preliminary_routes:
                if pr.get("route"):
                    context_parts.append(f"  - {pr['route']}: {pr.get('justification', 'no reason')}")
            context_parts.append("")

        # Generate the semantic routing prompt
        semantic_prompt = generate_routing_prompt_from_state(self.state)
        context_parts.append(semantic_prompt)

        return "\n".join(context_parts)

    def process_step(self) -> Dict[str, Any]:
        """
        Process the routing decision.

        Note: The actual routing decision is made by the orchestrator when
        processing the step content. This method provides structure
        for capturing the decision.
        """
        return {
            "routing_decision_pending": True,
            "iteration": self.state.iteration_count,
            "is_loop_back": self.is_loop_back,
            "instruction": "Capture routing decision from the orchestrator's response"
        }

    def execute(self) -> bool:
        """
        Execute this step.

        Handles two entry modes:
        1. Normal flow from Step 3b (Skill Detection) - needs FSM transition
        2. Loop-back from Step 8 - needs FSM transition from KNOWLEDGE_TRANSFER
        """
        from reasoning.core.fsm import ReasoningState
        from datetime import datetime, timezone

        if self.is_loop_back:
            # Transition FSM from KNOWLEDGE_TRANSFER back to TASK_ROUTING
            if self.state.fsm.state != ReasoningState.KNOWLEDGE_TRANSFER:
                print(f"ERROR: Loop-back requires state KNOWLEDGE_TRANSFER, "
                      f"got {self.state.fsm.state.name}", file=sys.stderr)
                return False

            if not self.state.fsm.transition(ReasoningState.TASK_ROUTING):
                print("ERROR: FSM transition failed for loop-back", file=sys.stderr)
                return False

            # Trigger loop-back records the iteration increment
            if not self.state.trigger_loop_back("Contradiction detected at Step 8"):
                print("ERROR: Max iterations reached, cannot loop back", file=sys.stderr)
                return False

            # Print extra context and content (skip normal start_step)
            self.print_extra_context()
            self.print_content()

            # Process and complete
            output = self.process_step()
            self.state.step_outputs[self.step_number] = output
            self.state.save()

            # Print next directive
            self.print_next_directive()
            return True

        # Check if FSM is already in TASK_ROUTING (e.g., after plan approval)
        if self.state.fsm.state == ReasoningState.TASK_ROUTING:
            # Already in correct state - just record timestamps and proceed
            self.state.step_timestamps[self.step_number] = {
                "started_at": datetime.now(timezone.utc).isoformat(),
                "completed_at": None,
            }

            # Print output (becomes Claude's context)
            self.print_extra_context()
            self.print_content()

            # Process the step
            output = self.process_step()

            # Complete the step
            self.state.step_outputs[self.step_number] = output
            if self.step_number in self.state.step_timestamps:
                self.state.step_timestamps[self.step_number]["completed_at"] = (
                    datetime.now(timezone.utc).isoformat()
                )

            # Save state
            self.state.save()

            # Print directive for next step
            self.print_next_directive()
            return True
        else:
            # Normal flow uses parent execute
            return super().execute()

    @classmethod
    def main(cls) -> int:
        """
        Main entry point for step 4 script.

        Parses arguments including --loop-back flag.

        Returns:
            Exit code (0 for success, 1 for error)
        """
        import argparse
        from pathlib import Path
        from reasoning.core.state import ProtocolState

        parser = argparse.ArgumentParser(
            description="Execute Step 4: Task Routing Decision",
        )
        parser.add_argument(
            "--state",
            required=True,
            help="Path to the state file"
        )
        parser.add_argument(
            "--loop-back",
            action="store_true",
            help="Indicate this is a loop-back from Step 8"
        )

        args = parser.parse_args()

        # Load state
        state_path = Path(args.state)
        if not state_path.exists():
            print(f"ERROR: State file not found: {args.state}", file=sys.stderr)
            return 1

        # Extract session ID from filename
        session_id = state_path.stem.replace("reasoning-", "")

        state = ProtocolState.load(session_id)
        if not state:
            print(f"ERROR: Could not load state from {args.state}", file=sys.stderr)
            return 1

        # Create and execute step
        is_loop_back = getattr(args, 'loop_back', False)
        step = cls(state, is_loop_back=is_loop_back)
        if not step.execute():
            return 1

        return 0


# Allow running as script
if __name__ == "__main__":
    sys.exit(Step4TaskRouting.main())
