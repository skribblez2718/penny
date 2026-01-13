"""
Episodic Memory Store
====================

Implements Soar-style episodic memory for pattern reuse across tasks.

Stores (task_embedding, agent_sequence, outcome) tuples for retrieval.
Integrates with existing learnings system (.claude/learnings/).

Storage:
- Episodes stored in .claude/orchestration/protocols/skill/episodes/
- JSON files with embeddings and metadata
"""

from __future__ import annotations

import json
import hashlib
from collections import Counter
from dataclasses import dataclass, asdict
from datetime import datetime
from pathlib import Path
from typing import List, Dict, Any, Optional, Tuple

# Configuration
EPISODE_DIR = Path(__file__).parent / "episodes"
MAX_EPISODES = 500  # Limit to prevent unbounded growth


@dataclass
class Episode:
    """Single episode capturing a completed workflow."""
    episode_id: str
    task_id: str
    timestamp: str
    skill_name: str
    task_description: str
    task_keywords: List[str]
    agent_sequence: List[str]
    outcome: str  # success | partial | failure
    context_type: str
    unknowns_resolved: List[str]
    key_decisions: List[str]
    lessons_learned: str

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict) -> "Episode":
        return cls(**data)


def ensure_episode_dir():
    """Ensure episode directory exists."""
    EPISODE_DIR.mkdir(parents=True, exist_ok=True)


def generate_episode_id(task_id: str, skill_name: str) -> str:
    """Generate unique episode ID."""
    content = f"{task_id}:{skill_name}:{datetime.now().isoformat()}"
    return hashlib.sha256(content.encode()).hexdigest()[:12]


def get_episode_file() -> Path:
    """Get path to episode store file."""
    ensure_episode_dir()
    return EPISODE_DIR / "episode_store.json"


def load_all_episodes() -> List[Episode]:
    """Load all stored episodes."""
    episode_file = get_episode_file()
    if not episode_file.exists():
        return []

    try:
        data = json.loads(episode_file.read_text())
        return [Episode.from_dict(e) for e in data.get("episodes", [])]
    except (json.JSONDecodeError, KeyError):
        return []


def save_episode(episode: Episode, check_graduation: bool = True) -> None:
    """
    Save a new episode.

    Args:
        episode: Episode to save
        check_graduation: If True, check if graduation to learnings should run
    """
    episodes = load_all_episodes()

    # Check for duplicates
    if any(e.episode_id == episode.episode_id for e in episodes):
        return  # Already exists

    episodes.append(episode)

    # Enforce max episodes (remove oldest)
    if len(episodes) > MAX_EPISODES:
        episodes = episodes[-MAX_EPISODES:]

    # Save updated store
    episode_file = get_episode_file()
    data = {
        "last_updated": datetime.now().isoformat(),
        "episode_count": len(episodes),
        "episodes": [e.to_dict() for e in episodes],
    }
    episode_file.write_text(json.dumps(data, indent=2))

    # Check if graduation should run (every GRADUATION_INTERVAL episodes)
    if check_graduation and len(episodes) % GRADUATION_INTERVAL == 0:
        # Run graduation check asynchronously (non-blocking)
        try:
            run_graduation_check()
        except Exception:
            pass  # Don't fail episode storage due to graduation errors


def compute_similarity(keywords1: List[str], keywords2: List[str]) -> float:
    """Compute Jaccard similarity between keyword sets."""
    if not keywords1 or not keywords2:
        return 0.0
    set1 = set(k.lower() for k in keywords1)
    set2 = set(k.lower() for k in keywords2)
    intersection = len(set1 & set2)
    union = len(set1 | set2)
    return intersection / union if union > 0 else 0.0


