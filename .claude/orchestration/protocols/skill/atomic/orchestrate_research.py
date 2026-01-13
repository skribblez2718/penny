"""
Orchestrate Research - Atomic skill wrapper for research-agent.

Purpose: Investigate options, gather domain knowledge, and document
findings with configurable depth.
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


class OrchestrateResearch(BaseAtomicSkill):
    """Atomic skill wrapper for research-agent."""

    @property
    def skill_name(self) -> str:
        return "orchestrate-research"

    @property
    def agent_name(self) -> str:
        return "research"

    @property
    def cognitive_function(self) -> str:
        return "RESEARCH"

    @property
    def description(self) -> str:
        return "Investigate options, gather domain knowledge, and document findings with configurable depth"

    def invoke(self, task_id: str, config: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """
        Invoke research with depth configuration.

        Config options:
            research_depth: "quick" | "standard" | "deep" (default: "standard")
        """
        # Default to standard depth if not specified
        if config is None:
            config = {}
        if "research_depth" not in config:
            config["research_depth"] = "standard"

        return super().invoke(task_id, config)


if __name__ == "__main__":
    import sys
    if len(sys.argv) < 2:
        print("Usage: python orchestrate_research.py <task_id> [config_json]")
        sys.exit(1)

    task_id = sys.argv[1]
    config = None
    if len(sys.argv) > 2:
        import json
        config = json.loads(sys.argv[2])

    skill = OrchestrateResearch()
    skill.invoke(task_id, config)
