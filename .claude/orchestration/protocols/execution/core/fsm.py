"""
fsm.py
======

Finite State Machines for execution protocols.

This module provides FSM classes for each execution protocol:
- SkillOrchestrationFSM (6 states)
- DynamicSkillSequencingFSM (5 states)

All FSMs share a common base class and pattern:
- Linear state transitions
- State history tracking
- JSON serialization for persistence
"""

import sys
from enum import Enum, auto
from pathlib import Path
from typing import Dict, List, Optional, Type

# Path setup - navigate to protocol root
_CORE_DIR = Path(__file__).resolve().parent
_EXECUTION_ROOT = _CORE_DIR.parent
if str(_EXECUTION_ROOT) not in sys.path:
    sys.path.insert(0, str(_EXECUTION_ROOT))

from config.config import ProtocolType


# =============================================================================
# Skill Orchestration FSM (6 steps)
# =============================================================================

class SkillOrchestrationState(Enum):
    """States for Skill Orchestration Protocol."""
    INITIALIZED = auto()
    GENERATE_TASK_ID = auto()       # Step 1
    CLASSIFY_DOMAIN = auto()         # Step 2
    READ_SKILL = auto()              # Step 3
    CREATE_MEMORY = auto()           # Step 4
    TRIGGER_AGENTS = auto()          # Step 5
    COMPLETE_WORKFLOW = auto()       # Step 6
    COMPLETED = auto()               # Final


class SkillOrchestrationFSM:
    """FSM for Skill Orchestration Protocol (6 steps)."""

    TRANSITIONS: Dict[SkillOrchestrationState, List[SkillOrchestrationState]] = {
        SkillOrchestrationState.INITIALIZED: [SkillOrchestrationState.GENERATE_TASK_ID],
        SkillOrchestrationState.GENERATE_TASK_ID: [SkillOrchestrationState.CLASSIFY_DOMAIN],
        SkillOrchestrationState.CLASSIFY_DOMAIN: [SkillOrchestrationState.READ_SKILL],
        SkillOrchestrationState.READ_SKILL: [SkillOrchestrationState.CREATE_MEMORY],
        SkillOrchestrationState.CREATE_MEMORY: [SkillOrchestrationState.TRIGGER_AGENTS],
        SkillOrchestrationState.TRIGGER_AGENTS: [SkillOrchestrationState.COMPLETE_WORKFLOW],
        SkillOrchestrationState.COMPLETE_WORKFLOW: [SkillOrchestrationState.COMPLETED],
        SkillOrchestrationState.COMPLETED: [],
    }

    STATE_TO_STEP: Dict[SkillOrchestrationState, int] = {
        SkillOrchestrationState.GENERATE_TASK_ID: 1,
        SkillOrchestrationState.CLASSIFY_DOMAIN: 2,
        SkillOrchestrationState.READ_SKILL: 3,
        SkillOrchestrationState.CREATE_MEMORY: 4,
        SkillOrchestrationState.TRIGGER_AGENTS: 5,
        SkillOrchestrationState.COMPLETE_WORKFLOW: 6,
    }

    STEP_TO_STATE: Dict[int, SkillOrchestrationState] = {
        v: k for k, v in STATE_TO_STEP.items()
    }

    def __init__(self, state: SkillOrchestrationState = SkillOrchestrationState.INITIALIZED):
        self.state = state
        self.history: List[SkillOrchestrationState] = [state]

    def can_transition(self, target: SkillOrchestrationState) -> bool:
        return target in self.TRANSITIONS.get(self.state, [])

    def transition(self, target: SkillOrchestrationState) -> bool:
        if self.can_transition(target):
            self.state = target
            self.history.append(target)
            return True
        return False

    def get_current_step(self) -> Optional[int]:
        return self.STATE_TO_STEP.get(self.state)

    def is_final(self) -> bool:
        return self.state == SkillOrchestrationState.COMPLETED

    def to_dict(self) -> dict:
        return {
            "state": self.state.name,  # Aligned with protocols/skill FSM naming
            "current_step": self.get_current_step(),
            "history": [s.name for s in self.history],
            "is_final": self.is_final(),
        }

    @classmethod
    def from_dict(cls, data: dict) -> "SkillOrchestrationFSM":
        # Support both "state" (new) and "current_state" (legacy) for backwards compatibility
        state_key = "state" if "state" in data else "current_state"
        state = SkillOrchestrationState[data[state_key]]
        fsm = cls(state)
        fsm.history = [SkillOrchestrationState[s] for s in data["history"]]
        return fsm


# =============================================================================
# Dynamic Skill Sequencing FSM (5 steps)
# =============================================================================

