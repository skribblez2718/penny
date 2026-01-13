"""
complete.py
===========

Completion handler for Dynamic Skill Sequencing Protocol.

This script finalizes the protocol execution after all 5 steps complete.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

# Path setup - navigate to execution protocol root
_DYNAMIC_DIR = Path(__file__).resolve().parent
_EXECUTION_ROOT = _DYNAMIC_DIR.parent
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
        description="Complete Dynamic Skill Sequencing Protocol",
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
    # Format: dynamic-{session-id} (canonical) or dynamic-skill-sequencing-{session-id} (legacy)
    if filename.startswith("dynamic-skill-sequencing-"):
        session_id = filename[len("dynamic-skill-sequencing-"):]
    elif filename.startswith("dynamic-"):
        session_id = filename[len("dynamic-"):]
    else:
        session_id = filename.rsplit("-", 1)[-1]

    state = ExecutionState.load(ProtocolType.DYNAMIC_SKILL_SEQUENCING, session_id)
    if not state:
        print(f"ERROR: Could not load state from {args.state}", file=sys.stderr)
        return 1

    # Complete the protocol
    if not state.complete_protocol("Dynamic Skill Sequencing completed successfully"):
        print("ERROR: Could not complete protocol", file=sys.stderr)
        return 1

    state.save()

    # Protocol complete - no output needed
    return 0


if __name__ == "__main__":
    sys.exit(main())
