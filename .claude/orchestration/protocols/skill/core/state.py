"""
Skill Execution State - Persistence for skill workflow execution.

Tracks:
- Current phase and FSM state
- Phase outputs and timestamps
- Task context and configuration
- Memory file paths
"""

from __future__ import annotations

import json
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Any, Optional, List

# Path setup - add protocols directory for fully-qualified imports
# This prevents collision between skill/core and agent/core
_CORE_DIR = Path(__file__).resolve().parent
_SKILL_PROTOCOLS_ROOT = _CORE_DIR.parent
_PROTOCOLS_DIR = _SKILL_PROTOCOLS_ROOT.parent
_ORCHESTRATION_ROOT = _PROTOCOLS_DIR
if str(_PROTOCOLS_DIR) not in sys.path:
    sys.path.insert(0, str(_PROTOCOLS_DIR))

# Directory paths (defined locally to avoid circular imports)
STATE_DIR = _SKILL_PROTOCOLS_ROOT / "state"
CLAUDE_ROOT = _ORCHESTRATION_ROOT.parent

from skill.core.fsm import SkillFSM
from skill.config.config import get_skill_type, SkillType


class SkillExecutionState:
    """
    Manages state for skill workflow execution.

    Persists to JSON files in skill-protocols/state/ directory.
    """

    SCHEMA_VERSION = "1.0"

    def __init__(
        self,
        skill_name: str,
        task_id: str,
        session_id: str = None,
        fsm: SkillFSM = None,
        execution_session_id: str = None,
    ):
        """
        Initialize skill execution state.

        Args:
            skill_name: Name of the skill being executed
            task_id: Task ID from execution (e.g., task-skill-develop-skill)
            session_id: Optional session ID (generated if not provided)
            fsm: Optional pre-initialized FSM
            execution_session_id: Session ID from execution
        """
        self.skill_name = skill_name
        self.task_id = task_id
        self.session_id = session_id or str(uuid.uuid4())[:8]
        self.execution_session_id = execution_session_id

        # Initialize FSM
        skill_type = get_skill_type(skill_name)
        if skill_type == SkillType.COMPOSITE:
            self.fsm = fsm or SkillFSM(skill_name)
        else:
            self.fsm = None  # Atomic skills don't need FSM

        # Timestamps
        self.created_at = datetime.now(timezone.utc).isoformat()
        self.started_at = self.created_at  # Alias for compatibility
        self.updated_at = self.created_at

        # Phase tracking
        self.phase_outputs: Dict[str, Dict[str, Any]] = {}
        self.phase_timestamps: Dict[str, Dict[str, str]] = {}

        # Memory files created during execution
        self.memory_files: List[str] = []

        # Configuration passed to phases
        self.configuration: Dict[str, Any] = {}

        # General metadata
        self.metadata: Dict[str, Any] = {}

        # Status
        self.status = "initialized"
        self.halt_reason: Optional[str] = None

    def get_state_file_path(self) -> Path:
        """Get path to state file."""
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        return STATE_DIR / f"{self.skill_name}-{self.session_id}.json"

    def start_phase(self, phase_id: str) -> None:
        """Record phase start."""
        self.phase_timestamps[phase_id] = {
            "started_at": datetime.now(timezone.utc).isoformat(),
        }
        self.status = "executing"
        self.updated_at = datetime.now(timezone.utc).isoformat()

    def complete_phase(self, phase_id: str, output: Dict[str, Any] = None) -> None:
        """Record phase completion."""
        if phase_id in self.phase_timestamps:
            self.phase_timestamps[phase_id]["completed_at"] = datetime.now(timezone.utc).isoformat()
        else:
            self.phase_timestamps[phase_id] = {
                "started_at": datetime.now(timezone.utc).isoformat(),
                "completed_at": datetime.now(timezone.utc).isoformat(),
            }

        self.phase_outputs[phase_id] = output or {}
        self.updated_at = datetime.now(timezone.utc).isoformat()

        # Update FSM if present
        if self.fsm:
            self.fsm.complete_phase(output)

    def add_memory_file(self, file_path: str) -> None:
        """Track a memory file created during execution."""
        if file_path not in self.memory_files:
            self.memory_files.append(file_path)
        self.updated_at = datetime.now(timezone.utc).isoformat()

    def get_memory_file_path(self, phase_id: str, agent_name: str = None) -> str:
        """
        Get expected memory file path for a phase.

        Args:
            phase_id: Phase identifier
            agent_name: Optional agent name (for agent-invoked phases)

        Returns:
            Path to memory file
        """
        memory_dir = CLAUDE_ROOT / "memory"
        memory_dir.mkdir(parents=True, exist_ok=True)

        if agent_name:
            return str(memory_dir / f"{self.task_id}-{agent_name}-memory.md")
        else:
            phase_name = phase_id.replace(".", "_")
            return str(memory_dir / f"{self.task_id}-phase-{phase_name}-memory.md")

    def set_configuration(self, config: Dict[str, Any]) -> None:
        """Set configuration for the skill execution."""
        self.configuration = config
        self.updated_at = datetime.now(timezone.utc).isoformat()

    def halt(self, reason: str) -> None:
        """Halt execution with a reason."""
        self.status = "halted"
        self.halt_reason = reason
        self.updated_at = datetime.now(timezone.utc).isoformat()

        if self.fsm:
            self.fsm.halt(reason)

    def complete(self) -> None:
        """Mark execution as complete."""
        self.status = "completed"
        self.updated_at = datetime.now(timezone.utc).isoformat()

    def save(self) -> Path:
        """Save state to JSON file."""
        self.updated_at = datetime.now(timezone.utc).isoformat()

        state_file = self.get_state_file_path()
        state_file.write_text(json.dumps(self.to_dict(), indent=2))

        return state_file

    def to_dict(self) -> Dict[str, Any]:
        """Serialize state to dictionary."""
        return {
            "schema_version": self.SCHEMA_VERSION,
            "skill_name": self.skill_name,
            "task_id": self.task_id,
            "session_id": self.session_id,
            "execution_session_id": self.execution_session_id,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "status": self.status,
            "halt_reason": self.halt_reason,
            "fsm": self.fsm.to_dict() if self.fsm else None,
            "phase_outputs": self.phase_outputs,
            "phase_timestamps": self.phase_timestamps,
            "memory_files": self.memory_files,
            "configuration": self.configuration,
            "metadata": self.metadata,
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "SkillExecutionState":
        """Deserialize state from dictionary."""
        # Reconstruct FSM if present
        fsm = None
        if data.get("fsm"):
            fsm = SkillFSM.from_dict(data["fsm"])

        state = cls(
            skill_name=data["skill_name"],
            task_id=data["task_id"],
            session_id=data["session_id"],
            fsm=fsm,
            execution_session_id=data.get("execution_session_id"),
        )

        state.created_at = data["created_at"]
        state.started_at = data["created_at"]  # Alias for compatibility
        state.updated_at = data["updated_at"]
        state.status = data["status"]
        state.halt_reason = data.get("halt_reason")
        state.phase_outputs = data.get("phase_outputs", {})
        state.phase_timestamps = data.get("phase_timestamps", {})
        state.memory_files = data.get("memory_files", [])
        state.configuration = data.get("configuration", {})
        state.metadata = data.get("metadata", {})

        return state

    @classmethod
    def load(cls, skill_name: str, session_id: str) -> Optional["SkillExecutionState"]:
        """Load state from JSON file."""
        state_file = STATE_DIR / f"{skill_name}-{session_id}.json"

        if not state_file.exists():
            return None

        data = json.loads(state_file.read_text())
        return cls.from_dict(data)

    @classmethod
    def find_latest(cls, skill_name: str) -> Optional["SkillExecutionState"]:
        """Find the most recent state file for a skill."""
        STATE_DIR.mkdir(parents=True, exist_ok=True)

        pattern = f"{skill_name}-*.json"
        state_files = list(STATE_DIR.glob(pattern))

        if not state_files:
            return None

        # Sort by modification time, newest first
        state_files.sort(key=lambda p: p.stat().st_mtime, reverse=True)

        data = json.loads(state_files[0].read_text())
        return cls.from_dict(data)

    def get_progress_summary(self) -> str:
        """Get a human-readable progress summary."""
        if self.fsm:
            progress = self.fsm.get_progress()
            return (
                f"Skill: {self.skill_name}\n"
                f"Task ID: {self.task_id}\n"
                f"Status: {self.status}\n"
                f"Progress: {progress['percent_complete']}% "
                f"({progress['completed']}/{progress['total_phases']} phases)\n"
                f"Current Phase: {progress['current_phase']}\n"
            )
        else:
            return (
                f"Skill: {self.skill_name} (atomic)\n"
                f"Task ID: {self.task_id}\n"
                f"Status: {self.status}\n"
            )

    # --- Clarification State Management ---

    def is_clarification_pending(self) -> bool:
        """
        Check if workflow is blocked waiting for user clarification.

        Returns:
            True if clarification is pending, False otherwise
        """
        return self.metadata.get("clarification_pending", False)

    def get_clarification_context(self) -> Optional[Dict[str, Any]]:
        """
        Get context for re-invoking agent after clarification.

        Returns:
            Dict with clarification context including:
            - agent: The agent to re-invoke
            - phase: The phase that requested clarification
            - questions: The questions that were asked
            - round: Which clarification round this is
            - answers: Previous answers (if any)
            Or None if no clarification is pending
        """
        if not self.is_clarification_pending():
            return None

        round_num = self.metadata.get("clarification_round", 1)

        return {
            "agent": self.metadata.get("clarification_agent"),
            "phase": self.metadata.get("clarification_phase"),
            "questions": self.metadata.get("clarification_questions", []),
            "round": round_num,
            "memory_file": self.metadata.get("clarification_memory_file"),
            "requested_at": self.metadata.get("clarification_requested_at"),
            # Include all previous answers
            "previous_answers": self._get_all_clarification_answers(),
        }

    def _get_all_clarification_answers(self) -> Dict[str, Any]:
        """Get all clarification answers from all rounds."""
        answers = {}
        for key, value in self.metadata.items():
            if key.startswith("clarification_answers_round_"):
                answers[key] = value
        return answers

    def set_clarification_answers(
        self,
        answers: Dict[str, Any],
        round_num: Optional[int] = None,
    ) -> None:
        """
        Store user's answers to clarification questions.

        Args:
            answers: Dict mapping question IDs to answers
            round_num: Which clarification round (defaults to current round)
        """
        if round_num is None:
            round_num = self.metadata.get("clarification_round", 1)

        answers_key = f"clarification_answers_round_{round_num}"
        self.metadata[answers_key] = answers
        self.metadata["clarification_answered_at"] = datetime.now(timezone.utc).isoformat()
        self.updated_at = datetime.now(timezone.utc).isoformat()

    def clear_clarification(self) -> None:
        """
        Clear clarification pending state after completion.

        This clears the pending flag but preserves the history
        (questions, answers, rounds) for reference.
        """
        self.metadata["clarification_pending"] = False
        self.metadata["clarification_cleared_at"] = datetime.now(timezone.utc).isoformat()
        self.updated_at = datetime.now(timezone.utc).isoformat()

    def get_clarification_history(self) -> List[Dict[str, Any]]:
        """
        Get the full history of clarification rounds.

        Returns:
            List of dicts, each containing questions and answers for a round
        """
        history = []
        round_num = 1
        while True:
            questions_key = f"clarification_questions_round_{round_num}"
            answers_key = f"clarification_answers_round_{round_num}"

            # Check if this round exists (either in dedicated keys or main key for first round)
            if round_num == 1:
                questions = self.metadata.get("clarification_questions")
            else:
                questions = self.metadata.get(questions_key)

            answers = self.metadata.get(answers_key)

            if questions is None and answers is None:
                break

            history.append({
                "round": round_num,
                "questions": questions or [],
                "answers": answers or {},
            })
            round_num += 1

        return history