class DynamicSkillSequencingState(Enum):
    """States for Dynamic Skill Sequencing Protocol."""
    INITIALIZED = auto()
    ANALYZE_REQUIREMENTS = auto()    # Step 1
    PLAN_SEQUENCE = auto()           # Step 2
    INVOKE_SKILLS = auto()           # Step 3
    VERIFY_COMPLETION = auto()       # Step 4
    COMPLETE = auto()                # Step 5
    COMPLETED = auto()               # Final


class DynamicSkillSequencingFSM:
    """FSM for Dynamic Skill Sequencing Protocol (5 steps)."""

    TRANSITIONS: Dict[DynamicSkillSequencingState, List[DynamicSkillSequencingState]] = {
        DynamicSkillSequencingState.INITIALIZED: [DynamicSkillSequencingState.ANALYZE_REQUIREMENTS],
        DynamicSkillSequencingState.ANALYZE_REQUIREMENTS: [DynamicSkillSequencingState.PLAN_SEQUENCE],
        DynamicSkillSequencingState.PLAN_SEQUENCE: [DynamicSkillSequencingState.INVOKE_SKILLS],
        DynamicSkillSequencingState.INVOKE_SKILLS: [DynamicSkillSequencingState.VERIFY_COMPLETION],
        DynamicSkillSequencingState.VERIFY_COMPLETION: [DynamicSkillSequencingState.COMPLETE],
        DynamicSkillSequencingState.COMPLETE: [DynamicSkillSequencingState.COMPLETED],
        DynamicSkillSequencingState.COMPLETED: [],
    }

    STATE_TO_STEP: Dict[DynamicSkillSequencingState, int] = {
        DynamicSkillSequencingState.ANALYZE_REQUIREMENTS: 1,
        DynamicSkillSequencingState.PLAN_SEQUENCE: 2,
        DynamicSkillSequencingState.INVOKE_SKILLS: 3,
        DynamicSkillSequencingState.VERIFY_COMPLETION: 4,
        DynamicSkillSequencingState.COMPLETE: 5,
    }

    STEP_TO_STATE: Dict[int, DynamicSkillSequencingState] = {
        v: k for k, v in STATE_TO_STEP.items()
    }

    def __init__(self, state: DynamicSkillSequencingState = DynamicSkillSequencingState.INITIALIZED):
        self.state = state
        self.history: List[DynamicSkillSequencingState] = [state]

    def can_transition(self, target: DynamicSkillSequencingState) -> bool:
        return target in self.TRANSITIONS.get(self.state, [])

    def transition(self, target: DynamicSkillSequencingState) -> bool:
        if self.can_transition(target):
            self.state = target
            self.history.append(target)
            return True
        return False

    def get_current_step(self) -> Optional[int]:
        return self.STATE_TO_STEP.get(self.state)

    def is_final(self) -> bool:
        return self.state == DynamicSkillSequencingState.COMPLETED

    def to_dict(self) -> dict:
        return {
            "state": self.state.name,  # Aligned with protocols/skill FSM naming
            "current_step": self.get_current_step(),
            "history": [s.name for s in self.history],
            "is_final": self.is_final(),
        }

    @classmethod
    def from_dict(cls, data: dict) -> "DynamicSkillSequencingFSM":
        # Support both "state" (new) and "current_state" (legacy) for backwards compatibility
        state_key = "state" if "state" in data else "current_state"
        state = DynamicSkillSequencingState[data[state_key]]
        fsm = cls(state)
        fsm.history = [DynamicSkillSequencingState[s] for s in data["history"]]
        return fsm


# =============================================================================
# FSM Factory
# =============================================================================

# Map protocol types to FSM classes
PROTOCOL_FSM_CLASSES: Dict[ProtocolType, Type] = {
    ProtocolType.SKILL_ORCHESTRATION: SkillOrchestrationFSM,
    ProtocolType.DYNAMIC_SKILL_SEQUENCING: DynamicSkillSequencingFSM,
}

# Map protocol types to state enums
PROTOCOL_STATE_ENUMS: Dict[ProtocolType, Type[Enum]] = {
    ProtocolType.SKILL_ORCHESTRATION: SkillOrchestrationState,
    ProtocolType.DYNAMIC_SKILL_SEQUENCING: DynamicSkillSequencingState,
}


def create_fsm(protocol_type: ProtocolType):
    """Create a new FSM for the given protocol type."""
    fsm_class = PROTOCOL_FSM_CLASSES.get(protocol_type)
    if not fsm_class:
        raise ValueError(f"Unknown protocol type: {protocol_type}")
    return fsm_class()


def load_fsm(protocol_type: ProtocolType, data: dict):
    """Load an FSM from serialized data."""
    fsm_class = PROTOCOL_FSM_CLASSES.get(protocol_type)
    if not fsm_class:
        raise ValueError(f"Unknown protocol type: {protocol_type}")
    return fsm_class.from_dict(data)
