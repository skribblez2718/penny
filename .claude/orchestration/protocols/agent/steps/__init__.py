"""
Agent Step Implementations
==========================

Base classes and shared step implementations for cognitive agents.
"""

from pathlib import Path
import sys

# Add protocols directory to path for fully-qualified imports
_STEPS_DIR = Path(__file__).resolve().parent
_AGENT_PROTOCOLS_DIR = _STEPS_DIR.parent
_PROTOCOLS_DIR = _AGENT_PROTOCOLS_DIR.parent
if str(_PROTOCOLS_DIR) not in sys.path:
    sys.path.insert(0, str(_PROTOCOLS_DIR))

# Re-export base classes and shared steps (using fully-qualified imports)
from agent.steps.base import (
    AgentExecutionState,
    BaseAgentStep,
    count_tokens,
    enforce_context_budget,
)
from agent.steps.shared import (
    LearningInjectionStep,
    JohariDiscoveryStep,
    SHARED_AGENT_STEPS,
)

__all__ = [
    "AgentExecutionState",
    "BaseAgentStep",
    "count_tokens",
    "enforce_context_budget",
    "LearningInjectionStep",
    "JohariDiscoveryStep",
    "SHARED_AGENT_STEPS",
]