def extract_keywords(text: str, max_keywords: int = 10) -> List[str]:
    """
    Extract keywords from text.

    Simple extraction: split on spaces, filter stopwords, take top N.
    """
    stopwords = {
        "the", "a", "an", "is", "are", "to", "for", "and", "or", "in", "on",
        "with", "of", "by", "from", "as", "at", "this", "that", "these", "those",
        "be", "been", "being", "have", "has", "had", "do", "does", "did",
        "will", "would", "could", "should", "may", "might", "must", "shall",
        "can", "need", "want", "use", "using", "used", "make", "making", "made",
        "it", "its", "i", "we", "you", "they", "he", "she", "my", "our", "your",
    }

    # Clean and tokenize
    import re
    words = re.findall(r'\b[a-zA-Z]+\b', text.lower())

    # Filter and take top keywords
    keywords = [w for w in words if w not in stopwords and len(w) > 3]

    # Count frequencies and take most common
    word_counts = Counter(keywords)
    return [word for word, _ in word_counts.most_common(max_keywords)]


def retrieve_similar_episodes(
    task_keywords: List[str],
    skill_name: Optional[str] = None,
    context_type: Optional[str] = None,
    min_similarity: float = 0.3,
    max_results: int = 5
) -> List[Tuple[Episode, float]]:
    """
    Retrieve episodes similar to current task.

    Returns list of (episode, similarity_score) tuples.
    """
    episodes = load_all_episodes()

    # Filter by skill if specified
    if skill_name:
        episodes = [e for e in episodes if e.skill_name == skill_name]

    # Filter by context type if specified
    if context_type:
        episodes = [e for e in episodes if e.context_type == context_type]

    # Compute similarities
    results = []
    for episode in episodes:
        sim = compute_similarity(task_keywords, episode.task_keywords)
        if sim >= min_similarity:
            results.append((episode, sim))

    # Sort by similarity, take top results
    results.sort(key=lambda x: x[1], reverse=True)
    return results[:max_results]


def get_pattern_recommendations(similar_episodes: List[Tuple[Episode, float]]) -> Dict[str, Any]:
    """
    Generate recommendations from similar episodes.

    Returns patterns to apply to current task.
    """
    if not similar_episodes:
        return {"has_recommendations": False}

    # Find most common successful sequences
    successful = [e for e, _ in similar_episodes if e.outcome == "success"]

    if not successful:
        return {"has_recommendations": False}

    # Get agent sequence patterns
    sequences = [tuple(e.agent_sequence) for e in successful]
    seq_counts = Counter(sequences)
    most_common_seq = seq_counts.most_common(1)[0][0] if seq_counts else []

    # Collect lessons learned
    lessons = [e.lessons_learned for e in successful if e.lessons_learned]

    # Collect key decisions
    all_decisions = []
    for e in successful:
        all_decisions.extend(e.key_decisions)
    decision_counts = Counter(all_decisions)
    common_decisions = [d for d, _ in decision_counts.most_common(3)]

    return {
        "has_recommendations": True,
        "recommended_sequence": list(most_common_seq),
        "prior_lessons": lessons[:3],  # Top 3 lessons
        "common_decisions": common_decisions,
        "similar_count": len(successful),
    }


def format_episodic_recommendations(
    task_description: str,
    skill_name: str,
    context_type: str
) -> str:
    """
    Format episodic memory recommendations for inclusion in workflow.

    Returns markdown string to inject into task start.
    """
    keywords = extract_keywords(task_description)

    similar = retrieve_similar_episodes(
        keywords,
        skill_name=skill_name,
        context_type=context_type
    )

    if not similar:
        return ""

    recs = get_pattern_recommendations(similar)

    if not recs["has_recommendations"]:
        return ""

    content = "\n## Episodic Memory Recommendations\n\n"
    content += f"Found {recs['similar_count']} similar successful episodes.\n\n"

    if recs["recommended_sequence"]:
        content += f"**Recommended Agent Sequence:** {' -> '.join(recs['recommended_sequence'])}\n\n"

    if recs["prior_lessons"]:
        content += "**Prior Lessons:**\n"
        for lesson in recs["prior_lessons"]:
            content += f"- {lesson}\n"
        content += "\n"

    if recs["common_decisions"]:
        content += "**Common Successful Decisions:**\n"
        for decision in recs["common_decisions"]:
            content += f"- {decision}\n"

    return content


