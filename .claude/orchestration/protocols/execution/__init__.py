"""
protocols/execution
===================

Python-enforced execution protocols for the orchestration system.

This package provides:
- Two execution protocol types (skill, dynamic)
- FSM enforcement for each protocol
- Automatic dispatch based on routing decision from reasoning protocol
- Shared infrastructure for step execution

Protocols:
- skill: 6-step multi-phase cognitive processing for composite skills
- dynamic: 5-step dynamic orchestration of atomic skills

Legacy aliases for backwards compatibility:
- skill-orchestration → skill
- dynamic-skill-sequencing → dynamic

Each protocol follows the same patterns as the reasoning protocol:
- FSM enforces step order
- Steps read markdown content and print directives
- State persists across script invocations
- Output flows from step N to step N+1
"""

import sys
from pathlib import Path

# Ensure this package is importable
_EXECUTION_ROOT = Path(__file__).resolve().parent
if str(_EXECUTION_ROOT) not in sys.path:
    sys.path.insert(0, str(_EXECUTION_ROOT))

from config.config import (
    ProtocolType,
    VALID_ROUTES,
    ROUTE_TO_PROTOCOL,
    ROUTE_ALIASES,
    normalize_route_name,
)
from core.dispatcher import dispatch
from core.state import ExecutionState
from core.fsm import (
    SkillOrchestrationFSM,
    DynamicSkillSequencingFSM,
    SkillOrchestrationState,
    DynamicSkillSequencingState,
    create_fsm,
    load_fsm,
)
from steps.base import ExecutionBaseStep, BaseStep

__all__ = [
    # Config exports
    "ProtocolType",
    "VALID_ROUTES",
    "ROUTE_TO_PROTOCOL",
    "ROUTE_ALIASES",
    "normalize_route_name",
    # Core exports
    "dispatch",
    "ExecutionState",
    # FSM exports
    "SkillOrchestrationFSM",
    "DynamicSkillSequencingFSM",
    "SkillOrchestrationState",
    "DynamicSkillSequencingState",
    "create_fsm",
    "load_fsm",
    # Step base exports
    "ExecutionBaseStep",
    "BaseStep",
]
