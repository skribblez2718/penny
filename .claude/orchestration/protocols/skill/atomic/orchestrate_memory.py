"""
Orchestrate Memory - Atomic skill wrapper for memory-agent.

Purpose: Metacognitive assessment of workflow state and progress.
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


class OrchestrateMemory(BaseAtomicSkill):
    """Atomic skill wrapper for memory-agent."""

    @property
    def skill_name(self) -> str:
        return "orchestrate-memory"

    @property
    def agent_name(self) -> str:
        return "memory"

    @property
    def cognitive_function(self) -> str:
        return "METACOGNITION"

    @property
    def description(self) -> str:
        return "Metacognitive assessment of workflow state and progress"


if __name__ == "__main__":
    import sys
    if len(sys.argv) < 2:
        print("Usage: python orchestrate_memory.py <task_id> [config_json]")
        sys.exit(1)

    task_id = sys.argv[1]
    config = None
    if len(sys.argv) > 2:
        import json
        config = json.loads(sys.argv[2])

    skill = OrchestrateMemory()
    skill.invoke(task_id, config)
