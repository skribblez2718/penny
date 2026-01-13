"""
state.py
========

State management for execution protocols.

This module provides:
- ExecutionState class for tracking protocol execution
- Links to the originating reasoning session
- Step output tracking
- JSON persistence
"""

from __future__ import annotations

import json
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional, Any, Dict, List, Union

# Path setup - navigate to protocol root
_CORE_DIR = Path(__file__).resolve().parent
_EXECUTION_ROOT = _CORE_DIR.parent
if str(_EXECUTION_ROOT) not in sys.path:
    sys.path.insert(0, str(_EXECUTION_ROOT))

from config.config import (
    ProtocolType,
    PROTOCOL_TO_DIR,
    SCHEMA_VERSION,
    EXECUTION_PROTOCOL_VERSION,
    get_protocol_state_dir,
    get_state_file_path,
)
from core.fsm import (
    create_fsm,
    load_fsm,
    SkillOrchestrationFSM,
    DynamicSkillSequencingFSM,
)


# Type alias for FSM instances
FSMType = Union[SkillOrchestrationFSM, DynamicSkillSequencingFSM]


class ExecutionState:
    """
    Manages the state of an execution protocol session.

    This class tracks:
    - Protocol type and session identity
    - Link to originating reasoning session
    - FSM state and transitions
    - Step outputs
    - Completion status
    """

    def __init__(
        self,
        protocol_type: ProtocolType,
        reasoning_session_id: str,
        session_id: Optional[str] = None,
        fsm: Optional[FSMType] = None,
        plan: Optional[Dict[str, Any]] = None,
    ):
        """
        Initialize execution state.

        Args:
            protocol_type: The type of execution protocol
            reasoning_session_id: ID of the originating reasoning session
            session_id: Unique session ID (generated if not provided)
            fsm: FSM instance (created if not provided)
            plan: The approved execution plan from reasoning protocol
        """
        self.protocol_type = protocol_type
        self.reasoning_session_id = reasoning_session_id
        self.session_id = session_id or self._generate_session_id()
        self.created_at = datetime.now(timezone.utc).isoformat()
        self.fsm = fsm or create_fsm(protocol_type)

        # Step tracking (keys can be int like 1-8 or str like "3b")
        self.step_outputs: Dict[Union[int, str], Dict[str, Any]] = {}
        self.step_timestamps: Dict[Union[int, str], Dict[str, str]] = {}

        # Completion state
        self.completed_at: Optional[str] = None
        self.completion_summary: Optional[str] = None

        # Approved execution plan from reasoning protocol
        self.plan: Optional[Dict[str, Any]] = plan

    @staticmethod
    def _generate_session_id() -> str:
        """Generate a unique session ID."""
        return str(uuid.uuid4())[:12]

    @property
    def state_file_path(self) -> Path:
        """Get the path to this session's state file."""
        return get_state_file_path(self.protocol_type, self.session_id)

    @property
    def current_step(self) -> Optional[int]:
        """Get the current step number."""
        return self.fsm.get_current_step()

    @property
    def status(self) -> str:
        """Get the current status string."""
        if self.fsm.is_final():
            return "completed"
        elif self.fsm.state.name == "INITIALIZED":
            return "initialized"
        else:
            return "in_progress"

    @property
    def protocol_name(self) -> str:
        """Get the protocol name string."""
        return PROTOCOL_TO_DIR[self.protocol_type]

    def start_step(self, step_num: int) -> bool:
        """
        Mark a step as started.

        Args:
            step_num: The step number

        Returns:
            True if step was started successfully
        """
        target_state = self.fsm.STEP_TO_STATE.get(step_num)
        if not target_state:
            return False

        if self.fsm.transition(target_state):
            self.step_timestamps[step_num] = {
                "started_at": datetime.now(timezone.utc).isoformat(),
                "completed_at": None,
            }
            return True
        return False

    def complete_step(self, step_num: int, output: Dict[str, Any]) -> bool:
        """
        Mark a step as completed and store its output.

        Args:
            step_num: The step number
            output: The step's output data

        Returns:
            True if step was completed successfully
        """
        if self.current_step != step_num:
            return False

        self.step_outputs[step_num] = output

        if step_num in self.step_timestamps:
            self.step_timestamps[step_num]["completed_at"] = (
                datetime.now(timezone.utc).isoformat()
            )

        return True

    def get_step_output(self, step_num: int) -> Optional[Dict[str, Any]]:
        """
        Get the output from a specific step.

        Args:
            step_num: The step number

        Returns:
            Step output or None if not available
        """
        return self.step_outputs.get(step_num)

    def get_previous_step_output(self) -> Optional[Dict[str, Any]]:
        """
        Get the output from the previous step.

        Returns:
            Previous step's output or None
        """
        current = self.current_step
        if current and current > 1:
            return self.get_step_output(current - 1)
        return None

    def complete_protocol(self, summary: str = "") -> bool:
        """
        Mark the protocol as completed.

        Args:
            summary: Optional completion summary

        Returns:
            True if completion was successful
        """
        # Get the COMPLETED state for this protocol
        state_enum = type(self.fsm.state)
        completed_state = state_enum["COMPLETED"]

        if self.fsm.transition(completed_state):
            self.completed_at = datetime.now(timezone.utc).isoformat()
            self.completion_summary = summary
            return True
        return False

    def to_dict(self) -> dict:
        """
        Serialize state for JSON storage.

        Returns:
            Dictionary representation of state
        """
        return {
            "schema_version": SCHEMA_VERSION,
            "protocol_version": EXECUTION_PROTOCOL_VERSION,
            "protocol_type": self.protocol_type.name,
            "protocol_name": self.protocol_name,
            "session_id": self.session_id,
            "reasoning_session_id": self.reasoning_session_id,
            "created_at": self.created_at,
            "status": self.status,
            "fsm": self.fsm.to_dict(),
            "step_outputs": {str(k): v for k, v in self.step_outputs.items()},
            "step_timestamps": {str(k): v for k, v in self.step_timestamps.items()},
            "completed_at": self.completed_at,
            "completion_summary": self.completion_summary,
            "plan": self.plan,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "ExecutionState":
        """
        Restore state from JSON data.

        Args:
            data: Dictionary with state data

        Returns:
            Restored ExecutionState instance
        """
        protocol_type = ProtocolType[data["protocol_type"]]
        fsm = load_fsm(protocol_type, data["fsm"])

        state = cls(
            protocol_type=protocol_type,
            reasoning_session_id=data["reasoning_session_id"],
            session_id=data["session_id"],
            fsm=fsm,
        )
        state.created_at = data["created_at"]
        # Convert keys to int where possible, keep as string otherwise (e.g., "3b")
        state.step_outputs = {
            int(k) if k.isdigit() else k: v
            for k, v in data.get("step_outputs", {}).items()
        }
        state.step_timestamps = {
            int(k) if k.isdigit() else k: v
            for k, v in data.get("step_timestamps", {}).items()
        }
        state.completed_at = data.get("completed_at")
        state.completion_summary = data.get("completion_summary")
        state.plan = data.get("plan")
        return state

    def save(self) -> Path:
        """
        Save state to JSON file.

        Returns:
            Path to the saved state file
        """
        state_dir = get_protocol_state_dir(self.protocol_type)
        state_dir.mkdir(parents=True, exist_ok=True)
        state_file = self.state_file_path

        with open(state_file, "w", encoding="utf-8") as f:
            json.dump(self.to_dict(), f, indent=2)

        return state_file

    @classmethod
    def load(cls, protocol_type: ProtocolType, session_id: str) -> Optional["ExecutionState"]:
        """
        Load state from JSON file.

        Args:
            protocol_type: The protocol type
            session_id: The session ID to load

        Returns:
            Restored ExecutionState or None if not found
        """
        state_file = get_state_file_path(protocol_type, session_id)

        if not state_file.exists():
            return None

        with open(state_file, "r", encoding="utf-8") as f:
            data = json.load(f)

        return cls.from_dict(data)

    def __repr__(self) -> str:
        return (
            f"ExecutionState(protocol={self.protocol_name}, "
            f"session_id={self.session_id!r}, "
            f"status={self.status!r}, step={self.current_step})"
        )