# Graduation configuration
GRADUATION_INTERVAL = 25  # Check for graduation every N episodes
GRADUATION_THRESHOLD = 10  # Minimum episodes for a pattern to graduate


def export_patterns_to_learnings(
    cognitive_function: str,
    min_episodes: int = 10
) -> Optional[Path]:
    """
    Export successful patterns from episodes to learnings.

    Creates/updates heuristics based on episode patterns.
    Returns path to created file, or None if insufficient data.
    """
    episodes = load_all_episodes()

    # Filter successful episodes with this cognitive function in sequence
    relevant = [
        e for e in episodes
        if e.outcome == "success" and cognitive_function in str(e.agent_sequence)
    ]

    if len(relevant) < min_episodes:
        return None  # Not enough data

    # Extract patterns
    lessons = [e.lessons_learned for e in relevant if e.lessons_learned]
    all_decisions = []
    for e in relevant:
        all_decisions.extend(e.key_decisions)

    # Count decision patterns
    decision_counts = Counter(all_decisions)

    # Extract agent sequence patterns
    sequence_counts = Counter(tuple(e.agent_sequence) for e in relevant)

    # Extract skill patterns
    skill_counts = Counter(e.skill_name for e in relevant)

    # Write to learnings file
    learnings_dir = Path(__file__).parent.parent.parent / "learnings" / cognitive_function
    learnings_dir.mkdir(parents=True, exist_ok=True)

    heuristics_file = learnings_dir / "episodic-patterns.md"

    content = f"# Episodic Patterns for {cognitive_function}\n\n"
    content += "> **Source:** episodic-derived (auto-generated from episode patterns)\n"
    content += f"> **Episodes analyzed:** {len(relevant)}\n"
    content += f"> **Last updated:** {datetime.now().isoformat()}\n\n"
    content += "---\n\n"

    # Heuristics section (matching develop-learnings format)
    content += "## Heuristics\n\n"
    content += "### Agent Sequence Patterns\n\n"
    if sequence_counts:
        content += "Most successful agent sequences for this cognitive function:\n\n"
        for seq, count in sequence_counts.most_common(5):
            pct = (count / len(relevant)) * 100
            content += f"- `{' -> '.join(seq)}` ({count} episodes, {pct:.0f}% success rate)\n"
    else:
        content += "- No sequence patterns captured yet\n"
    content += "\n"

    content += "### Skill Usage Patterns\n\n"
    if skill_counts:
        for skill, count in skill_counts.most_common(5):
            pct = (count / len(relevant)) * 100
            content += f"- **{skill}**: {count} successful episodes ({pct:.0f}%)\n"
    else:
        content += "- No skill patterns captured yet\n"
    content += "\n"

    # Lessons learned section
    content += "## Lessons Learned\n\n"
    if lessons:
        unique_lessons = list(dict.fromkeys(lessons))  # Remove duplicates, preserve order
        for lesson in unique_lessons[:10]:
            content += f"- {lesson}\n"
    else:
        content += "- No lessons captured yet\n"
    content += "\n"

    # Decisions section
    content += "## Frequent Successful Decisions\n\n"
    if decision_counts:
        for decision, count in decision_counts.most_common(10):
            content += f"- {decision} (seen in {count} episodes)\n"
    else:
        content += "- No decisions captured yet\n"
    content += "\n"

    # Anti-patterns section (from failures with same keywords)
    failure_episodes = [
        e for e in load_all_episodes()
        if e.outcome == "failure" and cognitive_function in str(e.agent_sequence)
    ]
    content += "## Anti-Patterns (from failures)\n\n"
    if failure_episodes:
        failure_sequences = Counter(tuple(e.agent_sequence) for e in failure_episodes)
        content += "Sequences that tend to fail:\n\n"
        for seq, count in failure_sequences.most_common(3):
            content += f"- `{' -> '.join(seq)}` ({count} failures)\n"
    else:
        content += "- No failure patterns captured yet (good!)\n"

    heuristics_file.write_text(content)
    return heuristics_file


