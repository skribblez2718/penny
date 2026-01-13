"""
core package
============

Core components for the Mandatory Reasoning Protocol.
"""

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
from reasoning.core.universal_learnings import (
    TaskContext,
    extract_task_context,
    should_evaluate_for_learnings,
    generate_learning_evaluation_prompt,
    check_and_prompt_learnings,
)

__all__ = [
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
    # Universal learnings exports
    "TaskContext",
    "extract_task_context",
    "should_evaluate_for_learnings",
    "generate_learning_evaluation_prompt",
    "check_and_prompt_learnings",
]
