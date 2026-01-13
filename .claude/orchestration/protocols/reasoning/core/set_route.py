"""
set_route.py
============

Capture the FINAL routing decision after Step 8 completes confidently.

This script is called when:
1. Step 8 (Knowledge Transfer Checkpoint) completes successfully
2. No contradictions were detected
3. Routing decision is validated and confident

It:
1. Records the final routing decision in state
2. Completes the reasoning protocol
3. Triggers automatic dispatch to the appropriate execution protocol

Usage:
    python set_route.py --state <state_file> --route <route>

Routes:
    - skill-orchestration: Multi-phase cognitive processing
    - dynamic-skill-sequencing: Dynamic orchestration of atomic skills
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

# Path setup - navigate to protocols directory for fully-qualified imports
# This prevents collision between reasoning/config and skill/config
_CORE_DIR = Path(__file__).resolve().parent
_REASONING_ROOT = _CORE_DIR.parent
_PROTOCOLS_DIR = _REASONING_ROOT.parent
if str(_PROTOCOLS_DIR) not in sys.path:
    sys.path.insert(0, str(_PROTOCOLS_DIR))

from reasoning.config.config import ORCHESTRATION_ROOT, format_mandatory_directive
from reasoning.core.state import ProtocolState
from reasoning.core.fsm import ReasoningState


# Valid routing options
VALID_ROUTES = [
    "skill-orchestration",
    "dynamic-skill-sequencing",
]


def main() -> int:
    """
    Main entry point for routing capture.

    Returns:
        Exit code (0 for success, 1 for error)
    """
    parser = argparse.ArgumentParser(
        description="Capture final routing decision after Step 8",
    )
    parser.add_argument(
        "--state",
        required=True,
        help="Path to the state file"
    )
    parser.add_argument(
        "--route",
        required=True,
        choices=VALID_ROUTES,
        help="The final routing decision"
    )
    parser.add_argument(
        "--reason",
        default="",
        help="Justification for the routing decision"
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

    # Verify we're at Step 8 (KNOWLEDGE_TRANSFER)
    if state.fsm.state != ReasoningState.KNOWLEDGE_TRANSFER:
        print(f"ERROR: set_route.py requires state KNOWLEDGE_TRANSFER, "
              f"got {state.fsm.state.name}", file=sys.stderr)
        print("This script should only be called after Step 8 completes.", file=sys.stderr)
        return 1

    # Set the final routing decision
    state.set_final_routing(args.route, args.reason)

    # Transition to COMPLETED
    if not state.fsm.transition(ReasoningState.COMPLETED):
        print("ERROR: FSM transition to COMPLETED failed", file=sys.stderr)
        return 1

    # Save state
    state.save()

    # Dispatch directive
    dispatcher_path = ORCHESTRATION_ROOT.parent / "execution" / "core" / "dispatcher.py"
    directive = format_mandatory_directive(
        f"python {dispatcher_path} --reasoning-session {session_id} --route {args.route}",
        "Route confirmed. Dispatch to Execution Protocol. "
    )
    print(directive)

    return 0


if __name__ == "__main__":
    sys.exit(main())
