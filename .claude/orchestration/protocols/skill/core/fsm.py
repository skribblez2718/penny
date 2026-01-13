"""
Skill FSM - Finite State Machine for skill phase orchestration.

Handles complex phase patterns:
- Linear phases (0, 1, 2, 3)
- Sub-phases (0.5, 0.6, 1.5)
- Optional phases (conditional skip based on trigger)
- Iterative phases (3A, 3B, 3C, 3D)
- AUTO phases (Python execution, no agent)
- PARALLEL phases (execute branches concurrently, merge results)
"""

from __future__ import annotations

import sys
from enum import Enum, auto
from typing import Dict, List, Optional, Any
from dataclasses import dataclass, field
from pathlib import Path

# Path setup - add protocols directory for fully-qualified imports
# This prevents collision between skill/config and agent/config
_CORE_DIR = Path(__file__).resolve().parent
_SKILL_PROTOCOLS_ROOT = _CORE_DIR.parent
_PROTOCOLS_DIR = _SKILL_PROTOCOLS_ROOT.parent
if str(_PROTOCOLS_DIR) not in sys.path:
    sys.path.insert(0, str(_PROTOCOLS_DIR))

from skill.config.config import (
    PhaseType,
    get_skill_phases,
    get_phase_config,
    get_phase_list,
)


class SkillPhaseState(Enum):
    """
    Generic phase states for skill execution.
    Actual phase names are dynamic based on skill configuration.

    ENFORCEMENT: LEARNINGS_PENDING and FULLY_COMPLETE states ensure
    learnings are captured before workflow is considered truly done.
    """
    INITIALIZED = auto()
    EXECUTING = auto()
    COMPLETED = auto()           # All phases done, but learnings not captured
    HALTED = auto()
    REMEDIATION = auto()
    LEARNINGS_PENDING = auto()   # Workflow done, awaiting learnings capture
    FULLY_COMPLETE = auto()      # Including learnings - TRUE completion


@dataclass
class PhaseInfo:
    """Information about a phase in execution."""
    phase_id: str
    name: str
    type: PhaseType
    status: str = "pending"
    attempts: int = 0
    output: Dict[str, Any] = field(default_factory=dict)


@dataclass
class ParallelBranchInfo:
    """Information about a parallel branch in execution."""
    branch_id: str
    name: str
    status: str = "pending"  # pending, in_progress, completed, failed
    output: Dict[str, Any] = field(default_factory=dict)
    error: Optional[str] = None
    fail_on_error: bool = False


