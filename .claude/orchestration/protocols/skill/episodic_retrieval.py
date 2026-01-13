"""
Episodic Retrieval Module
=========================

Provides episodic memory retrieval for task start contexts.
Retrieves similar past episodes and generates recommendations
to inject into workflow start.

All imports are ABSOLUTE - no relative imports allowed.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import List, Optional, Tuple

# Absolute path setup for imports
_RETRIEVAL_DIR = Path(__file__).resolve().parent
_ORCHESTRATION_DIR = _RETRIEVAL_DIR.parent

# Add orchestration directory to path for absolute imports
if str(_ORCHESTRATION_DIR) not in sys.path:
    sys.path.insert(0, str(_ORCHESTRATION_DIR))

# Absolute imports from skill package
from skill.episodic_memory import (
    Episode,
    extract_keywords,
    retrieve_similar_episodes,
    get_pattern_recommendations,
    format_episodic_recommendations,
)


def get_episodic_context_for_task(
    task_description: str,
    skill_name: str,
    domain: str,
    min_similarity: float = 0.3,
    max_results: int = 5,
) -> str:
    """
    Get episodic memory context to inject at task start.

    Retrieves similar past episodes and formats recommendations
    for inclusion in the first agent's context.

    Args:
        task_description: Description of the new task
        skill_name: Name of the skill being invoked
        domain: Task domain (e.g., "technical", "research")
        min_similarity: Minimum similarity threshold (0-1)
        max_results: Maximum number of similar episodes to consider

    Returns:
        Formatted markdown string with recommendations, or empty string if none
    """
    return format_episodic_recommendations(
        task_description=task_description,
        skill_name=skill_name,
        context_type=domain,
    )


def get_similar_episodes_for_task(
    task_description: str,
    skill_name: Optional[str] = None,
    domain: Optional[str] = None,
    min_similarity: float = 0.3,
    max_results: int = 5,
) -> List[Tuple[Episode, float]]:
    """
    Get similar episodes for a task description.

    Args:
        task_description: Description of the new task
        skill_name: Optional filter by skill name
        domain: Optional filter by domain
        min_similarity: Minimum similarity threshold
        max_results: Maximum number of results

    Returns:
        List of (Episode, similarity_score) tuples
    """
    keywords = extract_keywords(task_description)

    return retrieve_similar_episodes(
        task_keywords=keywords,
        skill_name=skill_name,
        context_type=domain,
        min_similarity=min_similarity,
        max_results=max_results,
    )


def get_recommended_agent_sequence(
    task_description: str,
    skill_name: str,
) -> Optional[List[str]]:
    """
    Get recommended agent sequence based on similar successful episodes.

    Args:
        task_description: Description of the new task
        skill_name: Name of the skill being invoked

    Returns:
        List of agent names in recommended order, or None if no recommendation
    """
    keywords = extract_keywords(task_description)

    similar = retrieve_similar_episodes(
        task_keywords=keywords,
        skill_name=skill_name,
        min_similarity=0.3,
        max_results=10,
    )

    if not similar:
        return None

    recommendations = get_pattern_recommendations(similar)

    if recommendations.get("has_recommendations"):
        return recommendations.get("recommended_sequence")

    return None


def get_prior_lessons(
    task_description: str,
    skill_name: Optional[str] = None,
    max_lessons: int = 3,
) -> List[str]:
    """
    Get prior lessons from similar successful episodes.

    Args:
        task_description: Description of the new task
        skill_name: Optional filter by skill name
        max_lessons: Maximum number of lessons to return

    Returns:
        List of lesson strings from similar episodes
    """
    keywords = extract_keywords(task_description)

    similar = retrieve_similar_episodes(
        task_keywords=keywords,
        skill_name=skill_name,
        min_similarity=0.3,
        max_results=10,
    )

    if not similar:
        return []

    recommendations = get_pattern_recommendations(similar)

    if recommendations.get("has_recommendations"):
        return recommendations.get("prior_lessons", [])[:max_lessons]

    return []


def has_similar_episodes(
    task_description: str,
    skill_name: Optional[str] = None,
    min_similarity: float = 0.3,
) -> bool:
    """
    Check if there are similar episodes for a task.

    Useful for quick checks without full retrieval.

    Args:
        task_description: Description of the new task
        skill_name: Optional filter by skill name
        min_similarity: Minimum similarity threshold

    Returns:
        True if at least one similar episode exists
    """
    keywords = extract_keywords(task_description)

    similar = retrieve_similar_episodes(
        task_keywords=keywords,
        skill_name=skill_name,
        min_similarity=min_similarity,
        max_results=1,
    )

    return len(similar) > 0


def format_retrieval_summary(
    task_description: str,
    skill_name: str,
    domain: str,
) -> str:
    """
    Format a summary of episodic retrieval results.

    Provides a concise summary suitable for logging or debugging.

    Args:
        task_description: Description of the new task
        skill_name: Name of the skill being invoked
        domain: Task domain

    Returns:
        Summary string
    """
    keywords = extract_keywords(task_description)

    similar = retrieve_similar_episodes(
        task_keywords=keywords,
        skill_name=skill_name,
        context_type=domain,
        min_similarity=0.3,
        max_results=5,
    )

    if not similar:
        return "No similar episodes found."

    successful = sum(1 for e, _ in similar if e.outcome == "success")
    failed = sum(1 for e, _ in similar if e.outcome == "failure")

    summary = f"Found {len(similar)} similar episodes ({successful} successful, {failed} failed)."

    if successful > 0:
        best_match = similar[0]
        summary += f" Best match: {best_match[0].skill_name} (similarity: {best_match[1]:.0%})"

    return summary


# CLI for testing
if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Episodic Retrieval CLI")
    subparsers = parser.add_subparsers(dest="command")

    # retrieve command
    retrieve_parser = subparsers.add_parser("retrieve", help="Retrieve similar episodes")
    retrieve_parser.add_argument("--description", required=True, help="Task description")
    retrieve_parser.add_argument("--skill", help="Filter by skill")
    retrieve_parser.add_argument("--domain", help="Filter by domain")

    # recommend command
    recommend_parser = subparsers.add_parser("recommend", help="Get recommendations")
    recommend_parser.add_argument("--description", required=True, help="Task description")
    recommend_parser.add_argument("--skill", required=True, help="Skill name")
    recommend_parser.add_argument("--domain", default="technical", help="Domain")

    # summary command
    summary_parser = subparsers.add_parser("summary", help="Get retrieval summary")
    summary_parser.add_argument("--description", required=True, help="Task description")
    summary_parser.add_argument("--skill", required=True, help="Skill name")
    summary_parser.add_argument("--domain", default="technical", help="Domain")

    args = parser.parse_args()

    if args.command == "retrieve":
        similar = get_similar_episodes_for_task(
            args.description,
            skill_name=args.skill,
            domain=args.domain,
        )
        print(f"Found {len(similar)} similar episodes:")
        for episode, sim in similar:
            print(f"  - {episode.episode_id}: {episode.task_description[:50]}... (sim: {sim:.2f})")

    elif args.command == "recommend":
        context = get_episodic_context_for_task(
            args.description,
            args.skill,
            args.domain,
        )
        if context:
            print(context)
        else:
            print("No recommendations available.")

    elif args.command == "summary":
        summary = format_retrieval_summary(
            args.description,
            args.skill,
            args.domain,
        )
        print(summary)

    else:
        parser.print_help()
