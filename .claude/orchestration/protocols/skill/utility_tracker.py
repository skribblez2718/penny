"""
Utility Tracking System
======================

Implements ACT-R-style utility learning for agent/skill routing optimization.

Key Concepts (from ACT-R):
- Utility = P × G - C
  - P = Probability of success
  - G = Goal value (constant, e.g., 1.0)
  - C = Cost (tokens used, time taken)

Storage:
- Utility logs stored in .claude/orchestration/protocols/skill/utility_logs/
- JSON files per routing context (skill + agent combinations)
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field, asdict
from datetime import datetime
from pathlib import Path
from typing import Optional, List, Dict, Any

# Configuration
UTILITY_LOG_DIR = Path(__file__).parent / "utility_logs"
GOAL_VALUE = 1.0  # Constant goal value
TOKEN_COST_WEIGHT = 0.0001  # Cost per token
TIME_COST_WEIGHT = 0.01  # Cost per second


@dataclass
class UtilityEvent:
    """Single routing outcome for utility learning."""
    task_id: str
    timestamp: str
    skill_name: str
    agent_sequence: List[str]
    outcome: str  # success | partial | failure
    total_tokens: int
    total_time_seconds: float
    context_type: str  # technical | personal | creative | professional | recreational
    remediation_loops: int

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict) -> "UtilityEvent":
        return cls(**data)


@dataclass
class UtilityScore:
    """Computed utility score for a routing context."""
    routing_key: str  # e.g., "develop-project:generation-agent:technical"
    success_rate: float
    avg_cost: float
    utility: float
    sample_count: int
    last_updated: str


def ensure_log_dir():
    """Ensure utility log directory exists."""
    UTILITY_LOG_DIR.mkdir(parents=True, exist_ok=True)


def get_log_file_path(skill_name: str) -> Path:
    """Get path to utility log file for a skill."""
    ensure_log_dir()
    return UTILITY_LOG_DIR / f"{skill_name.replace('-', '_')}_utility.json"


def load_utility_log(skill_name: str) -> List[UtilityEvent]:
    """Load utility events for a skill."""
    log_file = get_log_file_path(skill_name)
    if not log_file.exists():
        return []

    try:
        data = json.loads(log_file.read_text())
        return [UtilityEvent.from_dict(e) for e in data.get("events", [])]
    except (json.JSONDecodeError, KeyError):
        return []


def save_utility_event(event: UtilityEvent) -> None:
    """Save a new utility event."""
    log_file = get_log_file_path(event.skill_name)

    # Load existing events
    events = load_utility_log(event.skill_name)
    events.append(event)

    # Save updated log
    data = {
        "skill_name": event.skill_name,
        "last_updated": datetime.now().isoformat(),
        "event_count": len(events),
        "events": [e.to_dict() for e in events],
    }
    log_file.write_text(json.dumps(data, indent=2))


def compute_utility(
    events: List[UtilityEvent],
    agent_name: Optional[str] = None,
    context_type: Optional[str] = None
) -> UtilityScore:
    """
    Compute utility score from events.

    Implements ACT-R formula: U = P × G - C
    """
    # Filter events if criteria provided
    filtered = events
    if agent_name:
        filtered = [e for e in filtered if agent_name in e.agent_sequence]
    if context_type:
        filtered = [e for e in filtered if e.context_type == context_type]

    if not filtered:
        return UtilityScore(
            routing_key=f"{agent_name or 'all'}:{context_type or 'all'}",
            success_rate=0.5,  # Prior
            avg_cost=0.0,
            utility=0.5,  # Neutral prior
            sample_count=0,
            last_updated=datetime.now().isoformat(),
        )

    # Calculate success rate (P)
    successes = sum(1 for e in filtered if e.outcome == "success")
    success_rate = successes / len(filtered)

    # Calculate average cost (C)
    total_cost = sum(
        e.total_tokens * TOKEN_COST_WEIGHT + e.total_time_seconds * TIME_COST_WEIGHT
        for e in filtered
    )
    avg_cost = total_cost / len(filtered)

    # Calculate utility
    utility = success_rate * GOAL_VALUE - avg_cost

    return UtilityScore(
        routing_key=f"{agent_name or 'all'}:{context_type or 'all'}",
        success_rate=success_rate,
        avg_cost=avg_cost,
        utility=utility,
        sample_count=len(filtered),
        last_updated=datetime.now().isoformat(),
    )


def get_routing_recommendation(
    skill_name: str,
    context_type: str
) -> Dict[str, float]:
    """
    Get utility-based routing recommendations.

    Returns dict of agent -> utility score.
    """
    events = load_utility_log(skill_name)

    if len(events) < 5:
        return {}  # Not enough data for recommendations

    agents = set()
    for e in events:
        agents.update(e.agent_sequence)

    recommendations = {}
    for agent in agents:
        score = compute_utility(events, agent_name=agent, context_type=context_type)
        recommendations[agent] = score.utility

    return recommendations


def get_skill_statistics(skill_name: str) -> Dict[str, Any]:
    """Get overall statistics for a skill's utility history."""
    events = load_utility_log(skill_name)

    if not events:
        return {"total_events": 0}

    outcomes = {}
    for e in events:
        outcomes[e.outcome] = outcomes.get(e.outcome, 0) + 1

    context_counts = {}
    for e in events:
        context_counts[e.context_type] = context_counts.get(e.context_type, 0) + 1

    return {
        "total_events": len(events),
        "outcomes": outcomes,
        "context_types": context_counts,
        "avg_tokens": sum(e.total_tokens for e in events) / len(events),
        "avg_time_seconds": sum(e.total_time_seconds for e in events) / len(events),
        "avg_remediation_loops": sum(e.remediation_loops for e in events) / len(events),
    }


