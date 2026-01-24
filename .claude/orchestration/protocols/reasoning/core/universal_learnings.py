"""
universal_learnings.py
======================

Universal learning capture system for the orchestration system.

This module evaluates EVERY completed task (not just skills/agents) for
potential learning opportunities. This supports the core system principle
of being a self-learning system.

Key insight: While not EVERY task will result in learnings, we should
ALWAYS check for valuable learnings in the spirit of our primary system
principle as outlined in DA.md.

Integration points:
1. Reasoning protocol completion (complete.py)
2. Bypass mode completion
3. Skill/agent completions (existing learning_trigger.py)
"""

from __future__ import annotations

import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

# Path setup - navigate to protocols directory for fully-qualified imports
# This prevents collision between reasoning/config and skill/config
_CORE_DIR = Path(__file__).resolve().parent
_REASONING_ROOT = _CORE_DIR.parent
_PROTOCOLS_DIR = _REASONING_ROOT.parent
if str(_PROTOCOLS_DIR) not in sys.path:
    sys.path.insert(0, str(_PROTOCOLS_DIR))

from reasoning.core.state import ProtocolState


@dataclass
class TaskContext:
    """
    Lightweight task context for learning evaluation.

    Unlike Episode (which requires skill/agent context), TaskContext
    can be constructed from any completed task.
    """
    task_id: str
    user_query: str
    routing_decision: str  # skill-orchestration, dynamic-skill-sequencing, etc.
    step_outputs: Dict[str, Any]
    duration_seconds: float
    outcome: str  # success, partial, failure
    unknowns_identified: List[str]  # From Step 5 (Unknown Identification)
    assumptions_made: List[str]  # From Step 6 (Assumption Declaration)
    clarifications_needed: List[str]  # If HALT occurred
    domain: str  # From Step 2 (Domain Classification)
    complexity_score: float  # From Step 3 (Complexity Scoring)


# Learning evaluation thresholds
MIN_COMPLEXITY_FOR_LEARNING = 0.4  # Complexity threshold
MIN_UNKNOWNS_FOR_LEARNING = 1  # Unknowns that indicate discovery
MIN_ASSUMPTIONS_FOR_LEARNING = 2  # Assumptions worth documenting
SIGNIFICANT_DURATION_SECONDS = 120  # 2 minutes indicates substantial work


def extract_task_context(state: ProtocolState) -> TaskContext:
    """
    Extract TaskContext from a completed reasoning protocol state.

    Args:
        state: Completed protocol state

    Returns:
        TaskContext for learning evaluation
    """
    # Calculate duration from timestamps
    step_1_time = state.step_timestamps.get(1, {}).get("started_at")
    latest_time = None
    for step_data in state.step_timestamps.values():
        completed = step_data.get("completed_at")
        if completed:
            if latest_time is None or completed > latest_time:
                latest_time = completed

    duration = 0.0
    if step_1_time and latest_time:
        try:
            start = datetime.fromisoformat(step_1_time.replace("Z", "+00:00"))
            end = datetime.fromisoformat(latest_time.replace("Z", "+00:00"))
            duration = (end - start).total_seconds()
        except (ValueError, TypeError):
            pass

    # Extract from step outputs
    step_2 = state.step_outputs.get(2, {})
    step_3 = state.step_outputs.get(3, {})
    step_5 = state.step_outputs.get(5, {})
    step_6 = state.step_outputs.get(6, {})

    # Determine outcome
    outcome = "success"
    if state.fsm.is_halted():
        outcome = "halted"
    elif state.halt_reason:
        outcome = "partial"

    return TaskContext(
        task_id=state.session_id,
        user_query=state.user_query,
        routing_decision=state.routing_decision or "unknown",
        step_outputs=dict(state.step_outputs),
        duration_seconds=duration,
        outcome=outcome,
        unknowns_identified=step_5.get("unknowns", []),
        assumptions_made=step_6.get("assumptions", []),
        clarifications_needed=state.clarification_questions,
        domain=step_2.get("domain", "unknown"),
        complexity_score=step_3.get("complexity_score", 0.0),
    )