def should_run_graduation_check() -> bool:
    """
    Check if graduation check should run.

    Returns True every GRADUATION_INTERVAL episodes.
    """
    episodes = load_all_episodes()
    episode_count = len(episodes)

    if episode_count == 0:
        return False

    # Check every GRADUATION_INTERVAL episodes
    return episode_count % GRADUATION_INTERVAL == 0


def run_graduation_check() -> List[Path]:
    """
    Run graduation check across all cognitive functions.

    Checks if any patterns should graduate to learnings.
    Returns list of paths to created/updated files.
    """
    cognitive_functions = [
        "clarification",
        "research",
        "analysis",
        "synthesis",
        "generation",
        "validation",
    ]

    created_files = []

    for func in cognitive_functions:
        result = export_patterns_to_learnings(func, min_episodes=GRADUATION_THRESHOLD)
        if result:
            created_files.append(result)

    return created_files


def get_graduation_candidates() -> List[Dict[str, Any]]:
    """
    Find patterns that appear frequently enough to become learnings.

    Returns list of candidate patterns with:
    - cognitive_function
    - pattern_type (heuristic/anti-pattern/checklist)
    - evidence_count
    - pattern_description
    """
    episodes = load_all_episodes()
    candidates = []

    # Analyze by cognitive function
    cognitive_functions = [
        "clarification", "research", "analysis",
        "synthesis", "generation", "validation",
    ]

    for func in cognitive_functions:
        # Find episodes involving this function
        relevant = [
            e for e in episodes
            if func in str(e.agent_sequence).lower()
        ]

        if len(relevant) < GRADUATION_THRESHOLD:
            continue

        # Find successful patterns
        successful = [e for e in relevant if e.outcome == "success"]
        failed = [e for e in relevant if e.outcome == "failure"]

        # Agent sequence heuristics
        if successful:
            seq_counts = Counter(tuple(e.agent_sequence) for e in successful)
            for seq, count in seq_counts.most_common(3):
                if count >= GRADUATION_THRESHOLD // 2:  # At least half threshold
                    candidates.append({
                        "cognitive_function": func,
                        "pattern_type": "heuristic",
                        "evidence_count": count,
                        "pattern_description": f"Agent sequence: {' -> '.join(seq)}",
                    })

        # Anti-patterns from failures
        if failed:
            failure_counts = Counter(tuple(e.agent_sequence) for e in failed)
            for seq, count in failure_counts.most_common(3):
                if count >= 3:  # At least 3 failures
                    candidates.append({
                        "cognitive_function": func,
                        "pattern_type": "anti-pattern",
                        "evidence_count": count,
                        "pattern_description": f"Failing sequence: {' -> '.join(seq)}",
                    })

    return candidates


def get_episode_statistics() -> Dict[str, Any]:
    """Get overall statistics for the episode store."""
    episodes = load_all_episodes()

    if not episodes:
        return {"total_episodes": 0}

    outcomes = Counter(e.outcome for e in episodes)
    skills = Counter(e.skill_name for e in episodes)
    contexts = Counter(e.context_type for e in episodes)

    return {
        "total_episodes": len(episodes),
        "outcomes": dict(outcomes),
        "skills": dict(skills),
        "context_types": dict(contexts),
        "date_range": {
            "earliest": min(e.timestamp for e in episodes),
            "latest": max(e.timestamp for e in episodes),
        },
    }


