"""
Agent Factory Module
====================

Unified entry point for all cognitive agent operations. Eliminates boilerplate
in individual agent entry.py and complete.py files.

Usage:
    # Entry mode (initialize agent)
    python3 factory.py --agent clarification --mode entry [task_id] [options]

    # Complete mode (finalize agent)
    python3 factory.py --agent clarification --mode complete --state <path>

This module replaces the 14 identical boilerplate files (7 entry.py + 7 complete.py)
with a single parameterized entry point.

All agents can still be invoked via their traditional paths for backwards compatibility:
    python3 protocols/agent/clarification/entry.py [task_id]

The individual entry.py/complete.py files now delegate to this factory.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

# Path setup - add protocols directory for fully-qualified imports
# This prevents collision between agent/config and skill/config
_AGENT_PROTOCOLS_DIR = Path(__file__).resolve().parent
_PROTOCOLS_DIR = _AGENT_PROTOCOLS_DIR.parent
if str(_PROTOCOLS_DIR) not in sys.path:
    sys.path.insert(0, str(_PROTOCOLS_DIR))

# Import the common entry/complete functions
from agent.common.entry import agent_entry
from agent.common.complete import agent_complete

# Import canonical agent names from config
from agent.config.config import AGENT_REGISTRY, AGENT_NAME_ALIASES, normalize_agent_name

# Registry of valid agents - use short canonical names
VALID_AGENTS = frozenset(AGENT_REGISTRY.keys())

# Also accept old names for backwards compatibility
VALID_AGENTS_WITH_ALIASES = VALID_AGENTS | frozenset(AGENT_NAME_ALIASES.keys())


def create_entry_parser() -> argparse.ArgumentParser:
    """Create argument parser for factory mode."""
    parser = argparse.ArgumentParser(
        description="Agent Factory - Unified entry point for all cognitive agents",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
    # Initialize clarification agent
    %(prog)s --agent clarification-agent --mode entry task-123

    # Complete research agent
    %(prog)s --agent research-agent --mode complete --state /path/to/state.json

    # List available agents
    %(prog)s --list-agents
        """
    )

    parser.add_argument(
        "--agent", "-a",
        choices=sorted(VALID_AGENTS_WITH_ALIASES),
        help="Agent name to invoke (supports both short and legacy names)"
    )
    parser.add_argument(
        "--mode", "-m",
        choices=["entry", "complete"],
        help="Operation mode: entry (initialize) or complete (finalize)"
    )
    parser.add_argument(
        "--list-agents",
        action="store_true",
        help="List all available agents and exit"
    )

    return parser


def run_entry_mode(agent_name: str, remaining_args: list[str]) -> int:
    """
    Run agent in entry mode (initialization).

    Patches sys.argv to pass remaining arguments to agent_entry().
    """
    # Reconstruct argv for the agent entry parser
    script_name = f"protocols/agent/{agent_name}/entry.py"
    sys.argv = [script_name] + remaining_args

    try:
        agent_entry(agent_name)
        return 0
    except SystemExit as e:
        return e.code if isinstance(e.code, int) else 1
    except Exception as e:
        print(f"ERROR: Agent entry failed: {e}", file=sys.stderr)
        return 1


def run_complete_mode(agent_name: str, remaining_args: list[str]) -> int:
    """
    Run agent in complete mode (finalization).

    Patches sys.argv to pass remaining arguments to agent_complete().
    """
    # Reconstruct argv for the agent complete parser
    script_name = f"protocols/agent/{agent_name}/complete.py"
    sys.argv = [script_name] + remaining_args

    try:
        agent_complete(agent_name)
        return 0
    except SystemExit as e:
        return e.code if isinstance(e.code, int) else 1
    except Exception as e:
        print(f"ERROR: Agent completion failed: {e}", file=sys.stderr)
        return 1


def main() -> int:
    """Main entry point for agent factory."""
    parser = create_entry_parser()

    # Parse only known args to allow pass-through of agent-specific args
    args, remaining = parser.parse_known_args()

    if args.list_agents:
        print("Available Agents:")
        print("-" * 40)
        for agent in sorted(VALID_AGENTS):
            print(f"  {agent}")
        print()
        print("Legacy aliases (also accepted):")
        for old, new in sorted(AGENT_NAME_ALIASES.items()):
            print(f"  {old} -> {new}")
        return 0

    if not args.agent:
        parser.error("--agent is required (or use --list-agents)")

    if not args.mode:
        parser.error("--mode is required (entry or complete)")

    if args.agent not in VALID_AGENTS_WITH_ALIASES:
        print(f"ERROR: Unknown agent: {args.agent}", file=sys.stderr)
        print(f"Valid agents: {', '.join(sorted(VALID_AGENTS))}", file=sys.stderr)
        return 1

    # Normalize agent name to canonical short form
    agent_name = normalize_agent_name(args.agent)

    if args.mode == "entry":
        return run_entry_mode(agent_name, remaining)
    elif args.mode == "complete":
        return run_complete_mode(agent_name, remaining)
    else:
        print(f"ERROR: Unknown mode: {args.mode}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
