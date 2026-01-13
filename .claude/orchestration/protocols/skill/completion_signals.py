"""
Completion Signals Module
=========================

Provides a signaling mechanism for agents to notify the skill orchestrator
that they have completed their phase. This bridges the gap between
AgentExecutionState (agent-level) and SkillExecutionState (skill-level).

Signal Flow:
1. Agent completes cognitive work
2. Agent writes memory file (Johari format)
3. Agent calls complete.py which:
   a. Verifies memory file exists
   b. Writes completion signal to signals/{task-id}/phase-{phase-id}.json
4. Skill orchestrator reads signal and:
   a. Verifies memory file format
   b. Transitions FSM to next phase
   c. Clears signal file

Signal Location:
    .claude/orchestration/protocols/skill/signals/{task-id}/phase-{phase-id}.json

Signal Format:
{
    "task_id": "task-xyz",
    "phase_id": "0",
    "agent_name": "clarification",
    "memory_file": ".claude/memory/task-xyz-clarification-memory.md",
    "status": "completed",
    "timestamp": "2024-12-29T10:30:00Z"
}
"""

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

# Base directory for signals
SIGNALS_BASE = Path(__file__).parent / "signals"


def get_signal_dir(task_id: str) -> Path:
    """Get the signals directory for a specific task."""
    return SIGNALS_BASE / task_id


def get_signal_path(task_id: str, phase_id: str) -> Path:
    """Get the path to a specific phase's completion signal file."""
    return get_signal_dir(task_id) / f"phase-{phase_id}.json"


def write_signal(
    task_id: str,
    phase_id: str,
    agent_name: str,
    memory_file: str,
    status: str = "completed",
    metadata: Optional[dict] = None,
) -> Path:
    """
    Write a completion signal for a phase.

    Called by agent complete.py scripts to signal that the agent
    has finished its cognitive work and written its memory file.

    Args:
        task_id: Task identifier
        phase_id: Phase identifier (e.g., "0", "1.5", "3")
        agent_name: Name of the agent that completed
        memory_file: Path to the memory file created
        status: Completion status (completed, failed, partial)
        metadata: Optional additional metadata

    Returns:
        Path to the written signal file
    """
    signal_dir = get_signal_dir(task_id)
    signal_dir.mkdir(parents=True, exist_ok=True)

    signal_path = get_signal_path(task_id, phase_id)

    signal_data = {
        "task_id": task_id,
        "phase_id": phase_id,
        "agent_name": agent_name,
        "memory_file": memory_file,
        "status": status,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }

    if metadata:
        signal_data["metadata"] = metadata

    with open(signal_path, "w") as f:
        json.dump(signal_data, f, indent=2)

    return signal_path


def read_signal(task_id: str, phase_id: str) -> Optional[dict]:
    """
    Read a completion signal for a phase.

    Called by skill orchestrator to check if an agent has signaled completion.

    Args:
        task_id: Task identifier
        phase_id: Phase identifier

    Returns:
        Signal data dict if exists, None otherwise
    """
    signal_path = get_signal_path(task_id, phase_id)

    if not signal_path.exists():
        return None

    try:
        with open(signal_path) as f:
            return json.load(f)
    except (json.JSONDecodeError, IOError):
        return None


def signal_exists(task_id: str, phase_id: str) -> bool:
    """Check if a completion signal exists for a phase."""
    return get_signal_path(task_id, phase_id).exists()


def clear_signal(task_id: str, phase_id: str) -> bool:
    """
    Clear a completion signal after processing.

    Called by skill orchestrator after successfully processing
    the completion (FSM transition, memory verification, etc).

    Args:
        task_id: Task identifier
        phase_id: Phase identifier

    Returns:
        True if signal was cleared, False if it didn't exist
    """
    signal_path = get_signal_path(task_id, phase_id)

    if signal_path.exists():
        signal_path.unlink()
        return True
    return False


def clear_all_signals(task_id: str) -> int:
    """
    Clear all completion signals for a task.

    Typically called when a skill workflow completes or is reset.

    Args:
        task_id: Task identifier

    Returns:
        Number of signals cleared
    """
    signal_dir = get_signal_dir(task_id)

    if not signal_dir.exists():
        return 0

    count = 0
    for signal_file in signal_dir.glob("phase-*.json"):
        signal_file.unlink()
        count += 1

    # Remove empty directory
    if signal_dir.exists() and not any(signal_dir.iterdir()):
        signal_dir.rmdir()

    return count


def get_pending_signals(task_id: str) -> list[dict]:
    """
    Get all pending (unprocessed) completion signals for a task.

    Useful for checking if multiple phases completed while
    orchestrator was not polling.

    Args:
        task_id: Task identifier

    Returns:
        List of signal data dicts, sorted by phase_id
    """
    signal_dir = get_signal_dir(task_id)

    if not signal_dir.exists():
        return []

    signals = []
    for signal_file in signal_dir.glob("phase-*.json"):
        try:
            with open(signal_file) as f:
                signals.append(json.load(f))
        except (json.JSONDecodeError, IOError):
            continue

    # Sort by phase_id (handle numeric and dotted versions like "0.5")
    def phase_sort_key(s):
        try:
            return float(s.get("phase_id", "999"))
        except ValueError:
            return 999

    return sorted(signals, key=phase_sort_key)