# CLI interface
if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Utility Tracking CLI")
    subparsers = parser.add_subparsers(dest="command")

    # log command
    log_parser = subparsers.add_parser("log", help="Log a utility event")
    log_parser.add_argument("--task-id", required=True)
    log_parser.add_argument("--skill", required=True)
    log_parser.add_argument("--agents", required=True, help="Comma-separated agent list")
    log_parser.add_argument("--outcome", required=True, choices=["success", "partial", "failure"])
    log_parser.add_argument("--tokens", type=int, required=True)
    log_parser.add_argument("--time", type=float, required=True)
    log_parser.add_argument("--context", required=True)
    log_parser.add_argument("--remediation", type=int, default=0)

    # score command
    score_parser = subparsers.add_parser("score", help="Get utility scores")
    score_parser.add_argument("--skill", required=True)
    score_parser.add_argument("--agent", help="Filter by agent")
    score_parser.add_argument("--context", help="Filter by context type")

    # stats command
    stats_parser = subparsers.add_parser("stats", help="Show skill statistics")
    stats_parser.add_argument("--skill", required=True)

    # recommend command
    recommend_parser = subparsers.add_parser("recommend", help="Get routing recommendations")
    recommend_parser.add_argument("--skill", required=True)
    recommend_parser.add_argument("--context", required=True)

    args = parser.parse_args()

    if args.command == "log":
        event = UtilityEvent(
            task_id=args.task_id,
            timestamp=datetime.now().isoformat(),
            skill_name=args.skill,
            agent_sequence=args.agents.split(","),
            outcome=args.outcome,
            total_tokens=args.tokens,
            total_time_seconds=args.time,
            context_type=args.context,
            remediation_loops=args.remediation,
        )
        save_utility_event(event)
        print(f"Logged utility event for {args.skill}")

    elif args.command == "score":
        events = load_utility_log(args.skill)
        score = compute_utility(events, args.agent, args.context)
        print(f"Utility Score: {score.utility:.3f}")
        print(f"Success Rate: {score.success_rate:.2%}")
        print(f"Avg Cost: {score.avg_cost:.4f}")
        print(f"Sample Count: {score.sample_count}")

    elif args.command == "stats":
        stats = get_skill_statistics(args.skill)
        print(f"Total events: {stats.get('total_events', 0)}")
        if stats.get('total_events', 0) > 0:
            print(f"\nOutcomes:")
            for outcome, count in stats.get('outcomes', {}).items():
                print(f"  - {outcome}: {count}")
            print(f"\nContext types:")
            for ctx, count in stats.get('context_types', {}).items():
                print(f"  - {ctx}: {count}")
            print(f"\nAverages:")
            print(f"  - Tokens: {stats.get('avg_tokens', 0):.0f}")
            print(f"  - Time: {stats.get('avg_time_seconds', 0):.1f}s")
            print(f"  - Remediation loops: {stats.get('avg_remediation_loops', 0):.1f}")

    elif args.command == "recommend":
        recommendations = get_routing_recommendation(args.skill, args.context)
        if not recommendations:
            print("Not enough data for recommendations (need >= 5 events)")
        else:
            print(f"Routing recommendations for {args.skill} ({args.context}):")
            for agent, utility in sorted(recommendations.items(), key=lambda x: -x[1]):
                print(f"  {agent}: {utility:.3f}")