def should_evaluate_for_learnings(context: TaskContext) -> Tuple[bool, str]:
    """
    Determine if a completed task should be evaluated for learnings.

    This is a LIGHTWEIGHT check - we want to be inclusive since
    we're trying to build a self-learning system.

    Args:
        context: Task context to evaluate

    Returns:
        Tuple of (should_evaluate, reason)
    """
    reasons = []

    # Criterion 1: Significant complexity
    if context.complexity_score >= MIN_COMPLEXITY_FOR_LEARNING:
        reasons.append(f"significant complexity ({context.complexity_score:.2f})")

    # Criterion 2: Unknowns were identified (discovery occurred)
    if len(context.unknowns_identified) >= MIN_UNKNOWNS_FOR_LEARNING:
        reasons.append(f"unknowns identified ({len(context.unknowns_identified)})")

    # Criterion 3: Multiple assumptions documented (worth preserving)
    if len(context.assumptions_made) >= MIN_ASSUMPTIONS_FOR_LEARNING:
        reasons.append(f"assumptions documented ({len(context.assumptions_made)})")

    # Criterion 4: Substantial duration (indicates depth)
    if context.duration_seconds >= SIGNIFICANT_DURATION_SECONDS:
        reasons.append(f"substantial work ({context.duration_seconds:.0f}s)")

    # Criterion 5: Clarifications were needed (learning opportunity)
    if context.clarifications_needed:
        reasons.append(f"clarifications occurred ({len(context.clarifications_needed)})")

    # Criterion 6: Non-trivial routing (skill orchestration or dynamic)
    if context.routing_decision in ["skill-orchestration", "dynamic-skill-sequencing"]:
        reasons.append(f"skill-based execution ({context.routing_decision})")

    if reasons:
        return True, "; ".join(reasons)

    return False, "Task did not meet learning evaluation criteria"


def generate_learning_evaluation_prompt(context: TaskContext, reason: str) -> str:
    """
    Generate a prompt for the orchestrator to evaluate learnings from a task.

    This is NOT a directive to execute develop-learnings skill, but rather
    a prompt for the orchestrator to consider what was learned and whether formal
    capture is warranted.

    Args:
        context: Task context
        reason: Why evaluation was triggered

    Returns:
        Markdown prompt for learning evaluation
    """
    return f"""
## Learning Evaluation Checkpoint

**Task ID:** {context.task_id}
**Domain:** {context.domain}
**Route:** {context.routing_decision}
**Duration:** {context.duration_seconds:.0f}s
**Trigger Reason:** {reason}

### Reflection Questions

1. **What was discovered?** Did any unknown unknowns become known?
2. **What worked well?** Any approaches worth preserving as heuristics?
3. **What should be avoided?** Any anti-patterns identified?
4. **Cross-domain insights?** Anything applicable beyond this specific task?

### Decision

If this task produced VALUABLE, GENERALIZABLE insights:
- Consider invoking `/develop-learnings --source-task {context.task_id}`

If the insights are task-specific or trivial:
- Acknowledge internally and proceed

**Note:** Not every task needs formal learning capture. Only preserve
insights that will improve future task execution.
"""


def check_and_prompt_learnings(state: ProtocolState) -> Optional[str]:
    """
    Main entry point: Check if a completed state warrants learning evaluation.

    Args:
        state: Completed reasoning protocol state

    Returns:
        Learning evaluation prompt if warranted, None otherwise
    """
    context = extract_task_context(state)
    should_eval, reason = should_evaluate_for_learnings(context)

    if should_eval:
        return generate_learning_evaluation_prompt(context, reason)

    return None


# CLI for testing
if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Universal Learning Evaluation")
    parser.add_argument("--session", required=True, help="Session ID to evaluate")

    args = parser.parse_args()

    state = ProtocolState.load(args.session)
    if not state:
        print(f"ERROR: Could not load state for session {args.session}")
        sys.exit(1)

    prompt = check_and_prompt_learnings(state)
    if prompt:
        print(prompt)
    else:
        print("No learning evaluation warranted for this task.")
