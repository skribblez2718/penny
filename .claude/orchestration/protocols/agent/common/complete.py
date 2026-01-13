"""
Common Agent Completion Logic
=============================

Shared completion logic for all cognitive agents.
Each agent's complete.py imports and calls agent_complete().

This module:
1. Validates all steps were completed
2. Verifies memory file exists (if skill context present)
3. Writes completion signal for skill orchestration
4. Invokes GoalMemory agent for metacognitive assessment (if in skill context)
5. Outputs minimal completion message
"""

from __future__ import annotations

import argparse
import sys
from datetime import datetime
from pathlib import Path
from typing import Dict, Any

# Path setup - add protocols directory for fully-qualified imports
# This prevents collision between agent/config and skill/config
_COMMON_DIR = Path(__file__).resolve().parent
_AGENT_PROTOCOLS_DIR = _COMMON_DIR.parent
_PROTOCOLS_DIR = _AGENT_PROTOCOLS_DIR.parent
if str(_PROTOCOLS_DIR) not in sys.path:
    sys.path.insert(0, str(_PROTOCOLS_DIR))

from agent.steps.base import AgentExecutionState
from agent.config.config import get_agent_config, normalize_agent_name

# Import from skill protocol (now using fully-qualified imports)
try:
    from skill.completion_signals import signal_phase_completed, signal_phase_failed
    from skill.memory_verifier import verify_exists, get_memory_path
except ImportError:
    # Fallback if not available yet
    signal_phase_completed = None
    signal_phase_failed = None
    verify_exists = None
    get_memory_path = None

# Import learning trigger (optional - for develop-learnings)
try:
    from learning_trigger import (
        should_trigger_learnings,
        format_trigger_prompt,
        build_learnings_directive,
    )
    from episode_store_helper import create_episode_from_skill_state
    LEARNING_TRIGGER_AVAILABLE = True
except ImportError:
    LEARNING_TRIGGER_AVAILABLE = False

# Skills that bypass goal-memory and develop-learnings invocations
# for performance optimization (these workflows don't benefit from metacognitive hooks)
SKILLS_BYPASSING_METACOGNITIVE_HOOKS = frozenset([
    # Currently no skills bypass metacognitive hooks
])


def parse_args() -> argparse.Namespace:
    """Parse common arguments for agent completion."""
    parser = argparse.ArgumentParser(description="Complete agent execution")
    parser.add_argument("--state", required=True, help="Path to state file")
    parser.add_argument("--task-id", help="Task ID (overrides state)")
    parser.add_argument("--phase-id", help="Phase ID (overrides state)")
    parser.add_argument("--skip-goal-memory", action="store_true",
                        help="Skip GoalMemory assessment (for goal-memory-agent itself)")
    return parser.parse_args()


# --- GoalMemory Integration ---

def invoke_goal_memory(state: AgentExecutionState, agent_name: str) -> Dict[str, Any]:
    """
    Invoke GoalMemory agent to assess workflow state.

    Prints assessment request for LLM processing.
    Returns metadata dict indicating invocation.
    """
    task_id = state.task_id
    phase_id = state.phase_id or "standalone"
    skill_name = state.skill_name or "standalone"

    # Get agent output summary (from last step output)
    last_step = max(state.step_outputs.keys()) if state.step_outputs else 0
    agent_output = state.step_outputs.get(last_step, {})
    agent_output_summary = str(agent_output)[:1500]  # Truncate to ~500 tokens

    # Get previous goal state from state metadata
    previous_goal_state = state.metadata.get("goal_state", "No previous state")

    # Get workflow metrics
    workflow_metrics = {
        "phases_completed": state.metadata.get("phases_completed", []),
        "unknowns_resolved": state.metadata.get("unknowns_resolved", 0),
        "unknowns_pending": state.metadata.get("unknowns_pending", 0),
        "remediation_loops": state.metadata.get("remediation_loops", 0),
    }

    # Minimal GoalMemory request
    print(f"Invoke memory agent via Task tool with subagent_type: `memory`")

    return {"goal_memory_invoked": True, "invoked_at": datetime.now().isoformat()}


