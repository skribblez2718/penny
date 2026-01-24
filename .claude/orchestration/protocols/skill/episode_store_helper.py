"""
Episode Store Helper
====================

Helper functions to create and store episodes from workflow completion.
Provides easy-to-use interfaces for different execution paths.

All imports are ABSOLUTE - no relative imports allowed.
"""

from __future__ import annotations

import sys
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

# Absolute path setup for imports
_EPISODE_HELPER_DIR = Path(__file__).resolve().parent
_ORCHESTRATION_DIR = _EPISODE_HELPER_DIR.parent

# Add orchestration directory to path for absolute imports
if str(_ORCHESTRATION_DIR) not in sys.path:
    sys.path.insert(0, str(_ORCHESTRATION_DIR))

# Absolute imports from skill package
from skill.episodic_memory import (
    Episode,
    save_episode,
    generate_episode_id,
    extract_keywords,
    load_all_episodes,
)


def create_episode_from_skill_state(
    task_id: str,
    skill_name: str,
    task_description: str,
    domain: str,
    agents_invoked: List[str],
    outcome: str = "success",
    unknowns_resolved: Optional[List[str]] = None,
    key_decisions: Optional[List[str]] = None,
    lessons_learned: str = "",
) -> Episode:
    """
    Create an episode from skill execution completion.

    Args:
        task_id: Unique task identifier
        skill_name: Name of the skill executed (e.g., "develop-project")
        task_description: Description of what the task was
        domain: Task domain (e.g., "technical", "research")
        agents_invoked: List of agents that were invoked
        outcome: Task outcome ("success", "partial", "failure")
        unknowns_resolved: List of Unknown IDs that were resolved
        key_decisions: List of key decisions made during execution
        lessons_learned: Brief lesson from this execution

    Returns:
        Episode object ready to be saved
    """
    return Episode(
        episode_id=generate_episode_id(task_id, skill_name),
        task_id=task_id,
        timestamp=datetime.now().isoformat(),
        skill_name=skill_name,
        task_description=task_description,
        task_keywords=extract_keywords(task_description),
        agent_sequence=agents_invoked,
        outcome=outcome,
        context_type=domain,
        unknowns_resolved=unknowns_resolved or [],
        key_decisions=key_decisions or [],
        lessons_learned=lessons_learned,
    )


def create_episode_from_dynamic_sequencing(
    task_id: str,
    task_description: str,
    skills_invoked: List[str],
    outcome: str = "success",
    key_decisions: Optional[List[str]] = None,
) -> Episode:
    """
    Create an episode from dynamic skill sequencing execution.

    Used when multiple orchestrate-* skills are invoked in sequence.

    Args:
        task_id: Unique task identifier
        task_description: Description of what the task was
        skills_invoked: List of orchestrate-* skills that were invoked
        outcome: Task outcome ("success", "partial", "failure")
        key_decisions: List of key decisions made during execution

    Returns:
        Episode object ready to be saved
    """
    return Episode(
        episode_id=generate_episode_id(task_id, "dynamic-sequencing"),
        task_id=task_id,
        timestamp=datetime.now().isoformat(),
        skill_name="dynamic-sequencing",
        task_description=task_description,
        task_keywords=extract_keywords(task_description),
        agent_sequence=skills_invoked,
        outcome=outcome,
        context_type="dynamic",
        unknowns_resolved=[],
        key_decisions=key_decisions or [],
        lessons_learned="",
    )


def store_skill_episode(
    task_id: str,
    skill_name: str,
    task_description: str,
    domain: str,
    agents_invoked: List[str],
    outcome: str = "success",
    **kwargs: Any,
) -> str:
    """
    Convenience function to create and store an episode in one call.

    Args:
        task_id: Unique task identifier
        skill_name: Name of the skill executed
        task_description: Description of what the task was
        domain: Task domain
        agents_invoked: List of agents that were invoked
        outcome: Task outcome
        **kwargs: Additional episode fields (unknowns_resolved, key_decisions, lessons_learned)

    Returns:
        Episode ID of the stored episode
    """
    episode = create_episode_from_skill_state(
        task_id=task_id,
        skill_name=skill_name,
        task_description=task_description,
        domain=domain,
        agents_invoked=agents_invoked,
        outcome=outcome,
        unknowns_resolved=kwargs.get("unknowns_resolved"),
        key_decisions=kwargs.get("key_decisions"),
        lessons_learned=kwargs.get("lessons_learned", ""),
    )

    save_episode(episode)
    return episode.episode_id


def store_dynamic_episode(
    task_id: str,
    task_description: str,
    skills_invoked: List[str],
    outcome: str = "success",
    key_decisions: Optional[List[str]] = None,
) -> str:
    """
    Convenience function to store a dynamic sequencing episode.

    Args:
        task_id: Unique task identifier
        task_description: Description of what the task was
        skills_invoked: List of orchestrate-* skills invoked
        outcome: Task outcome
        key_decisions: List of key decisions made

    Returns:
        Episode ID of the stored episode
    """
    episode = create_episode_from_dynamic_sequencing(
        task_id=task_id,
        task_description=task_description,
        skills_invoked=skills_invoked,
        outcome=outcome,
        key_decisions=key_decisions,
    )

    save_episode(episode)
    return episode.episode_id


def get_episode_count() -> int:
    """Get the current number of stored episodes."""
    return len(load_all_episodes())


# CLI for testing
if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Episode Store Helper CLI")
    subparsers = parser.add_subparsers(dest="command")

    # test command
    test_parser = subparsers.add_parser("test", help="Store a test episode")
    test_parser.add_argument("--description", default="Test task for episode storage")

    # count command
    subparsers.add_parser("count", help="Show episode count")

    args = parser.parse_args()

    if args.command == "test":
        episode_id = store_skill_episode(
            task_id=f"test-{datetime.now().strftime('%Y%m%d%H%M%S')}",
            skill_name="test-skill",
            task_description=args.description,
            domain="technical",
            agents_invoked=["analysis", "synthesis"],
            outcome="success",
        )
        print(f"Stored test episode: {episode_id}")
        print(f"Total episodes: {get_episode_count()}")

    elif args.command == "count":
        print(f"Total episodes: {get_episode_count()}")

    else:
        parser.print_help()
