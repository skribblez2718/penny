"""
Orchestrate Validation - Atomic skill wrapper for validation-agent.

Purpose: Systematically verify artifacts and deliverables against
established quality criteria.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Dict, Any, Optional, List

# Path setup - add protocols directory for fully-qualified imports
# This prevents collision between skill/config and agent/config
_ATOMIC_DIR = Path(__file__).resolve().parent
_SKILL_PROTOCOLS_ROOT = _ATOMIC_DIR.parent
_PROTOCOLS_DIR = _SKILL_PROTOCOLS_ROOT.parent
if str(_PROTOCOLS_DIR) not in sys.path:
    sys.path.insert(0, str(_PROTOCOLS_DIR))

from skill.atomic.base import BaseAtomicSkill


class OrchestrateValidation(BaseAtomicSkill):
    """Atomic skill wrapper for validation-agent."""

    @property
    def skill_name(self) -> str:
        return "orchestrate-validation"

    @property
    def agent_name(self) -> str:
        return "validation"

    @property
    def cognitive_function(self) -> str:
        return "VALIDATION"

    @property
    def description(self) -> str:
        return "Systematically verify artifacts against established quality criteria with GO/NO-GO/CONDITIONAL verdicts"

    def invoke(self, task_id: str, config: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """
        Invoke validation with quality criteria configuration.

        Config options:
            validation_target: Name of the phase/artifact being validated
            quality_criteria: List of criteria to validate against
            max_remediation_attempts: Maximum remediation loops (default: 2)
        """
        # Set defaults
        if config is None:
            config = {}
        if "max_remediation_attempts" not in config:
            config["max_remediation_attempts"] = 2

        return super().invoke(task_id, config)


if __name__ == "__main__":
    import sys
    if len(sys.argv) < 2:
        print("Usage: python orchestrate_validation.py <task_id> [config_json]")
        sys.exit(1)

    task_id = sys.argv[1]
    config = None
    if len(sys.argv) > 2:
        import json
        config = json.loads(sys.argv[2])

    skill = OrchestrateValidation()
    skill.invoke(task_id, config)
