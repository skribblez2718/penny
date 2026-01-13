"""
Skill Protocols Core Package.

Exports core state management, FSM, and execution utilities.
"""

import sys
from pathlib import Path

# Path setup - add protocols directory for fully-qualified imports
# This prevents collision between skill/core and agent/core
_CORE_DIR = Path(__file__).resolve().parent
_SKILL_PROTOCOLS_ROOT = _CORE_DIR.parent
_PROTOCOLS_DIR = _SKILL_PROTOCOLS_ROOT.parent
if str(_PROTOCOLS_DIR) not in sys.path:
    sys.path.insert(0, str(_PROTOCOLS_DIR))

from skill.core.state import SkillExecutionState
from skill.core.fsm import SkillFSM, SkillPhaseState, PhaseInfo, ParallelBranchInfo
from skill.core.agent_invoker import (
    AGENT_SUBAGENT_MAP,
    CONTEXT_PATTERNS,
    build_agent_prompt,
    get_task_invocation,
    get_invocation_for_phase,
)
from skill.core.execution_verifier import (
    ExecutionVerifier,
    VerificationResult,
    PhaseNotVerifiedError,
    MemoryFileValidationError,
    GoalMemoryNotCompletedError,
    verify_phase,
    require_phase,
)

__all__ = [
    # State
    "SkillExecutionState",
    # FSM
    "SkillFSM",
    "SkillPhaseState",
    "PhaseInfo",
    "ParallelBranchInfo",
    # Agent Invoker
    "AGENT_SUBAGENT_MAP",
    "CONTEXT_PATTERNS",
    "build_agent_prompt",
    "get_task_invocation",
    "get_invocation_for_phase",
    # Execution Verifier
    "ExecutionVerifier",
    "VerificationResult",
    "PhaseNotVerifiedError",
    "MemoryFileValidationError",
    "GoalMemoryNotCompletedError",
    "verify_phase",
    "require_phase",
]
