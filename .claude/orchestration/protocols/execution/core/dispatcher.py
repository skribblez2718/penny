"""
dispatcher.py
=============

Dispatch to the appropriate execution protocol based on routing decision.

This script is called after set_route.py captures the final routing.
It:
1. Creates a new execution protocol session
2. Links it to the originating reasoning session
3. Prints directive to start the protocol's entry.py

Note: Planning is now handled by Claude Code's built-in EnterPlanMode tool.
The old plan extraction logic has been removed.

Usage:
    python dispatcher.py --reasoning-session <session_id> --route <route>
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

# Path setup - navigate to protocol root
_CORE_DIR = Path(__file__).resolve().parent
_EXECUTION_ROOT = _CORE_DIR.parent
if str(_EXECUTION_ROOT) not in sys.path:
    sys.path.insert(0, str(_EXECUTION_ROOT))

from config.config import (
    ProtocolType,
    ROUTE_TO_PROTOCOL,
    ROUTE_ALIASES,
    VALID_ROUTES,
    normalize_route_name,
    get_protocol_dir,
    format_mandatory_directive,
)
from core.state import ExecutionState

# All valid route inputs (canonical + legacy)
ALL_VALID_ROUTE_INPUTS = list(VALID_ROUTES) + list(ROUTE_ALIASES.keys())


def dispatch(reasoning_session_id: str, route: str) -> int:
    """
    Dispatch to an execution protocol.

    Args:
        reasoning_session_id: ID of the originating reasoning session
        route: The routing decision string (accepts both canonical and legacy names)

    Returns:
        Exit code (0 for success, 1 for error)
    """
    # Normalize route name (converts legacy to canonical)
    normalized_route = normalize_route_name(route)

    # Validate route
    if normalized_route not in VALID_ROUTES:
        print(f"ERROR: Invalid route '{route}'", file=sys.stderr)
        print(f"Valid routes: {', '.join(VALID_ROUTES)}", file=sys.stderr)
        return 1

    # Get protocol type
    protocol_type = ROUTE_TO_PROTOCOL.get(normalized_route)
    if not protocol_type:
        print(f"ERROR: Route '{route}' not mapped to protocol", file=sys.stderr)
        return 1

    # Create execution state
    # Note: Planning is now handled by Claude Code's built-in EnterPlanMode tool
    state = ExecutionState(
        protocol_type=protocol_type,
        reasoning_session_id=reasoning_session_id,
    )

    # Save state
    state_file = state.save()

    # Get entry script path
    protocol_dir = get_protocol_dir(protocol_type)
    entry_script = protocol_dir / "entry.py"

    # Print dispatch command
    directive = format_mandatory_directive(
        f"python {entry_script} --state {state_file}",
        f"Starting {route.replace('-', ' ').title()} execution protocol. ",
        protocol_type
    )
    print(directive)

    return 0


def main() -> int:
    """
    Main entry point for dispatcher.

    Returns:
        Exit code (0 for success, 1 for error)
    """
    parser = argparse.ArgumentParser(
        description="Dispatch to execution protocol based on routing",
    )
    parser.add_argument(
        "--reasoning-session",
        required=True,
        help="ID of the originating reasoning session"
    )
    parser.add_argument(
        "--route",
        required=True,
        choices=ALL_VALID_ROUTE_INPUTS,
        help="The routing decision (accepts 'skill', 'dynamic', or legacy 'skill-orchestration', 'dynamic-skill-sequencing')"
    )

    args = parser.parse_args()

    return dispatch(args.reasoning_session, args.route)


if __name__ == "__main__":
    sys.exit(main())
