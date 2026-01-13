"""
Orchestrate Analysis - Atomic skill wrapper for analysis-agent.

Purpose: Decompose complexity through systematic analytical frameworks -
pattern recognition, risk assessment, dependency mapping.
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


class OrchestrateAnalysis(BaseAtomicSkill):
    """Atomic skill wrapper for analysis-agent."""

    @property
    def skill_name(self) -> str:
        return "orchestrate-analysis"

    @property
    def agent_name(self) -> str:
        return "analysis"

    @property
    def cognitive_function(self) -> str:
        return "ANALYSIS"

    @property
    def description(self) -> str:
        return "Decompose complexity through systematic analytical frameworks - pattern recognition, risk assessment, dependency mapping"


if __name__ == "__main__":
    import sys
    if len(sys.argv) < 2:
        print("Usage: python orchestrate_analysis.py <task_id> [config_json]")
        sys.exit(1)

    task_id = sys.argv[1]
    config = None
    if len(sys.argv) > 2:
        import json
        config = json.loads(sys.argv[2])

    skill = OrchestrateAnalysis()
    skill.invoke(task_id, config)
