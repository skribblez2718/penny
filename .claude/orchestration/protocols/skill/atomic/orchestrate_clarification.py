"""
Orchestrate Clarification - Atomic skill wrapper for clarification-agent.

Purpose: Transform vague inputs into actionable specifications through
systematic Socratic questioning.
"""

from __future__ import annotations

import sys
from pathlib import Path

# Path setup - add protocols directory for fully-qualified imports
# This prevents collision between skill/config and agent/config
_ATOMIC_DIR = Path(__file__).resolve().parent
_SKILL_PROTOCOLS_ROOT = _ATOMIC_DIR.parent
_PROTOCOLS_DIR = _SKILL_PROTOCOLS_ROOT.parent
if str(_PROTOCOLS_DIR) not in sys.path:
    sys.path.insert(0, str(_PROTOCOLS_DIR))

from skill.atomic.base import BaseAtomicSkill


class OrchestrateClarification(BaseAtomicSkill):
    """Atomic skill wrapper for clarification-agent."""

    @property
    def skill_name(self) -> str:
        return "orchestrate-clarification"

    @property
    def agent_name(self) -> str:
        return "clarification"

    @property
    def cognitive_function(self) -> str:
        return "CLARIFICATION"

    @property
    def description(self) -> str:
        return "Transform vague inputs into actionable specifications through systematic Socratic questioning"


if __name__ == "__main__":
    import sys
    if len(sys.argv) < 2:
        print("Usage: python orchestrate_clarification.py <task_id> [config_json]")
        sys.exit(1)

    task_id = sys.argv[1]
    config = None
    if len(sys.argv) > 2:
        import json
        config = json.loads(sys.argv[2])

    skill = OrchestrateClarification()
    skill.invoke(task_id, config)
