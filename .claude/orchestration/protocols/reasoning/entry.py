"""
entry.py
========

Unified entry point for the Mandatory Reasoning Protocol.

This script supports both Main (full 8-step) and Agent (7-step, skips Step 4) modes:

Main Mode (default):
  All 8 steps including Step 4 (Task Routing)

Agent Mode (--agent-mode):
  Steps 1, 2, 3, 5, 6, 7, 8 (skips Step 4 since agents are already routed)

Usage:
    python entry.py "user query here"
    python entry.py "agent task" --agent-mode

The stdout from this script becomes part of Claude's context,
instructing it to proceed with the reasoning protocol.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

# Path setup - add protocols directory for fully-qualified imports
# This prevents collision between reasoning/config and skill/config
_REASONING_ROOT = Path(__file__).resolve().parent
_PROTOCOLS_DIR = _REASONING_ROOT.parent
if str(_PROTOCOLS_DIR) not in sys.path:
    sys.path.insert(0, str(_PROTOCOLS_DIR))

from reasoning.config.config import (
    ORCHESTRATION_ROOT,
    STEPS_DIR,
    PROTOCOL_NAME,
    PROTOCOL_VERSION,
    STEP_NAMES,
    STEP_TITLES,
    ensure_directories,
    format_mandatory_directive,
)
from reasoning.core.state import ProtocolState


# Agent mode step sequence (skips Step 4 - Task Routing)
AGENT_STEP_SEQUENCE = [0, 1, 2, 3, 5, 6, 7, 8]


def print_protocol_preamble(state: ProtocolState, is_agent_mode: bool = False) -> None:
    """
    Print the protocol preamble to stdout.

    This becomes part of Claude's context, establishing the
    deterministic execution framework.

    Args:
        state: The protocol state
        is_agent_mode: True if running in agent mode
    """
    if is_agent_mode:
        print(f"Agent Task: {state.user_query}", flush=True)
        print("\n[AGENT REASONING MODE: Step 4 (Task Routing) will be skipped - agent already routed]", flush=True)
    else:
        # Query context only - protocol rules are in step markdown files
        print(f"Query: {state.user_query}", flush=True)


def print_step_directive(state: ProtocolState, step_num: int = 1, is_agent_mode: bool = False) -> None:
    """
    Print the directive to execute a specific step.

    This is the key mechanism: printing the command that Claude
    should execute to proceed with the protocol.

    Args:
        state: The protocol state
        step_num: The step number to execute
        is_agent_mode: True if running in agent mode
    """
    step_name = STEP_NAMES.get(step_num, "unknown").lower()
    script_path = STEPS_DIR / f"step_{step_num}_{step_name}.py"
    state_file = state.state_file_path

    if is_agent_mode:
        # Note the agent context in the directive
        sequence = AGENT_STEP_SEQUENCE
        step_position = sequence.index(step_num) + 1 if step_num in sequence else step_num
        total_agent_steps = len(sequence)

        directive = format_mandatory_directive(
            f"python3 {script_path} --state {state_file}",
            f"Agent reasoning step {step_position} of {total_agent_steps}. Step 4 (routing) is skipped for agents. "
        )
    else:
        # Step 0 has special wording, Steps 1-8 use standard wording
        if step_num == 0:
            step_context = "This is Step 0 (Johari Discovery). Execute at START of every interaction. "
        else:
            step_context = f"This is Step {step_num} of 8. Each step's output feeds into the next. "
        directive = format_mandatory_directive(
            f"python3 {script_path} --state {state_file}",
            step_context
        )
    print(directive, flush=True)


def init_protocol(user_query: str, is_agent_mode: bool = False) -> ProtocolState:
    """
    Initialize a new protocol session.

    Args:
        user_query: The user's original query
        is_agent_mode: If True, run in agent mode (skip Step 4)

    Returns:
        Initialized ProtocolState
    """
    ensure_directories()

    state = ProtocolState(user_query=user_query)

    # Set agent mode metadata
    if is_agent_mode:
        state.metadata["is_agent_session"] = True
        state.metadata["skip_step_4"] = True
        state.metadata["step_sequence"] = AGENT_STEP_SEQUENCE

    state.save()

    return state


def main() -> int:
    """
    Main entry point for the protocol.

    Returns:
        Exit code (0 for success, 1 for error)
    """
    parser = argparse.ArgumentParser(
        description="Initiate the Mandatory Reasoning Protocol",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Main mode (full 8-step protocol)
  python entry.py "How do I implement authentication?"

  # Agent mode (skips Step 4 - task routing)
  python entry.py "Clarify OAuth2 requirements" --agent-mode
        """
    )

    parser.add_argument(
        "query",
        nargs="?",
        help="The user query to process through the protocol"
    )
    parser.add_argument(
        "--agent-mode",
        action="store_true",
        help="Run in agent mode (skips Step 4 - task routing). Use for cognitive agents."
    )

    args = parser.parse_args()

    # Require query for new session
    if not args.query:
        parser.print_help()
        print("\nERROR: Query required for new session", file=sys.stderr)
        return 1

    # Initialize new protocol
    state = init_protocol(
        args.query,
        is_agent_mode=args.agent_mode
    )

    # Print preamble and first step directive (Step 0 - Johari Discovery)
    print_protocol_preamble(state, is_agent_mode=args.agent_mode)
    print_step_directive(state, 0, is_agent_mode=args.agent_mode)
    sys.stdout.flush()  # Ensure all output is flushed before returning

    return 0


if __name__ == "__main__":
    sys.exit(main())
