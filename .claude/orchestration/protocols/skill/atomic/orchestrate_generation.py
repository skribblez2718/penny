"""
Orchestrate Generation - Atomic skill wrapper for generation-agent.

Purpose: Create artifacts (code, documentation, plans) from specifications
using domain-appropriate creation cycles (TDD for code).
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Dict, Any, Optional

# Path setup - add protocols directory for fully-qualified imports
# This prevents collision between skill/config and agent/config
_ATOMIC_DIR = Path(__file__).resolve().parent
_SKILL_PROTOCOLS_ROOT = _ATOMIC_DIR.parent
_PROTOCOLS_DIR = _SKILL_PROTOCOLS_ROOT.parent
if str(_PROTOCOLS_DIR) not in sys.path:
    sys.path.insert(0, str(_PROTOCOLS_DIR))

from skill.atomic.base import BaseAtomicSkill


class OrchestrateGeneration(BaseAtomicSkill):
    """Atomic skill wrapper for generation-agent."""

    @property
    def skill_name(self) -> str:
        return "orchestrate-generation"

    @property
    def agent_name(self) -> str:
        return "generation"

    @property
    def cognitive_function(self) -> str:
        return "GENERATION"

    @property
    def description(self) -> str:
        return "Create artifacts from specifications using TDD methodology (RED-GREEN-REFACTOR)"

    def invoke(self, task_id: str, config: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """
        Invoke generation with optional iteration configuration.

        Config options:
            iteration: Current iteration number (for multi-iteration generation)
            total_iterations: Total number of iterations planned
            artifact_type: Type of artifact being generated
        """
        return super().invoke(task_id, config)


if __name__ == "__main__":
    import sys
    if len(sys.argv) < 2:
        print("Usage: python orchestrate_generation.py <task_id> [config_json]")
        sys.exit(1)

    task_id = sys.argv[1]
    config = None
    if len(sys.argv) > 2:
        import json
        config = json.loads(sys.argv[2])

    skill = OrchestrateGeneration()
    skill.invoke(task_id, config)
