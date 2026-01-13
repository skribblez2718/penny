"""
Learning Trigger Module
=======================

Determines when develop-learnings skill should be automatically triggered
based on episodic memory patterns.

All imports are ABSOLUTE - no relative imports allowed.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import List, Optional, Tuple

# Absolute path setup for imports
_TRIGGER_DIR = Path(__file__).resolve().parent
_ORCHESTRATION_DIR = _TRIGGER_DIR.parent

# Add orchestration directory to path for absolute imports
if str(_ORCHESTRATION_DIR) not in sys.path:
    sys.path.insert(0, str(_ORCHESTRATION_DIR))

# Absolute imports from skill package
from skill.episodic_memory import (
    Episode,
    retrieve_similar_episodes,
    load_all_episodes,
)


# Trigger thresholds
MIN_DURATION_SECONDS = 60  # 1 minute minimum for learning capture
MIN_UNKNOWNS_RESOLVED = 2  # Minimum unknowns to trigger
SIMILARITY_THRESHOLD = 0.3  # Minimum similarity for "similar" classification


def should_trigger_learnings(
    episode: Episode,
    prior_episodes: Optional[List[Episode]] = None,
) -> Tuple[bool, str]:
    """
    Determine if develop-learnings should be automatically triggered.

    Analyzes the completed episode against historical patterns to identify
    high-value learning opportunities.

    Args:
        episode: The newly completed episode
        prior_episodes: Optional list of prior episodes (loaded if not provided)

    Returns:
        Tuple of (should_trigger, reason)

    Trigger criteria:
    1. Novel pattern discovered (no similar successful episodes)
    2. Failure after prior successes (regression detected)
    3. New agent sequence discovered that succeeded
    4. User explicitly resolved multiple unknowns
    """
    if prior_episodes is None:
        prior_episodes = load_all_episodes()

    # Skip if this is the develop-learnings skill itself
    if episode.skill_name == "develop-learnings":
        return False, "develop-learnings skill - skip recursive trigger"

    # Criterion 1: Novel successful pattern
    novel, novel_reason = _check_novel_pattern(episode)
    if novel:
        return True, novel_reason

    # Criterion 2: Regression detection
    regression, regression_reason = _check_regression(episode)
    if regression:
        return True, regression_reason

    # Criterion 3: New agent sequence
    new_sequence, sequence_reason = _check_new_sequence(episode)
    if new_sequence:
        return True, sequence_reason

    # Criterion 4: Multiple unknowns resolved
    unknowns, unknowns_reason = _check_unknowns_resolved(episode)
    if unknowns:
        return True, unknowns_reason

    return False, "No learning trigger criteria met"


def _check_novel_pattern(episode: Episode) -> Tuple[bool, str]:
    """
    Check if this is a novel successful pattern worth capturing.

    A pattern is novel if:
    - Task succeeded
    - No similar episodes exist above similarity threshold
    """
    if episode.outcome != "success":
        return False, ""

    similar = retrieve_similar_episodes(
        task_keywords=episode.task_keywords,
        skill_name=episode.skill_name,
        min_similarity=SIMILARITY_THRESHOLD,
        max_results=5,
    )

    if not similar:
        return True, "Novel successful pattern discovered - no similar prior episodes"

    return False, ""


def _check_regression(episode: Episode) -> Tuple[bool, str]:
    """
    Check if this failure represents a regression from prior successes.

    A regression is detected when:
    - Current task failed
    - Similar tasks previously succeeded
    """
    if episode.outcome != "failure":
        return False, ""

    similar = retrieve_similar_episodes(
        task_keywords=episode.task_keywords,
        skill_name=episode.skill_name,
        min_similarity=SIMILARITY_THRESHOLD,
        max_results=10,
    )

    if not similar:
        return False, ""

    # Check if similar tasks succeeded before
    successful_similar = [e for e, _ in similar if e.outcome == "success"]

    if successful_similar:
        return True, f"Regression detected - similar tasks succeeded before ({len(successful_similar)} successes)"

    return False, ""


def _check_new_sequence(episode: Episode) -> Tuple[bool, str]:
    """
    Check if a new successful agent sequence was discovered.

    A new sequence is notable when:
    - Task succeeded
    - Agent sequence differs from prior similar tasks
    """
    if episode.outcome != "success":
        return False, ""

    if not episode.agent_sequence:
        return False, ""

    similar = retrieve_similar_episodes(
        task_keywords=episode.task_keywords,
        skill_name=episode.skill_name,
        min_similarity=SIMILARITY_THRESHOLD,
        max_results=10,
    )

    if not similar:
        return False, ""  # Novel pattern handled separately

    # Get known sequences from similar episodes
    known_sequences = set()
    for e, _ in similar:
        if e.agent_sequence:
            known_sequences.add(tuple(e.agent_sequence))

    current_sequence = tuple(episode.agent_sequence)

    if current_sequence not in known_sequences:
        return True, f"New successful agent sequence: {' -> '.join(episode.agent_sequence)}"

    return False, ""


def _check_unknowns_resolved(episode: Episode) -> Tuple[bool, str]:
    """
    Check if multiple unknowns were resolved during execution.

    Significant unknown resolution indicates valuable insights discovered.
    """
    if not episode.unknowns_resolved:
        return False, ""

    if len(episode.unknowns_resolved) >= MIN_UNKNOWNS_RESOLVED:
        return True, f"Multiple unknowns resolved ({len(episode.unknowns_resolved)}) - capture insights"

    return False, ""


def get_trigger_summary(episode: Episode) -> str:
    """
    Get a summary of trigger analysis for logging/debugging.

    Args:
        episode: Episode to analyze

    Returns:
        Multi-line summary string
    """
    should_trigger, reason = should_trigger_learnings(episode)

    lines = [
        "## Learning Trigger Analysis",
        "",
        f"**Episode:** {episode.episode_id}",
        f"**Skill:** {episode.skill_name}",
        f"**Outcome:** {episode.outcome}",
        f"**Keywords:** {', '.join(episode.task_keywords[:5])}",
        "",
    ]

    if should_trigger:
        lines.extend([
            "**Trigger Decision:** YES",
            f"**Reason:** {reason}",
            "",
            "Recommendation: Invoke develop-learnings to capture insights.",
        ])
    else:
        lines.extend([
            "**Trigger Decision:** NO",
            f"**Reason:** {reason}",
        ])

    return "\n".join(lines)


def format_trigger_prompt(episode: Episode, reason: str) -> str:
    """
    Format the prompt shown to user when learnings should be captured.

    Args:
        episode: The triggering episode
        reason: Why learnings should be captured

    Returns:
        Formatted markdown prompt
    """
    return f"""---