def wait_for_signal(
    task_id: str,
    phase_id: str,
    timeout_seconds: float = 300,
    poll_interval: float = 1.0,
) -> Optional[dict]:
    """
    Wait for a completion signal to appear.

    This is a blocking operation that polls for the signal file.
    Typically used in testing or synchronous orchestration.

    Args:
        task_id: Task identifier
        phase_id: Phase identifier
        timeout_seconds: Maximum time to wait
        poll_interval: Seconds between polls

    Returns:
        Signal data if received within timeout, None otherwise
    """
    import time

    start_time = time.time()

    while time.time() - start_time < timeout_seconds:
        signal = read_signal(task_id, phase_id)
        if signal:
            return signal
        time.sleep(poll_interval)

    return None


# Convenience functions for common signal patterns


def signal_phase_completed(
    task_id: str,
    phase_id: str,
    agent_name: str,
) -> Path:
    """
    Shorthand for writing a successful completion signal.

    Automatically determines memory file path based on convention.
    """
    memory_file = f".claude/memory/{task_id}-{agent_name}-memory.md"
    return write_signal(
        task_id=task_id,
        phase_id=phase_id,
        agent_name=agent_name,
        memory_file=memory_file,
        status="completed",
    )


def signal_phase_failed(
    task_id: str,
    phase_id: str,
    agent_name: str,
    error: str,
) -> Path:
    """
    Write a failure signal for a phase.

    Used when agent encounters an unrecoverable error.
    """
    memory_file = f".claude/memory/{task_id}-{agent_name}-memory.md"
    return write_signal(
        task_id=task_id,
        phase_id=phase_id,
        agent_name=agent_name,
        memory_file=memory_file,
        status="failed",
        metadata={"error": error},
    )


def signal_phase_needs_remediation(
    task_id: str,
    phase_id: str,
    agent_name: str,
    issues: list[str],
) -> Path:
    """
    Signal that phase needs remediation.

    Used when validation fails but is recoverable.
    """
    memory_file = f".claude/memory/{task_id}-{agent_name}-memory.md"
    return write_signal(
        task_id=task_id,
        phase_id=phase_id,
        agent_name=agent_name,
        memory_file=memory_file,
        status="needs_remediation",
        metadata={"issues": issues},
    )


def signal_phase_needs_clarification(
    task_id: str,
    phase_id: str,
    agent_name: str,
    questions: list[dict],
) -> Path:
    """
    Signal that phase needs user clarification.

    Used when the clarification-agent (or any agent) has questions
    that require user input. The main orchestrator will:
    1. Detect this signal
    2. Parse the questions from the memory file
    3. Use AskUserQuestion to present them to the user
    4. Resume the workflow with user answers

    Args:
        task_id: Task identifier
        phase_id: Phase identifier
        agent_name: Name of the agent requesting clarification
        questions: List of question dicts with format:
            {
                "id": "Q1",
                "priority": "P0",
                "question": "Question text",
                "context": "Why this matters",
                "options": ["Option A", "Option B"],  # optional
                "default": null  # optional
            }

    Returns:
        Path to the written signal file
    """
    memory_file = f".claude/memory/{task_id}-{agent_name}-memory.md"
    return write_signal(
        task_id=task_id,
        phase_id=phase_id,
        agent_name=agent_name,
        memory_file=memory_file,
        status="needs_clarification",
        metadata={"questions": questions, "clarification_required": True},
    )


# --- Utility Logging Integration ---

def signal_workflow_completed_with_utility(
    task_id: str,
    skill_name: str,
    agent_sequence: list[str],
    outcome: str,  # "success" | "partial" | "failure"
    total_tokens: int,
    total_time_seconds: float,
    context_type: str,
    remediation_loops: int = 0,
) -> None:
    """
    Signal workflow completion and log utility event.

    This function should be called when a skill workflow completes
    to record the outcome for utility-based routing optimization.

    Args:
        task_id: Task identifier
        skill_name: Name of the skill that completed
        agent_sequence: List of agents invoked during workflow
        outcome: Completion outcome (success, partial, failure)
        total_tokens: Total tokens used during workflow
        total_time_seconds: Total wall-clock time
        context_type: Task domain (technical, personal, creative, etc.)
        remediation_loops: Number of remediation loops triggered
    """
    try:
        from utility_tracker import UtilityEvent, save_utility_event

        event = UtilityEvent(
            task_id=task_id,
            timestamp=datetime.now(timezone.utc).isoformat(),
            skill_name=skill_name,
            agent_sequence=agent_sequence,
            outcome=outcome,
            total_tokens=total_tokens,
            total_time_seconds=total_time_seconds,
            context_type=context_type,
            remediation_loops=remediation_loops,
        )
        save_utility_event(event)
    except ImportError:
        # Utility tracker not available, skip logging
        pass
    except Exception as e:
        # Don't fail workflow completion due to utility logging errors
        import sys
        print(f"Warning: Utility logging failed: {e}", file=sys.stderr)
