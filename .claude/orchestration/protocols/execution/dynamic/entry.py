"""
entry.py
========

Entry point for the Dynamic Skill Sequencing Protocol.

This protocol handles tasks that require multiple cognitive functions but don't
match an existing composite skill. The orchestrator determines and invokes a sequence of
orchestrate-* atomic skills dynamically based on context.

KEY PRINCIPLE: Agents are NEVER invoked directly. All cognitive work flows
through orchestrate-* atomic skills.

5-Step Workflow:
1. Analyze Requirements - Determine which cognitive functions are needed
2. Plan Sequence - Order the orchestrate-* skill invocations based on context
3. Invoke Skills - Execute each orchestrate-* skill in sequence
4. Verify Completion - Ensure all cognitive functions completed successfully
5. Complete - Finalize workflow and cleanup

Usage:
    python entry.py --state <state_file>
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

from config.config import ProtocolType, get_protocol_steps_dir, format_mandatory_directive
from core.state import ExecutionState


def main() -> int:
    """
    Main entry point for dynamic skill sequencing protocol.

    Returns:
        Exit code (0 for success, 1 for error)
    """
    parser = argparse.ArgumentParser(
        description="Start the Dynamic Skill Sequencing Protocol",
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

    # Direct to first step (no banner per DA.md Orchestration Script Output Rules)
    steps_dir = get_protocol_steps_dir(ProtocolType.DYNAMIC_SKILL_SEQUENCING)
    step1_script = steps_dir / "step_1_analyze_requirements.py"

    directive = format_mandatory_directive(
        f"python {step1_script} --state {state_path}",
        "Starting Dynamic Skill Sequencing protocol. Execute Step 1 of 5. ",
        ProtocolType.DYNAMIC_SKILL_SEQUENCING
    )
    print(directive)

    return 0


if __name__ == "__main__":
    sys.exit(main())
