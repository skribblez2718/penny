"""
Shared Step Implementations - SINGLE SOURCE OF TRUTH.

These implementations are used by ALL 7 agents. This file replaces 14 separate
step_0_learning_injection.py and step_1_johari_discovery.py files across agents.

ZERO REDUNDANCY: Changes to step 0 or step 1 behavior are made HERE, not in
7 different files.

Usage (when called directly):
    python3 shared.py --step 0 --state <state_file>
    python3 shared.py --step 1 --state <state_file>

Usage (when imported):
    from steps.shared import LearningInjectionStep, JohariDiscoveryStep
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Any

# Path setup for fully-qualified imports
_STEPS_DIR = Path(__file__).resolve().parent
_AGENT_PROTOCOLS_DIR = _STEPS_DIR.parent
_PROTOCOLS_DIR = _AGENT_PROTOCOLS_DIR.parent
if str(_PROTOCOLS_DIR) not in sys.path:
    sys.path.insert(0, str(_PROTOCOLS_DIR))

from agent.steps.base import BaseAgentStep, AgentExecutionState


class LearningInjectionStep(BaseAgentStep):
    """
    Step 0: Learning Injection - shared across ALL 7 agents.

    Loads domain-specific learnings before performing task.
    The actual learning loading is performed by Claude based on
    the instructions in the content file.
    """

    # Class attribute - eliminates the need for @property def step_num
    _step_num_value = 0

    @property
    def step_num(self) -> int:
        """Return step number 0."""
        return self._step_num_value

    def execute(self) -> dict[str, Any]:
        """
        Execute learning injection.

        Returns instruction for Claude to load learnings for this agent's domain.
        """
        domain = self._get_agent_domain()
        return {
            "action": "learning_injection_initiated",
            "instruction": f"Load INDEX from {domain} learnings files if they exist",
        }

    def _get_agent_domain(self) -> str:
        """
        Extract domain from agent name.

        Examples:
            research-agent -> research
            clarification-agent -> clarification
            analysis-agent -> analysis
        """
        return self.state.agent_name.replace("-agent", "")


class JohariDiscoveryStep(BaseAgentStep):
    """
    Step 1: Johari Window Discovery - shared across ALL 7 agents.

    Transforms unknown unknowns into known knowns using the
    SHARE/ASK/ACKNOWLEDGE/EXPLORE framework.

    CRITICAL: If ANY clarifying questions exist after this step,
    the agent MUST HALT and ask before proceeding to Step 2.
    """

    # Class attribute - eliminates the need for @property def step_num
    _step_num_value = 1

    @property
    def step_num(self) -> int:
        """Return step number 1."""
        return self._step_num_value

    def execute(self) -> dict[str, Any]:
        """
        Execute Johari Window Discovery.

        Claude will execute the SHARE/ASK/ACKNOWLEDGE/EXPLORE framework
        to transform unknown unknowns into known knowns before proceeding.

        CRITICAL: If ANY clarifying questions exist, HALT and ask before Step 2.
        """
        return {
            "action": "johari_discovery_initiated",
            "instruction": "Execute SHARE/ASK/ACKNOWLEDGE/EXPLORE framework",
            "critical_rule": "If clarifying questions exist, HALT and ask before proceeding",
        }


# Registry for dynamic lookup by step number
SHARED_AGENT_STEPS = {
    0: LearningInjectionStep,
    1: JohariDiscoveryStep,
}


def main() -> int:
    """
    CLI entry point for shared steps.

    Allows running shared steps directly:
        python3 shared.py --step 0 --state <state_file>
        python3 shared.py --step 1 --state <state_file>

    Returns:
        Exit code (0 for success, 1 for failure)
    """
    parser = argparse.ArgumentParser(
        description="Shared agent steps (Learning Injection and Johari Discovery)"
    )
    parser.add_argument(
        "--step",
        required=True,
        type=int,
        choices=[0, 1],
        help="Step number to execute (0: Learning Injection, 1: Johari Discovery)",
    )
    parser.add_argument(
        "--state",
        required=True,
        help="Path to the agent execution state file",
    )
    args = parser.parse_args()

    state_file = Path(args.state)
    state = AgentExecutionState.load(state_file)

    if not state:
        print(f"ERROR: Could not load state from {state_file}", file=sys.stderr)
        return 1

    step_class = SHARED_AGENT_STEPS.get(args.step)
    if not step_class:
        print(f"ERROR: Unknown step number: {args.step}", file=sys.stderr)
        return 1

    try:
        step_class(state).run()
        return 0
    except Exception as e:
        print(f"ERROR: Step execution failed: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
