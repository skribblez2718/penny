"""
protocols/reasoning package
==========================

Mandatory Reasoning Protocol orchestration using Python-enforced
deterministic step execution.

This package provides:
- FSM-based state management
- 9-step reasoning protocol enforcement (Step 0 + Steps 1-8)
- Response capture and chaining between steps

Directory Structure:
- config/: Configuration and paths
- core/: FSM, state management, semantic routing
- steps/: Individual step scripts (base.py + step_N_*.py)
- content/: Markdown instructions for each step
- state/: Session state files (JSON)

Entry Points:
- entry.py: Protocol initiation
- complete.py: Protocol finalization
"""

import sys
from pathlib import Path

# Ensure protocols directory is in path for fully-qualified imports
# This prevents collision between reasoning/config and skill/config
_REASONING_ROOT = Path(__file__).resolve().parent
_PROTOCOLS_DIR = _REASONING_ROOT.parent

if str(_PROTOCOLS_DIR) not in sys.path:
    sys.path.insert(0, str(_PROTOCOLS_DIR))

from reasoning.config.config import (
    ORCHESTRATION_ROOT,
    STEPS_DIR,
    CONTENT_DIR,
    STATE_DIR,
    PROTOCOL_NAME,
    PROTOCOL_VERSION,
    TOTAL_STEPS,
    STEP_NAMES,
    STEP_TITLES,
)
from reasoning.core.fsm import ReasoningFSM, ReasoningState
from reasoning.core.state import ProtocolState
from reasoning.core.semantic_routing import (
    SemanticRoutingContext,
    EXECUTION_ROUTES,
    generate_routing_prompt,
    build_routing_context,
    generate_routing_prompt_from_state,
)
from reasoning.core.set_route import VALID_ROUTES

__all__ = [
    # Config exports
    "ORCHESTRATION_ROOT",
    "STEPS_DIR",
    "CONTENT_DIR",
    "STATE_DIR",
    "PROTOCOL_NAME",
    "PROTOCOL_VERSION",
    "TOTAL_STEPS",
    "STEP_NAMES",
    "STEP_TITLES",
    # FSM exports
    "ReasoningFSM",
    "ReasoningState",
    # State exports
    "ProtocolState",
    # Semantic routing exports
    "SemanticRoutingContext",
    "EXECUTION_ROUTES",
    "generate_routing_prompt",
    "build_routing_context",
    "generate_routing_prompt_from_state",
    # Set route exports
    "VALID_ROUTES",
]
