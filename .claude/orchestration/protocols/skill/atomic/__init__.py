"""
Atomic Skills - Thin wrappers that invoke protocols/agent.

Each atomic skill:
- Maps 1:1 to a cognitive agent
- Invokes the corresponding agent-protocol entry.py
- Returns expected memory file path
- Does not contain cognitive logic (that's in the agent)

Available Atomic Skills:
- orchestrate_clarification → clarification-agent
- orchestrate_analysis → analysis-agent
- orchestrate_research → research-agent
- orchestrate_synthesis → synthesis-agent
- orchestrate_generation → generation-agent
- orchestrate_validation → validation-agent
- orchestrate_memory → memory-agent
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
from skill.atomic.orchestrate_clarification import OrchestrateClarification
from skill.atomic.orchestrate_analysis import OrchestrateAnalysis
from skill.atomic.orchestrate_research import OrchestrateResearch
from skill.atomic.orchestrate_synthesis import OrchestrateSynthesis
from skill.atomic.orchestrate_generation import OrchestrateGeneration
from skill.atomic.orchestrate_validation import OrchestrateValidation
from skill.atomic.orchestrate_memory import OrchestrateMemory

__all__ = [
    "BaseAtomicSkill",
    "OrchestrateClarification",
    "OrchestrateAnalysis",
    "OrchestrateResearch",
    "OrchestrateSynthesis",
    "OrchestrateGeneration",
    "OrchestrateValidation",
    "OrchestrateMemory",
]

# Registry for quick lookup
ATOMIC_SKILL_CLASSES = {
    "orchestrate-clarification": OrchestrateClarification,
    "orchestrate-analysis": OrchestrateAnalysis,
    "orchestrate-research": OrchestrateResearch,
    "orchestrate-synthesis": OrchestrateSynthesis,
    "orchestrate-generation": OrchestrateGeneration,
    "orchestrate-validation": OrchestrateValidation,
    "orchestrate-memory": OrchestrateMemory,
}


def get_atomic_skill(skill_name: str) -> BaseAtomicSkill:
    """Get an atomic skill instance by name."""
    cls = ATOMIC_SKILL_CLASSES.get(skill_name)
    if cls:
        return cls()
    raise ValueError(f"Unknown atomic skill: {skill_name}")
