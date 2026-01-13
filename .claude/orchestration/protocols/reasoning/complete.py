"""
complete.py
===========

Protocol completion handler for the Mandatory Reasoning Protocol.

This script finalizes the protocol execution:
1. Verifies all 8 steps completed successfully
2. Extracts the routing decision from Step 4
3. Outputs final summary and next actions
4. Transitions FSM to COMPLETED state

Usage:
    python complete.py --state <state_file>

Called automatically after Step 8 completes (if no HALT).
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
    PROTOCOL_VERSION,
    TOTAL_STEPS,
    STEP_TITLES,
    format_mandatory_directive,
)
from reasoning.core.state import ProtocolState
from reasoning.core.fsm import ReasoningState
from reasoning.core.universal_learnings import check_and_prompt_learnings


def verify_all_steps_completed(state: ProtocolState) -> tuple[bool, list[int]]:
    """
    Verify that steps 1-8 have completed outputs.

    Note: Step 0 (Johari Discovery) is a special step that runs at the start
    of every interaction and is excluded from this output check.

    Args:
        state: The protocol state

    Returns:
        Tuple of (all_completed, missing_steps)
    """
    missing = []
    # Check steps 1-8 (Step 0 is special Johari step, excluded from output check)
    for step_num in range(1, TOTAL_STEPS):
        if step_num not in state.step_outputs:
            missing.append(step_num)

    return len(missing) == 0, missing


def print_completion_summary(state: ProtocolState) -> None:
    """
    Print the protocol completion summary to stdout.
    """
    # Only print essential routing info for context
    if state.routing_decision:
        print(f"Route: {state.routing_decision}")
        if state.routing_justification:
            print(f"Reason: {state.routing_justification}")


def print_halted_summary(state: ProtocolState) -> None:
    """
    Print summary for a halted protocol (awaiting clarification).
    """
    print(f"HALTED: {state.halt_reason or 'Ambiguity detected'}")

    if state.clarification_questions:
        for i, question in enumerate(state.clarification_questions, 1):
            print(f"{i}. {question}")


def complete_protocol(state: ProtocolState) -> bool:
    """
    Complete the protocol and transition to COMPLETED state.

    Args:
        state: The protocol state

    Returns:
        True if completion successful
    """
    # Verify all steps completed
    all_completed, missing = verify_all_steps_completed(state)

    if not all_completed:
        print(f"ERROR: Cannot complete - steps {missing} not completed",
              file=sys.stderr)
        return False

    # Check if already halted
    if state.fsm.is_halted():
        print_halted_summary(state)
        return True

    # Transition to completed
    if not state.complete_protocol():
        print("ERROR: Failed to transition to COMPLETED state",
              file=sys.stderr)
        return False

    # Save final state
    state.save()

    # Print completion summary
    print_completion_summary(state)

    # Check for learning opportunities (self-learning system principle)
    learning_prompt = check_and_prompt_learnings(state)
    if learning_prompt:
        print(learning_prompt)

    # Dispatch to execution protocol if routing decision exists
    if state.routing_decision:
        print_dispatch_directive(state)

    return True


def print_dispatch_directive(state: ProtocolState) -> None:
    """
    Print the directive to dispatch to execution protocol.

    This is the bridge between reasoning protocol completion and
    execution protocol initiation.

    Also sets dispatch_pending in state so the hook can ensure
    execution chain continues even if this print is not processed.

    The context includes Johari schema from Step 0 to guide agent invocation.
    The DA uses this when building agent prompts with role_extension and research_terms.
    """
    # Get dispatcher path relative to orchestration root
    dispatcher_script = Path(__file__).parent.parent / "protocols/execution" / "dispatcher.py"

    directive_command = f"python {dispatcher_script} --reasoning-session {state.session_id} --route {state.routing_decision}"

    # Extract Johari schema from Step 0 output (if available)
    step_0_output = state.step_outputs.get(0, {})
    johari_schema = step_0_output.get("johari_schema", {})

    # Set dispatch pending in state (hook will check this)
    # Include Johari schema and template requirements for downstream agent invocation
    state.set_dispatch_pending(
        route=state.routing_decision,
        directive_command=directive_command,
        context={
            "routing_justification": state.routing_justification,
            "user_query": state.user_query,
            "johari_schema": johari_schema,
            "johari_usage": (
                "When invoking agents, the DA should extract Johari findings from "
                "Step 0 analysis and pass them to the agent prompt under 'Prior Knowledge "
                "(Johari Window)' section with Open/Blind/Hidden/Unknown quadrants."
            ),
            "template_requirement": (
                "When invoking agents via atomic skills (orchestrate-*), use the Agent "
                "Prompt Template format. Include: Task Context, Role Extension (generate "
                "3-5 task-specific focus areas dynamically), Johari Context (from above), "
                "Task Instructions, Research Terms (generate 7-10 keywords), and Output "
                "Requirements (memory file path). See DA.md 'Agent Prompt Template Requirements' "
                "or the skill's SKILL.md 'Agent Invocation Format' section for full template."
            ),
        }
    )
    state.save()

    directive = format_mandatory_directive(
        directive_command,
        "Reasoning Protocol complete. Dispatch to Execution Protocol. "
    )
    print(directive)


def main() -> int:
    """
    Main completion handler.

    Returns:
        Exit code (0 for success, 1 for error)
    """
    parser = argparse.ArgumentParser(
        description="Complete the Mandatory Reasoning Protocol",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )

    parser.add_argument(
        "--state",
        required=True,
        help="Path to the state file"
    )

    args = parser.parse_args()

    # Load state
    state_path = Path(args.state)
    if not state_path.exists():
        print(f"ERROR: State file not found: {args.state}", file=sys.stderr)
        return 1

    # Extract session ID from filename
    # Format: reasoning-{session_id}.json
    session_id = state_path.stem.replace("reasoning-", "")

    state = ProtocolState.load(session_id)
    if not state:
        print(f"ERROR: Could not load state from {args.state}", file=sys.stderr)
        return 1

    # Complete the protocol
    if not complete_protocol(state):
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
