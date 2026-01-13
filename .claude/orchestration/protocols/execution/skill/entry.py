"""
entry.py
========

Entry point for the Skill Orchestration Protocol.

This script initiates the 6-step skill orchestration workflow:
1. Generate Task ID
2. Classify Domain
3. Read Skill Definition
4. Create Memory File
5. Trigger Cognitive Agents
6. Complete Workflow

Usage:
    python entry.py --state <state_file>
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

from config.config import ProtocolType, get_protocol_steps_dir, format_mandatory_directive
from core.state import ExecutionState


def main() -> int:
    """
    Main entry point for skill orchestration protocol.

    Returns:
        Exit code (0 for success, 1 for error)
    """
    parser = argparse.ArgumentParser(
        description="Start the Skill Orchestration Protocol",
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

    # Direct to first step
    steps_dir = get_protocol_steps_dir(ProtocolType.SKILL_ORCHESTRATION)
    step1_script = steps_dir / "step_1_generate_task_id.py"

    directive = format_mandatory_directive(
        f"python {step1_script} --state {state_path}",
        "Starting Skill Orchestration protocol. Execute Step 1 of 6. ",
        ProtocolType.SKILL_ORCHESTRATION
    )
    print(directive)

    return 0


if __name__ == "__main__":
    sys.exit(main())
