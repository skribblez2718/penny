"""
core/__init__.py
================

Core execution protocol components.
"""

import sys
from pathlib import Path

# Ensure parent is importable
_PACKAGE_DIR = Path(__file__).resolve().parent
_EXECUTION_ROOT = _PACKAGE_DIR.parent
if str(_EXECUTION_ROOT) not in sys.path:
    sys.path.insert(0, str(_EXECUTION_ROOT))

from core.fsm import (
    # State enums
    SkillOrchestrationState,
    DynamicSkillSequencingState,
    # FSM classes
    SkillOrchestrationFSM,
    DynamicSkillSequencingFSM,
    # Mappings
    PROTOCOL_FSM_CLASSES,
    PROTOCOL_STATE_ENUMS,
    # Factory functions
    create_fsm,
    load_fsm,
)

from core.state import ExecutionState

from core.dispatcher import dispatch

__all__ = [
    # FSM exports
    "SkillOrchestrationState",
    "DynamicSkillSequencingState",
    "SkillOrchestrationFSM",
    "DynamicSkillSequencingFSM",
    "PROTOCOL_FSM_CLASSES",
    "PROTOCOL_STATE_ENUMS",
    "create_fsm",
    "load_fsm",
    # State exports
    "ExecutionState",
    # Dispatcher exports
    "dispatch",
]