## Automatic Learning Capture Triggered

**Reason:** {reason}

This task contained valuable insights that should be preserved for future reference.

To capture learnings, run:

```
/develop-learnings --source-task {episode.task_id}
```

This will:
1. Analyze the completed task
2. Extract generalizable heuristics
3. Identify anti-patterns to avoid
4. Create reusable checklists
5. Store learnings in `${{CAII_DIRECTORY}}/.claude/learnings/`

---"""


def build_learnings_question(task_id: str, reason: Optional[str] = None) -> dict:
    """
    Build AskUserQuestion-compatible question for develop-learnings prompt.

    Args:
        task_id: The completed task ID
        reason: Optional reason from learning trigger criteria

    Returns:
        Question dict for AskUserQuestion tool
    """
    context = "Capture insights from this task for future reference."
    if reason:
        context = f"{reason}. {context}"

    return {
        "question": "Would you like to capture learnings from this task?",
        "header": "Learnings",
        "options": [
            {
                "label": "Yes, capture learnings",
                "description": f"Run develop-learnings skill to extract heuristics, anti-patterns, and checklists from task {task_id[:8]}..."
            },
            {
                "label": "No, skip this time",
                "description": "Continue without capturing learnings. Can run /develop-learnings manually later."
            }
        ],
        "multiSelect": False
    }


def build_learnings_directive(task_id: str, reason: Optional[str] = None) -> str:
    """
    Build complete AskUserQuestion invocation directive for learnings prompt.

    This generates the directive that the main orchestrator prints after
    task completion to ask the user about running develop-learnings.

    Args:
        task_id: The completed task ID
        reason: Optional reason from learning trigger criteria

    Returns:
        Formatted directive string for Claude to invoke AskUserQuestion
    """
    import json
    question = build_learnings_question(task_id, reason)
    questions_json = json.dumps({"questions": [question]}, indent=2)

    reason_text = f"**Trigger reason:** {reason}\n\n" if reason else ""

    return f"""
---

## Task Complete: Learnings Opportunity

{reason_text}You **MUST** invoke the `AskUserQuestion` tool to ask the user about capturing learnings:

```json
{questions_json}
```

**If user selects "Yes, capture learnings":**
- Invoke the Skill tool with: `skill: "develop-learnings", args: "--source-task {task_id}"`

**If user selects "No, skip this time":**
- Continue with normal workflow completion

---
"""


# CLI for testing
if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Learning Trigger CLI")
    subparsers = parser.add_subparsers(dest="command")

    # analyze command
    analyze_parser = subparsers.add_parser("analyze", help="Analyze an episode for trigger")
    analyze_parser.add_argument("--episode-id", required=True, help="Episode ID to analyze")

    # test command
    test_parser = subparsers.add_parser("test", help="Test trigger with mock data")
    test_parser.add_argument("--outcome", default="success", choices=["success", "failure", "partial"])
    test_parser.add_argument("--novel", action="store_true", help="Simulate novel pattern")

    args = parser.parse_args()

    if args.command == "analyze":
        all_episodes = load_all_episodes()
        target = next((e for e in all_episodes if e.episode_id == args.episode_id), None)

        if not target:
            print(f"Episode not found: {args.episode_id}")
            sys.exit(1)

        print(get_trigger_summary(target))

    elif args.command == "test":
        # Create mock episode for testing
        from datetime import datetime

        mock_episode = Episode(
            episode_id="test-mock-001",
            task_id="test-task-001",
            timestamp=datetime.now().isoformat(),
            skill_name="test-skill",
            task_description="Test task for trigger evaluation",
            task_keywords=["test", "trigger", "evaluation"],
            agent_sequence=["analysis", "synthesis"],
            outcome=args.outcome,
            context_type="technical",
            unknowns_resolved=[],
            key_decisions=[],
            lessons_learned="",
        )

        should_trigger, reason = should_trigger_learnings(mock_episode)
        print(f"Should trigger: {should_trigger}")
        print(f"Reason: {reason}")

        if should_trigger:
            print()
            print(format_trigger_prompt(mock_episode, reason))

    else:
        parser.print_help()