# CLI interface
if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Episodic Memory CLI")
    subparsers = parser.add_subparsers(dest="command")

    # store command
    store_parser = subparsers.add_parser("store", help="Store an episode")
    store_parser.add_argument("--task-id", required=True)
    store_parser.add_argument("--skill", required=True)
    store_parser.add_argument("--description", required=True)
    store_parser.add_argument("--keywords", required=True, help="Comma-separated")
    store_parser.add_argument("--agents", required=True, help="Comma-separated")
    store_parser.add_argument("--outcome", required=True)
    store_parser.add_argument("--context", required=True)
    store_parser.add_argument("--lessons", default="")
    store_parser.add_argument("--decisions", default="", help="Comma-separated")
    store_parser.add_argument("--unknowns", default="", help="Comma-separated U-IDs")

    # search command
    search_parser = subparsers.add_parser("search", help="Search similar episodes")
    search_parser.add_argument("--keywords", required=True, help="Comma-separated")
    search_parser.add_argument("--skill", help="Filter by skill")
    search_parser.add_argument("--context", help="Filter by context")

    # stats command
    subparsers.add_parser("stats", help="Show episode statistics")

    # export command
    export_parser = subparsers.add_parser("export", help="Export patterns to learnings")
    export_parser.add_argument("--function", required=True, help="Cognitive function name")
    export_parser.add_argument("--min-episodes", type=int, default=10)

    # recommend command
    recommend_parser = subparsers.add_parser("recommend", help="Get recommendations for task")
    recommend_parser.add_argument("--description", required=True, help="Task description")
    recommend_parser.add_argument("--skill", required=True)
    recommend_parser.add_argument("--context", required=True)

    # graduate command
    subparsers.add_parser("graduate", help="Run graduation check across all functions")

    # candidates command
    subparsers.add_parser("candidates", help="Show patterns ready to graduate to learnings")

    args = parser.parse_args()

    if args.command == "store":
        episode = Episode(
            episode_id=generate_episode_id(args.task_id, args.skill),
            task_id=args.task_id,
            timestamp=datetime.now().isoformat(),
            skill_name=args.skill,
            task_description=args.description,
            task_keywords=args.keywords.split(","),
            agent_sequence=args.agents.split(","),
            outcome=args.outcome,
            context_type=args.context,
            unknowns_resolved=args.unknowns.split(",") if args.unknowns else [],
            key_decisions=args.decisions.split(",") if args.decisions else [],
            lessons_learned=args.lessons,
        )
        save_episode(episode)
        print(f"Stored episode {episode.episode_id}")

    elif args.command == "search":
        keywords = args.keywords.split(",")
        results = retrieve_similar_episodes(
            keywords,
            skill_name=args.skill,
            context_type=args.context
        )
        print(f"Found {len(results)} similar episodes:")
        for episode, sim in results:
            print(f"  - {episode.episode_id}: {episode.task_description[:50]}... (sim: {sim:.2f})")

    elif args.command == "stats":
        stats = get_episode_statistics()
        print(f"Total episodes: {stats.get('total_episodes', 0)}")

        if stats.get('total_episodes', 0) > 0:
            print("\nBy skill:")
            for skill, count in stats.get('skills', {}).items():
                print(f"  - {skill}: {count}")

            print("\nBy outcome:")
            for outcome, count in stats.get('outcomes', {}).items():
                print(f"  - {outcome}: {count}")

            print("\nBy context:")
            for ctx, count in stats.get('context_types', {}).items():
                print(f"  - {ctx}: {count}")

            date_range = stats.get('date_range', {})
            print(f"\nDate range: {date_range.get('earliest', 'N/A')} to {date_range.get('latest', 'N/A')}")

    elif args.command == "export":
        result = export_patterns_to_learnings(args.function, args.min_episodes)
        if result:
            print(f"Exported patterns to {result}")
        else:
            print(f"Not enough episodes (need >= {args.min_episodes})")

    elif args.command == "recommend":
        output = format_episodic_recommendations(
            args.description,
            args.skill,
            args.context
        )
        if output:
            print(output)
        else:
            print("No recommendations available (no similar episodes found)")

    elif args.command == "graduate":
        print("Running graduation check across all cognitive functions...")
        graduated = run_graduation_check()
        if graduated:
            print(f"Graduated patterns to {len(graduated)} learning files:")
            for path in graduated:
                print(f"  - {path}")
        else:
            print("No patterns ready for graduation (need more episodes)")

    elif args.command == "candidates":
        candidates = get_graduation_candidates()
        if candidates:
            print(f"Found {len(candidates)} patterns ready for graduation:")
            for c in candidates:
                print(f"  - [{c['pattern_type']}] {c['cognitive_function']}: {c['pattern_description']} ({c['evidence_count']} episodes)")
        else:
            print("No patterns ready for graduation yet")

    else:
        parser.print_help()
