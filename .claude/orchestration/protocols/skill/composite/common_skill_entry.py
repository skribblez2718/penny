"""
Common Skill Entry Point Logic
==============================

Shared initialization logic for all composite skills.
Each skill's entry.py imports and calls skill_entry().
"""

from __future__ import annotations

import argparse
import sys
import uuid
from pathlib import Path
from typing import Optional, Callable

# Path setup - add protocols directory for fully-qualified imports
# This prevents collision between skill/config and agent/config
# From composite/common_skill_entry.py, go up 2 levels to reach protocols/
_COMPOSITE_DIR = Path(__file__).resolve().parent
_SKILL_PROTOCOLS_ROOT = _COMPOSITE_DIR.parent
_PROTOCOLS_DIR = _SKILL_PROTOCOLS_ROOT.parent
if str(_PROTOCOLS_DIR) not in sys.path:
    sys.path.insert(0, str(_PROTOCOLS_DIR))

from skill.core.state import SkillExecutionState, STATE_DIR
from skill.config.config import get_phase_config, get_atomic_skill_agent, PhaseType


def _create_current_session_symlink(state: SkillExecutionState) -> None:
    """
    Create symlink to current session state for PreToolUse hook access.

    The PreToolUse hook needs to access orchestration state to determine
    if DA tool usage should be blocked. This symlink provides a stable
    path for hooks to find the current session.

    Args:
        state: The current skill execution state
    """
    try:
        symlink_path = STATE_DIR / "current-session.json"
        state_file = state.get_state_file_path()

        # Remove existing symlink if present
        if symlink_path.exists() or symlink_path.is_symlink():
            symlink_path.unlink()

        # Create symlink to current session
        symlink_path.symlink_to(state_file.name)
    except (OSError, IOError) as e:
        print(f"Warning: Could not create current-session symlink: {e}", file=sys.stderr)


def parse_args(
    skill_name: str,
    add_extra_args: Optional[Callable[[argparse.ArgumentParser], None]] = None
) -> argparse.Namespace:
    """Parse common arguments for skill entry.

    Args:
        skill_name: Name of the skill for help text
        add_extra_args: Optional callback to add skill-specific arguments
    """
    parser = argparse.ArgumentParser(description=f"Initialize {skill_name}")
    parser.add_argument("task_id", nargs="?", default=None, help="Task ID")
    parser.add_argument("--domain", default="technical", help="Task domain")
    parser.add_argument("--session-id", help="Execution session ID")

    # Allow skill-specific arguments
    if add_extra_args:
        add_extra_args(parser)

    return parser.parse_args()


def skill_entry(
    skill_name: str,
    skill_dir: Path,
    add_extra_args: Optional[Callable[[argparse.ArgumentParser], None]] = None
) -> SkillExecutionState:
    """
    Common entry point logic for composite skills.

    Creates execution state, starts FSM, prints first phase directive.
    Returns state for any additional processing.

    Args:
        skill_name: Name of the skill (e.g., "develop-skill")
        skill_dir: Path to the skill directory
        add_extra_args: Optional callback to add skill-specific arguments

    Returns:
        Initialized SkillExecutionState
    """
    args = parse_args(skill_name, add_extra_args)

    # Generate task ID if not provided
    task_id = args.task_id or f"task-{skill_name.split('-')[0]}-{str(uuid.uuid4())[:8]}"

    # Create execution state
    state = SkillExecutionState(
        skill_name=skill_name,
        task_id=task_id,
        execution_session_id=args.session_id,
    )
    state.metadata["domain"] = args.domain

    # Store all parsed arguments in metadata for skill-specific access
    args_dict = vars(args)
    for key, value in args_dict.items():
        if key not in ("task_id", "session_id", "domain") and value is not None:
            state.metadata[key] = value

    # Start FSM
    first_phase = state.fsm.start() if state.fsm else "0"

    # ENFORCEMENT: Phase 0 must be LINEAR (mandatory)
    # This ensures clarification ALWAYS runs - no exceptions
    phase_0_config = get_phase_config(skill_name, "0")
    if phase_0_config:
        phase_type = phase_0_config.get("type")
        # Normalize to PhaseType enum if string
        if isinstance(phase_type, str):
            phase_type = PhaseType[phase_type] if phase_type in PhaseType.__members__ else phase_type

        if phase_type != PhaseType.LINEAR:
            print(f"ENFORCEMENT VIOLATION: Phase 0 must be LINEAR (mandatory)", file=sys.stderr)
            print(f"Skill {skill_name} has Phase 0 type: {phase_type}", file=sys.stderr)
            print(f"Clarification is essential for first-attempt success.", file=sys.stderr)
            sys.exit(1)

    # ENFORCEMENT: Activate orchestration mode
    # This enables PreToolUse hook to block DA direct tool usage
    state.activate_orchestration()

    # Save initial state
    state.save()

    # Create symlink to current session for hook access
    _create_current_session_symlink(state)

    # Minimal output
    print(f"## {skill_name}")
    print(f"Task: `{task_id[:20]}...`")
    print(f"Session: `{state.session_id}`")
    print()

    # Get first phase config and print content
    phase_config = get_phase_config(skill_name, first_phase)
    if phase_config:
        content_file = skill_dir / "content" / phase_config.get("content", f"phase_{first_phase}.md")
        if content_file.exists():
            print(content_file.read_text())

        # Print agent invocation directive
        atomic_skill = phase_config.get("uses_atomic_skill")
        if atomic_skill:
            agent_name = get_atomic_skill_agent(atomic_skill)
            print(f"\n## Invoke Agent: {agent_name}")
            print(f"Use Task tool with subagent_type: `{agent_name}`")

        # Print advance directive for after agent completes
        print(f"\n## After Agent Completes")
        print(f"Run: `python3 .claude/orchestration/protocols/skill/core/advance_phase.py {skill_name} {state.session_id}`")

    return state
