"""
Common Skill Completion Logic
=============================

Shared completion logic for all composite skills.
Each skill's complete.py imports and calls skill_complete().

Integrates with episodic memory to store episodes after each skill completion.
Triggers automatic state cleanup when skills reach FULLY_COMPLETE.
All imports are ABSOLUTE - no relative imports allowed.
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from datetime import datetime
from pathlib import Path

# Path setup - add protocols directory for fully-qualified imports
# This prevents collision between skill/config and agent/config
# From composite/common_skill_complete.py, go up 2 levels to reach protocols/
_COMPOSITE_DIR = Path(__file__).resolve().parent
_SKILL_PROTOCOLS_ROOT = _COMPOSITE_DIR.parent
_PROTOCOLS_DIR = _SKILL_PROTOCOLS_ROOT.parent
_ORCHESTRATION_ROOT = _PROTOCOLS_DIR.parent
_CLAUDE_ROOT = _ORCHESTRATION_ROOT.parent

if str(_PROTOCOLS_DIR) not in sys.path:
    sys.path.insert(0, str(_PROTOCOLS_DIR))

# Fully-qualified imports from skill package
from skill.core.state import SkillExecutionState, STATE_DIR
from skill.core.fsm import SkillPhaseState
from skill.memory_verifier import list_memory_files, verify_format
from skill.episode_store_helper import store_skill_episode, create_episode_from_skill_state
from skill.learning_trigger import (
    should_trigger_learnings,
    format_trigger_prompt,
    build_learnings_directive,
)
from skill.episodic_memory import load_all_episodes


def _remove_current_session_symlink() -> None:
    """
    Remove the current-session symlink after skill completion.

    This cleans up the symlink created by common_skill_entry.py
    to prevent stale orchestration state from affecting future operations.
    """
    try:
        symlink_path = STATE_DIR / "current-session.json"
        if symlink_path.exists() or symlink_path.is_symlink():
            symlink_path.unlink()
    except (OSError, IOError) as e:
        print(f"Warning: Could not remove current-session symlink: {e}", file=sys.stderr)

# Skills that bypass mandatory learnings capture
# for performance optimization or to prevent recursion
SKILLS_BYPASSING_LEARNINGS = frozenset([
    "develop-learnings",  # Prevent recursion
])


def _trigger_cleanup() -> int:
    """
    Trigger state cleanup after task completion.

    Removes all state JSON files from orchestration directories
    and all memory markdown files.

    Returns:
        Number of files cleaned (0 if cleanup failed)
    """
    try:
        # Build cleanup commands
        cleanup_commands = [
            # Remove all state JSON files
            f'find {_ORCHESTRATION_ROOT} -path "*/state/*.json" -type f -delete',
            # Remove all memory markdown files
            f'find {_CLAUDE_ROOT}/memory -name "*.md" -type f -delete 2>/dev/null || true',
        ]

        cleaned = 0

        # Count files before deletion
        count_state = subprocess.run(
            f'find {_ORCHESTRATION_ROOT} -path "*/state/*.json" -type f | wc -l',
            shell=True,
            capture_output=True,
            text=True,
            timeout=10,
        )
        count_memory = subprocess.run(
            f'find {_CLAUDE_ROOT}/memory -name "*.md" -type f 2>/dev/null | wc -l',
            shell=True,
            capture_output=True,
            text=True,
            timeout=10,
        )

        try:
            cleaned += int(count_state.stdout.strip())
            cleaned += int(count_memory.stdout.strip())
        except ValueError:
            pass

        # Execute cleanup
        for cmd in cleanup_commands:
            subprocess.run(
                cmd,
                shell=True,
                capture_output=True,
                timeout=30,
            )

        return cleaned
    except (subprocess.TimeoutExpired, subprocess.SubprocessError):
        return 0


def parse_args() -> argparse.Namespace:
    """Parse common arguments for skill completion."""
    parser = argparse.ArgumentParser(description="Complete skill execution")
    parser.add_argument("session_id", help="Session ID")
    return parser.parse_args()


def _extract_episode_data(state: SkillExecutionState, skill_name: str) -> dict:
    """
    Extract episode data from skill execution state.

    Args:
        state: The skill execution state
        skill_name: Name of the completed skill

    Returns:
        Dictionary with episode data fields
    """
    # Extract task description from metadata or generate from task_id
    task_description = state.metadata.get(
        "task_description",
        state.metadata.get("original_request", f"Task {state.task_id}")
    )

    # Extract domain from metadata
    domain = state.metadata.get("domain", "technical")

    # Extract agents invoked from metadata or phase history
    agents_invoked = state.metadata.get("agents_invoked", [])

    # If no agents tracked, try to infer from phases
    if not agents_invoked and hasattr(state, "phase_history"):
        agents_invoked = [
            phase.get("agent", "unknown")
            for phase in state.phase_history
            if phase.get("agent")
        ]

    # Determine outcome based on status
    status = state.metadata.get("status", "complete")
    if status == "complete":
        outcome = "success"
    elif status == "partial":
        outcome = "partial"
    else:
        outcome = "failure"

    return {
        "task_id": state.task_id,
        "skill_name": skill_name,
        "task_description": task_description,
        "domain": domain,
        "agents_invoked": agents_invoked,
        "outcome": outcome,
    }


def _store_completion_episode(state: SkillExecutionState, skill_name: str):
    """
    Store an episode in episodic memory after skill completion.

    Extracts relevant information from the skill execution state
    and stores it for future pattern matching and recommendations.

    Args:
        state: The skill execution state
        skill_name: Name of the completed skill

    Returns:
        Tuple of (episode_id, episode) for further analysis
    """
    data = _extract_episode_data(state, skill_name)

    # Create the episode object for analysis
    episode = create_episode_from_skill_state(
        task_id=data["task_id"],
        skill_name=data["skill_name"],
        task_description=data["task_description"],
        domain=data["domain"],
        agents_invoked=data["agents_invoked"],
        outcome=data["outcome"],
    )

    # Store the episode
    episode_id = store_skill_episode(
        task_id=data["task_id"],
        skill_name=data["skill_name"],
        task_description=data["task_description"],
        domain=data["domain"],
        agents_invoked=data["agents_invoked"],
        outcome=data["outcome"],
    )

    return episode_id, episode


def skill_complete(skill_name: str) -> None:
    """
    Common completion logic for composite skills.

    Validates FSM state, checks memory files, outputs summary.

    Args:
        skill_name: Name of the skill (e.g., "develop-skill")
    """
    args = parse_args()

    state = SkillExecutionState.load(skill_name, args.session_id)
    if not state:
        print(f"ERROR: State not found for session {args.session_id}", file=sys.stderr)
        sys.exit(1)

    # Verify FSM completion
    # NOTE: FSM stores state as SkillPhaseState enum in .state attribute, not .current_state
    if state.fsm and state.fsm.state != SkillPhaseState.COMPLETED:
        if state.fsm.state == SkillPhaseState.EXECUTING:
            # RECOVERY: If FSM is still EXECUTING but all phases are complete,
            # this indicates a race condition where state wasn't saved before subprocess.
            # Recover by transitioning to COMPLETED state.
            print(f"INFO: Recovering FSM state from {state.fsm.state.name} to COMPLETED", file=sys.stderr)
            state.fsm.state = SkillPhaseState.COMPLETED
            state.fsm.history.append("COMPLETED")
            state.save()
        else:
            print(f"WARNING: FSM state is {state.fsm.state.name}, not COMPLETED", file=sys.stderr)

    # Check memory files
    memory_files = list_memory_files(state.task_id)
    valid_count = sum(1 for mf in memory_files if verify_format(mf)[0])

    # Calculate duration (use timezone-aware datetime for consistency)
    start_time = datetime.fromisoformat(state.started_at)
    # Handle both timezone-aware and naive datetimes
    now = datetime.now(start_time.tzinfo) if start_time.tzinfo else datetime.now()
    duration = now - start_time

    # ENFORCEMENT: Deactivate orchestration mode
    # This allows DA to use tools directly again
    state.deactivate_orchestration()

    # Update state
    state.metadata["completed_at"] = datetime.now().isoformat()
    state.metadata["duration_seconds"] = duration.total_seconds()
    state.metadata["status"] = "complete"
    state.save()

    # Remove current-session symlink
    _remove_current_session_symlink()

    # Store episode in episodic memory
    episode_id, episode = _store_completion_episode(state, skill_name)

    # Minimal output - completion marker only
    print(f"**{skill_name.upper().replace('-', '_')}_COMPLETE**")

    # Learnings capture trigger - ALWAYS ask for multi-agent tasks
    if skill_name not in SKILLS_BYPASSING_LEARNINGS:
        if state.fsm:
            state.fsm.require_learnings()
            state.save()

        # Check learning trigger criteria for enhanced reason in prompt
        should_learn, reason = should_trigger_learnings(episode)
        reason_text = reason if should_learn else None

        # Print AskUserQuestion directive - ALWAYS ask the user
        print(build_learnings_directive(state.task_id, reason_text))
    else:
        if state.fsm:
            state.fsm.state = SkillPhaseState.FULLY_COMPLETE
            state.fsm.history.append("FULLY_COMPLETE")
            state.save()
        _trigger_cleanup()