def agent_complete(agent_name: str) -> None:
    """
    Common completion logic for all agents.

    1. Loads and validates execution state
    2. Verifies memory file exists if in skill context
    3. Writes completion signal
    4. Outputs minimal completion message

    Args:
        agent_name: Name of the agent (e.g., "clarification")
    """
    args = parse_args()

    state = AgentExecutionState.load(Path(args.state))
    if not state:
        print(f"ERROR: Could not load state from {args.state}", file=sys.stderr)
        sys.exit(1)

    config = get_agent_config(agent_name)
    if not config:
        print(f"ERROR: Agent '{agent_name}' not found", file=sys.stderr)
        sys.exit(1)

    # Get task and phase IDs (allow override from args)
    task_id = args.task_id or state.task_id
    phase_id = args.phase_id or state.phase_id

    # Validate all steps completed
    total_steps = len(config["steps"])
    completed_steps = len(state.completed_steps)

    if completed_steps < total_steps:
        missing = [i for i in range(total_steps) if i not in state.completed_steps]
        print(f"ERROR: Incomplete - {completed_steps}/{total_steps} steps", file=sys.stderr)
        print(f"Missing: {missing}", file=sys.stderr)
        sys.exit(1)

    # Verify memory file if we're in a skill context
    if state.skill_name and verify_exists:
        if not verify_exists(task_id, agent_name):
            memory_path = get_memory_path(task_id, agent_name) if get_memory_path else "unknown"
            print(f"ERROR: Memory file missing: {memory_path}", file=sys.stderr)
            print("Agent must write memory file before completion.", file=sys.stderr)

            # Write failure signal
            if signal_phase_failed and phase_id:
                signal_phase_failed(
                    task_id=task_id,
                    phase_id=phase_id,
                    agent_name=agent_name,
                    error="Memory file not created",
                )
            sys.exit(1)

    # Write completion signal if in skill context
    if state.skill_name and phase_id and signal_phase_completed:
        signal_phase_completed(
            task_id=task_id,
            phase_id=phase_id,
            agent_name=agent_name,
        )

    # Invoke GoalMemory after agent completion
    # Skip only if: this IS the memory agent, flag is explicitly set,
    # or the skill is in the bypass list (for performance optimization)
    # Note: Now triggers for ALL agent completions (skill context or standalone)
    # per requirement that all skill invocations trigger metacognitive hooks
    skill_bypasses_hooks = state.skill_name in SKILLS_BYPASSING_METACOGNITIVE_HOOKS
    # Normalize agent name for comparison (supports both "memory" and "memory")
    normalized_agent = normalize_agent_name(agent_name)
    if (normalized_agent != "memory" and
        not args.skip_goal_memory and
        not skill_bypasses_hooks):
        invoke_goal_memory(state, agent_name)

    # Develop-Learnings trigger for agent completions
    # Skip for memory agent (metacognitive, not task work)
    # Skip for skills in bypass list (for performance optimization)
    # ALWAYS ask the user (not conditional on learning trigger)
    if (normalized_agent != "memory" and
        LEARNING_TRIGGER_AVAILABLE and
        not skill_bypasses_hooks):
        try:
            episode = create_episode_from_skill_state(
                task_id=task_id,
                skill_name=state.skill_name or "standalone-agent",
                task_description=f"{config['cognitive_function']} agent task",
                domain=state.metadata.get("domain", "technical"),
                agents_invoked=[agent_name],
                outcome="success",
            )
            # Check criteria for enhanced reason (but always ask)
            should_learn, reason = should_trigger_learnings(episode)
            reason_text = reason if should_learn else None

            # Print AskUserQuestion directive - ALWAYS ask the user
            print()
            print(build_learnings_directive(task_id, reason_text))
        except Exception:
            # Don't fail completion due to learning trigger errors
            pass

    # Calculate duration
    start_time = datetime.fromisoformat(state.started_at)
    end_time = datetime.now()
    duration = end_time - start_time

    # Update state
    state.metadata["completed_at"] = end_time.isoformat()
    state.metadata["duration_seconds"] = duration.total_seconds()
    state.metadata["status"] = "complete"
    state.save()

    # Minimal output - just the completion marker
    print(f"**{agent_name.upper().replace('-', '_')}_COMPLETE**")