class SkillFSM:
    """
    Finite State Machine for skill phase orchestration.

    Handles the complexity of:
    - Sub-phases (0.5, 0.6) as discrete states
    - Optional phases that can be skipped
    - Iterative phases with loop counters
    - AUTO phases that execute Python without agents
    """

    def __init__(self, skill_name: str):
        """Initialize FSM for a specific skill."""
        self.skill_name = skill_name
        self.phases = get_skill_phases(skill_name)

        if not self.phases:
            raise ValueError(f"Unknown skill: {skill_name}")

        # Build phase order from config
        self.phase_order = get_phase_list(skill_name)

        # Initialize tracking
        self.current_phase_id: Optional[str] = None
        self.state: SkillPhaseState = SkillPhaseState.INITIALIZED
        self.history: List[str] = ["INITIALIZED"]
        self.phase_info: Dict[str, PhaseInfo] = {}

        # Initialize phase info for all phases
        for phase_id in self.phase_order:
            config = self.phases[phase_id]
            self.phase_info[phase_id] = PhaseInfo(
                phase_id=phase_id,
                name=config["name"],
                type=config["type"],
            )

        # Iteration tracking for iterative phases
        self.iteration_counters: Dict[str, int] = {}

        # Skip tracking for optional phases
        self.skipped_phases: List[str] = []

        # Parallel branch tracking
        self.parallel_branches: Dict[str, Dict[str, ParallelBranchInfo]] = {}

    def start(self) -> str:
        """Start the FSM, transition to first phase."""
        if self.state != SkillPhaseState.INITIALIZED:
            raise ValueError("FSM already started")

        self.current_phase_id = self.phase_order[0]
        self.state = SkillPhaseState.EXECUTING
        self.history.append(f"PHASE_{self.current_phase_id.replace('.', '_')}")
        self.phase_info[self.current_phase_id].status = "in_progress"

        return self.current_phase_id

    def get_current_phase(self) -> Optional[str]:
        """Get current phase ID."""
        return self.current_phase_id

    def get_current_phase_config(self) -> Optional[Dict[str, Any]]:
        """Get configuration for current phase."""
        if self.current_phase_id:
            return get_phase_config(self.skill_name, self.current_phase_id)
        return None

    def can_transition(self, to_phase: str, verified: bool = False) -> bool:
        """
        Check if transition to target phase is valid.

        ENFORCEMENT: Transitions require verification flag for non-optional phases.
        This ensures phases actually executed before advancement.

        Args:
            to_phase: Target phase ID
            verified: Whether the current phase execution has been verified
                     (memory file exists, agent completed, etc.)

        Returns:
            True if transition is allowed, False otherwise
        """
        if self.state in (SkillPhaseState.COMPLETED, SkillPhaseState.HALTED):
            return False

        if self.current_phase_id is None:
            return to_phase == self.phase_order[0]

        current_config = self.phases.get(self.current_phase_id)
        if not current_config:
            return False

        # ENFORCEMENT: Require verification for non-optional phases
        # Cannot transition without proof that current phase executed
        current_type = current_config.get("type")
        if current_type != PhaseType.OPTIONAL and not verified:
            # Non-optional phase requires verification before advancement
            return False

        # Valid transitions:
        # 1. To the 'next' phase in config
        # 2. Skip to a later phase (for optional phases)
        # 3. Loop back (for iterative/remediation phases)

        next_phase = current_config.get("next")
        if to_phase == next_phase:
            return True

        # Allow skipping optional phases
        if to_phase in self.phase_order:
            current_idx = self.phase_order.index(self.current_phase_id)
            target_idx = self.phase_order.index(to_phase)
            if target_idx > current_idx:
                # Check if intermediate phases are optional
                for i in range(current_idx + 1, target_idx):
                    intermediate = self.phases.get(self.phase_order[i])
                    if intermediate and intermediate["type"] != PhaseType.OPTIONAL:
                        return False
                return True

        return False

    def transition(
        self,
        to_phase: Optional[str] = None,
        skip_reason: str = None,
        verified: bool = False,
    ) -> str:
        """
        Transition to next phase.

        ENFORCEMENT: Non-optional phases require verified=True to transition.

        Args:
            to_phase: Target phase (None for natural next)
            skip_reason: Reason for skipping phases (for optional phases)
            verified: Whether current phase execution has been verified

        Returns:
            The new current phase ID
        """
        if self.state in (SkillPhaseState.COMPLETED, SkillPhaseState.HALTED):
            raise ValueError(f"Cannot transition from {self.state.name} state")

        # Mark current phase as completed
        if self.current_phase_id:
            self.phase_info[self.current_phase_id].status = "completed"

        # Determine target phase
        if to_phase is None:
            current_config = self.phases.get(self.current_phase_id)
            to_phase = current_config.get("next") if current_config else None

        # Check for completion
        if to_phase is None:
            self.state = SkillPhaseState.COMPLETED
            self.history.append("COMPLETED")
            return "COMPLETED"

        # Validate transition (ENFORCEMENT: passes verified flag)
        if not self.can_transition(to_phase, verified=verified):
            current_config = self.phases.get(self.current_phase_id, {})
            current_type = current_config.get("type", "unknown")
            raise ValueError(
                f"Invalid transition from {self.current_phase_id} to {to_phase}. "
                f"Phase type is {current_type}. "
                f"{'Verification required for non-optional phases.' if not verified else ''}"
            )

        # Handle skipped phases
        if self.current_phase_id:
            current_idx = self.phase_order.index(self.current_phase_id)
            target_idx = self.phase_order.index(to_phase)
            for i in range(current_idx + 1, target_idx):
                skipped = self.phase_order[i]
                self.skipped_phases.append(skipped)
                self.phase_info[skipped].status = "skipped"
                self.phase_info[skipped].output["skip_reason"] = skip_reason or "optional"
                self.history.append(f"SKIPPED_{skipped.replace('.', '_')}")

        # Execute transition
        self.current_phase_id = to_phase
        self.history.append(f"PHASE_{to_phase.replace('.', '_')}")
        self.phase_info[to_phase].status = "in_progress"

        return to_phase

    def skip_phase(self, phase_id: str, reason: str) -> None:
        """Mark a phase as skipped."""
        if phase_id in self.phase_info:
            self.skipped_phases.append(phase_id)
            self.phase_info[phase_id].status = "skipped"
            self.phase_info[phase_id].output["skip_reason"] = reason

    def complete_phase(self, output: Dict[str, Any] = None) -> None:
        """Mark current phase as completed with output."""
        if self.current_phase_id:
            self.phase_info[self.current_phase_id].status = "completed"
            if output:
                self.phase_info[self.current_phase_id].output = output

    def halt(self, reason: str) -> None:
        """Halt the FSM with a reason."""
        self.state = SkillPhaseState.HALTED
        self.history.append(f"HALTED: {reason}")

    def is_completed(self) -> bool:
        """Check if FSM has completed all phases (but may still need learnings)."""
        return self.state == SkillPhaseState.COMPLETED

    def is_halted(self) -> bool:
        """Check if FSM is halted."""
        return self.state == SkillPhaseState.HALTED

    def is_fully_complete(self) -> bool:
        """Check if FSM is truly complete (including learnings)."""
        return self.state == SkillPhaseState.FULLY_COMPLETE

    def is_learnings_pending(self) -> bool:
        """Check if FSM is waiting for learnings capture."""
        return self.state == SkillPhaseState.LEARNINGS_PENDING

    def is_final(self) -> bool:
        """Check if FSM is in a final state."""
        return self.state in (
            SkillPhaseState.COMPLETED,
            SkillPhaseState.HALTED,
            SkillPhaseState.LEARNINGS_PENDING,
            SkillPhaseState.FULLY_COMPLETE,
        )

    def require_learnings(self) -> None:
        """
        ENFORCEMENT: Transition from COMPLETED to LEARNINGS_PENDING.

        Workflows cannot be considered complete until learnings are captured.
        This is called by common_skill_complete.py.
        """
        if self.state != SkillPhaseState.COMPLETED:
            raise ValueError(
                f"Cannot require learnings from state {self.state.name}. "
                f"Must be in COMPLETED state first."
            )
        self.state = SkillPhaseState.LEARNINGS_PENDING
        self.history.append("LEARNINGS_PENDING")

    def complete_learnings(self) -> None:
        """
        ENFORCEMENT: Transition from LEARNINGS_PENDING to FULLY_COMPLETE.

        Called after develop-learnings has been executed.
        """
        if self.state != SkillPhaseState.LEARNINGS_PENDING:
            raise ValueError(
                f"Cannot complete learnings from state {self.state.name}. "
                f"Must be in LEARNINGS_PENDING state first."
            )
        self.state = SkillPhaseState.FULLY_COMPLETE
        self.history.append("FULLY_COMPLETE")

    def get_phase_type(self, phase_id: str = None) -> Optional[PhaseType]:
        """Get type of a phase (or current phase if not specified)."""
        phase_id = phase_id or self.current_phase_id
        if phase_id and phase_id in self.phases:
            return self.phases[phase_id]["type"]
        return None

    def is_auto_phase(self, phase_id: str = None) -> bool:
        """Check if phase is an AUTO phase (Python execution, no agent)."""
        return self.get_phase_type(phase_id) == PhaseType.AUTO

    def is_parallel_phase(self, phase_id: str = None) -> bool:
        """Check if phase is a PARALLEL phase (concurrent execution)."""
        return self.get_phase_type(phase_id) == PhaseType.PARALLEL

    def get_parallel_branches(self, phase_id: str = None) -> Optional[Dict[str, Any]]:
        """Get parallel branch configuration for a phase."""
        phase_id = phase_id or self.current_phase_id
        if phase_id and phase_id in self.phases:
            return self.phases[phase_id].get("parallel_branches")
        return None

    def initialize_parallel_branches(self, phase_id: str = None) -> Dict[str, ParallelBranchInfo]:
        """Initialize tracking for parallel branches in a phase."""
        phase_id = phase_id or self.current_phase_id
        if not phase_id:
            return {}

        branches_config = self.get_parallel_branches(phase_id)
        if not branches_config:
            return {}

        self.parallel_branches[phase_id] = {}
        for branch_id, config in branches_config.items():
            self.parallel_branches[phase_id][branch_id] = ParallelBranchInfo(
                branch_id=branch_id,
                name=config.get("name", branch_id),
                fail_on_error=config.get("fail_on_error", False),
            )

        return self.parallel_branches[phase_id]

    def start_parallel_branch(self, phase_id: str, branch_id: str) -> None:
        """Mark a parallel branch as started."""
        if phase_id in self.parallel_branches:
            if branch_id in self.parallel_branches[phase_id]:
                self.parallel_branches[phase_id][branch_id].status = "in_progress"

    def complete_parallel_branch(
        self, phase_id: str, branch_id: str, output: Dict[str, Any] = None
    ) -> None:
        """Mark a parallel branch as completed with output."""
        if phase_id in self.parallel_branches:
            if branch_id in self.parallel_branches[phase_id]:
                self.parallel_branches[phase_id][branch_id].status = "completed"
                if output:
                    self.parallel_branches[phase_id][branch_id].output = output

    def fail_parallel_branch(
        self, phase_id: str, branch_id: str, error: str
    ) -> None:
        """Mark a parallel branch as failed with error message."""
        if phase_id in self.parallel_branches:
            if branch_id in self.parallel_branches[phase_id]:
                self.parallel_branches[phase_id][branch_id].status = "failed"
                self.parallel_branches[phase_id][branch_id].error = error

    def are_all_branches_complete(self, phase_id: str = None) -> bool:
        """Check if all parallel branches for a phase are complete (or failed)."""
        phase_id = phase_id or self.current_phase_id
        if phase_id not in self.parallel_branches:
            return True

        return all(
            branch.status in ("completed", "failed")
            for branch in self.parallel_branches[phase_id].values()
        )

    def get_parallel_results(self, phase_id: str = None) -> Dict[str, Dict[str, Any]]:
        """Get results from all parallel branches for a phase."""
        phase_id = phase_id or self.current_phase_id
        if phase_id not in self.parallel_branches:
            return {}

        return {
            branch_id: {
                "status": branch.status,
                "output": branch.output,
                "error": branch.error,
            }
            for branch_id, branch in self.parallel_branches[phase_id].items()
        }

    def has_critical_branch_failure(self, phase_id: str = None) -> bool:
        """Check if any critical (fail_on_error=True) branch has failed."""
        phase_id = phase_id or self.current_phase_id
        if phase_id not in self.parallel_branches:
            return False

        return any(
            branch.status == "failed" and branch.fail_on_error
            for branch in self.parallel_branches[phase_id].values()
        )

    def get_progress(self) -> Dict[str, Any]:
        """Get progress information."""
        total = len(self.phase_order)
        completed = sum(1 for p in self.phase_info.values() if p.status == "completed")
        skipped = len(self.skipped_phases)

        return {
            "total_phases": total,
            "completed": completed,
            "skipped": skipped,
            "remaining": total - completed - skipped,
            "current_phase": self.current_phase_id,
            "percent_complete": int((completed + skipped) / total * 100) if total > 0 else 0,
        }

    def to_dict(self) -> Dict[str, Any]:
        """Serialize FSM state to dictionary."""
        return {
            "skill_name": self.skill_name,
            "current_phase_id": self.current_phase_id,
            "state": self.state.name,
            "history": self.history,
            "phase_info": {
                pid: {
                    "phase_id": info.phase_id,
                    "name": info.name,
                    "type": info.type.name,
                    "status": info.status,
                    "attempts": info.attempts,
                    "output": info.output,
                }
                for pid, info in self.phase_info.items()
            },
            "iteration_counters": self.iteration_counters,
            "skipped_phases": self.skipped_phases,
            "parallel_branches": {
                phase_id: {
                    branch_id: {
                        "branch_id": branch.branch_id,
                        "name": branch.name,
                        "status": branch.status,
                        "output": branch.output,
                        "error": branch.error,
                        "fail_on_error": branch.fail_on_error,
                    }
                    for branch_id, branch in branches.items()
                }
                for phase_id, branches in self.parallel_branches.items()
            },
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "SkillFSM":
        """Deserialize FSM state from dictionary."""
        fsm = cls(data["skill_name"])
        fsm.current_phase_id = data["current_phase_id"]
        fsm.state = SkillPhaseState[data["state"]]
        fsm.history = data["history"]
        fsm.iteration_counters = data.get("iteration_counters", {})
        fsm.skipped_phases = data.get("skipped_phases", [])

        # Restore phase info
        for pid, info_data in data.get("phase_info", {}).items():
            if pid in fsm.phase_info:
                fsm.phase_info[pid].status = info_data["status"]
                fsm.phase_info[pid].attempts = info_data.get("attempts", 0)
                fsm.phase_info[pid].output = info_data.get("output", {})

        # Restore parallel branches
        for phase_id, branches_data in data.get("parallel_branches", {}).items():
            fsm.parallel_branches[phase_id] = {}
            for branch_id, branch_data in branches_data.items():
                fsm.parallel_branches[phase_id][branch_id] = ParallelBranchInfo(
                    branch_id=branch_data["branch_id"],
                    name=branch_data["name"],
                    status=branch_data["status"],
                    output=branch_data.get("output", {}),
                    error=branch_data.get("error"),
                    fail_on_error=branch_data.get("fail_on_error", False),
                )

        return fsm
