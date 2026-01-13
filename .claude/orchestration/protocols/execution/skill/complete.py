"""
complete.py
===========

Completion handler for Skill Orchestration Protocol.

This script finalizes the protocol execution after all 6 steps complete.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

# Path setup - navigate to execution protocol root
_SKILL_DIR = Path(__file__).resolve().parent
_EXECUTION_ROOT = _SKILL_DIR.parent
if str(_EXECUTION_ROOT) not in sys.path:
    sys.path.insert(0, str(_EXECUTION_ROOT))

from config.config import ProtocolType
from core.state import ExecutionState


def main() -> int:
    """
    Main entry point for protocol completion.

    Returns:
        Exit code (0 for success, 1 for error)
    """
    parser = argparse.ArgumentParser(
        description="Complete Skill Orchestration Protocol",
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

    # Extract session ID
    filename = state_path.stem
    # Format: skill-{session-id} (canonical) or skill-orchestration-{session-id} (legacy)
    if filename.startswith("skill-orchestration-"):
        session_id = filename[len("skill-orchestration-"):]
    elif filename.startswith("skill-"):
        session_id = filename[len("skill-"):]
    else:
        session_id = filename.rsplit("-", 1)[-1]

    state = ExecutionState.load(ProtocolType.SKILL_ORCHESTRATION, session_id)
    if not state:
        print(f"ERROR: Could not load state from {args.state}", file=sys.stderr)
        return 1

    # Complete the protocol
    if not state.complete_protocol("Skill Orchestration completed successfully"):
        print("ERROR: Could not complete protocol", file=sys.stderr)
        return 1

    state.save()

    # Protocol complete - no output needed
    return 0


if __name__ == "__main__":
    sys.exit(main())
