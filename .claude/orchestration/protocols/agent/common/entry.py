"""
Common Agent Entry Point Logic
==============================

Shared initialization logic for all cognitive agents.
Each agent's entry.py imports and calls agent_entry().

ENFORCEMENT: Prints all mandatory steps that MUST be executed.
Memory file will be rejected if any step is missing.
"""

from __future__ import annotations

import argparse
import sys
import uuid
from pathlib import Path

# Path setup - add protocols directory for fully-qualified imports
# This prevents collision between agent/config and skill/config
_COMMON_DIR = Path(__file__).resolve().parent
_AGENT_PROTOCOLS_DIR = _COMMON_DIR.parent
_PROTOCOLS_DIR = _AGENT_PROTOCOLS_DIR.parent
if str(_PROTOCOLS_DIR) not in sys.path:
    sys.path.insert(0, str(_PROTOCOLS_DIR))

from agent.steps.base import AgentExecutionState
from agent.config.config import get_agent_config, get_step_script_path, format_agent_directive


def parse_args(agent_name: str) -> argparse.Namespace:
    """Parse common arguments for agent entry."""
    parser = argparse.ArgumentParser(description=f"Initialize {agent_name} execution")
    parser.add_argument("task_id", nargs="?", default=None, help="Task ID")
    parser.add_argument("--skill-name", help="Skill name if invoked from a skill")
    parser.add_argument("--phase-id", help="Phase ID if invoked from a skill")
    parser.add_argument(
        "--context-pattern",
        default="IMMEDIATE_PREDECESSORS",
        choices=["WORKFLOW_ONLY", "IMMEDIATE_PREDECESSORS", "MULTIPLE_PREDECESSORS"],
        help="Context loading pattern",
    )
    parser.add_argument(
        "--predecessors",
        help="Comma-separated list of predecessor agent names",
    )
    return parser.parse_args()


def _print_mandatory_steps(config: dict, agent_name: str) -> None:
    """Print minimal step list (no banners)."""
    # No output - steps are already tracked in state and enforced by complete.py
    pass


def agent_entry(agent_name: str) -> None:
    """
    Common entry point logic for all agents.

    Creates execution state, stores skill context if provided,
    prints mandatory step list, and outputs the first step directive.

    Args:
        agent_name: Name of the agent (e.g., "clarification")
    """
    args = parse_args(agent_name)

    task_id = args.task_id or str(uuid.uuid4())
    config = get_agent_config(agent_name)

    if not config:
        print(f"ERROR: Agent '{agent_name}' not found", file=sys.stderr)
        sys.exit(1)

    # Create execution state
    state = AgentExecutionState(
        agent_name=agent_name,
        task_id=task_id,
        current_step=0,
    )

    # Track expected steps in state metadata for verification
    state.metadata["expected_steps"] = len(config.get("steps", []))
    state.metadata["steps_completed"] = []

    # Store skill context if provided
    predecessors = args.predecessors.split(",") if args.predecessors else []
    state.set_skill_context(
        skill_name=args.skill_name,
        phase_id=args.phase_id,
        context_pattern=args.context_pattern,
        predecessors=predecessors,
    )

    # Minimal output - just essentials
    print(f"## {config['cognitive_function']} Agent")
    print(f"Task: `{task_id[:8]}...`")
    if args.skill_name:
        print(f"Skill: `{args.skill_name}` Phase: `{args.phase_id}`")
    print(f"Steps: {len(config['steps'])}")
    print()

    # ENFORCEMENT: Print all mandatory steps
    _print_mandatory_steps(config, agent_name)

    # First step directive
    first_step_script = get_step_script_path(agent_name, 0)

    # Build command - shared.py needs --step argument
    if first_step_script.name == "shared.py":
        command = f"python3 {first_step_script} --step 0 --state {state.state_file_path}"
    else:
        command = f"python3 {first_step_script} --state {state.state_file_path}"

    directive = format_agent_directive(command, agent_name, 0)
    print(directive)
