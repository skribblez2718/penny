"""
config.py
=========

Agent registry and configuration for the Agent Execution Protocols.

This module provides centralized configuration for all cognitive agents,
including their step sequences, colors, and model preferences.
"""

import sys
from pathlib import Path
from typing import Final

# Base directories - navigate up from config/ to agent/
AGENT_PROTOCOLS_ROOT: Final[Path] = Path(__file__).parent.parent

# Import shared directive core (use sys.path.insert - NEVER relative imports)
_ORCHESTRATION_ROOT = AGENT_PROTOCOLS_ROOT.parent.parent
if str(_ORCHESTRATION_ROOT) not in sys.path:
    sys.path.insert(0, str(_ORCHESTRATION_ROOT))
from directives.base import _format_directive_core

# Agent registry with metadata
AGENT_REGISTRY: Final[dict[str, dict]] = {
    "clarification": {
        "cognitive_function": "CLARIFICATION",
        "description": "Transform vague inputs into actionable specifications",
        "steps": [
            "learning_injection",
            "johari_discovery",
            "context_assessment",
            "question_formulation",
            "systematic_interrogation",
            "specification_construction",
            "knowledge_synthesis",
        ],
        "color": "cyan",
        "model": "sonnet",
    },
    "research": {
        "cognitive_function": "RESEARCH",
        "description": "Systematic information discovery and evaluation",
        "steps": [
            "learning_injection",
            "johari_discovery",
            "context_extraction",
            "unknown_resolution",
            "strategy_formulation",
            "discovery_process",
            "synthesis_documentation",
        ],
        "color": "blue",
        "model": "sonnet",
    },
    "analysis": {
        "cognitive_function": "ANALYSIS",
        "description": "Decompose complexity and identify patterns",
        "steps": [
            "learning_injection",
            "johari_discovery",
            "context_extraction",
            "decomposition",
            "evaluation",
            "pattern_synthesis",
            "output_generation",
        ],
        "color": "green",
        "model": "opus",
    },
    "synthesis": {
        "cognitive_function": "SYNTHESIS",
        "description": "Integrate disparate information into coherent designs",
        "steps": [
            "learning_injection",
            "johari_discovery",
            "context_loading",
            "integration_mapping",
            "conflict_resolution",
            "framework_construction",
            "validation_prep",
        ],
        "color": "magenta",
        "model": "opus",
    },
    "generation": {
        "cognitive_function": "GENERATION",
        "description": "Create artifacts using domain-appropriate creation cycles",
        "steps": [
            "learning_injection",
            "johari_discovery",
            "context_extraction",
            "creation_cycle",
            "artifact_generation",
            "quality_checks",
            "output_preparation",
        ],
        "color": "yellow",
        "model": "sonnet",
    },
    "validation": {
        "cognitive_function": "VALIDATION",
        "description": "Systematically verify artifacts against criteria",
        "steps": [
            "learning_injection",
            "johari_discovery",
            "criteria_loading",
            "systematic_verification",
            "gap_analysis",
            "gate_decision",
        ],
        "color": "red",
        "model": "sonnet",
    },
    "memory": {
        "cognitive_function": "METACOGNITION",
        "description": "Metacognitive monitor for impasse detection and remediation",
        "steps": [
            "learning_injection",
            "johari_discovery",
            "context_loading",
            "goal_reconstruction",
            "progress_assessment",
            "impasse_detection",
            "remediation_determination",
            "output_generation",
        ],
        "color": "purple",
        "model": "haiku",
    },
}

# Backwards compatibility: map old names to new canonical names
AGENT_NAME_ALIASES: Final[dict[str, str]] = {
    "clarification-agent": "clarification",
    "research-agent": "research",
    "analysis-agent": "analysis",
    "synthesis-agent": "synthesis",
    "generation-agent": "generation",
    "validation-agent": "validation",
    "goal-memory-agent": "memory",
}


def normalize_agent_name(agent_name: str) -> str:
    """Normalize agent name to canonical short form."""
    return AGENT_NAME_ALIASES.get(agent_name, agent_name)


# --- Context Budget Configuration ---
# Based on ACT-R buffer constraints and cognitive load theory

AGENT_CONTEXT_BUDGETS: Final[dict[str, dict]] = {
    "clarification": {
        "max_input_tokens": 2000,
        "max_output_tokens": 1500,
        "priority_sections": ["task_description", "user_query", "unknowns"],
    },
    "research": {
        "max_input_tokens": 3000,
        "max_output_tokens": 2500,
        "priority_sections": ["research_queries", "unknowns", "constraints"],
    },
    "analysis": {
        "max_input_tokens": 2500,
        "max_output_tokens": 2000,
        "priority_sections": ["research_findings", "constraints", "trade_offs"],
    },
    "synthesis": {
        "max_input_tokens": 3000,
        "max_output_tokens": 2500,
        "priority_sections": ["analysis_output", "constraints", "design_decisions"],
    },
    "generation": {
        "max_input_tokens": 4000,
        "max_output_tokens": 8000,
        "priority_sections": ["specification", "design", "constraints"],
    },
    "validation": {
        "max_input_tokens": 2500,
        "max_output_tokens": 1500,
        "priority_sections": ["artifact", "criteria", "constraints"],
    },
    "memory": {
        "max_input_tokens": 1500,
        "max_output_tokens": 800,
        "priority_sections": ["agent_output_summary", "previous_goal_state"],
    },
}


def get_agent_budget(agent_name: str) -> dict:
    """Get context budget configuration for an agent."""
    normalized = normalize_agent_name(agent_name)
    return AGENT_CONTEXT_BUDGETS.get(normalized, {
        "max_input_tokens": 2500,
        "max_output_tokens": 2000,
        "priority_sections": [],
    })


def get_agent_config(agent_name: str) -> dict | None:
    """Get configuration for a specific agent."""
    normalized = normalize_agent_name(agent_name)
    return AGENT_REGISTRY.get(normalized)


def get_agent_steps(agent_name: str) -> list[str]:
    """Get the step sequence for a specific agent."""
    config = get_agent_config(agent_name)
    return config["steps"] if config else []


def get_agent_directory(agent_name: str) -> Path:
    """Get the directory path for a specific agent's protocol files."""
    normalized = normalize_agent_name(agent_name)
    return AGENT_PROTOCOLS_ROOT / normalized


def get_step_content_path(agent_name: str, step_num: int) -> Path:
    """Get the path to a step's markdown content file."""
    config = get_agent_config(agent_name)
    if config and step_num < len(config["steps"]):
        step_name = config["steps"][step_num]
        return get_agent_directory(agent_name) / "content" / f"step_{step_num}_{step_name}.md"
    return get_agent_directory(agent_name) / "content" / f"step_{step_num}.md"


def get_step_script_path(agent_name: str, step_num: int) -> Path:
    """
    Get the path to a step's Python script.

    Steps 0 (learning_injection) and 1 (johari_discovery) use shared
    implementations in steps/shared.py. All other steps use agent-specific
    implementations in the agent's steps/ directory.

    Args:
        agent_name: Name of the agent
        step_num: Step number (0-indexed)

    Returns:
        Path to the step script
    """
    # Steps 0 and 1 use shared implementations - ZERO REDUNDANCY
    if step_num in (0, 1):
        return AGENT_PROTOCOLS_ROOT / "steps" / "shared.py"

    # Agent-specific steps
    config = get_agent_config(agent_name)
    if config and step_num < len(config["steps"]):
        step_name = config["steps"][step_num]
        return get_agent_directory(agent_name) / "steps" / f"step_{step_num}_{step_name}.py"
    return get_agent_directory(agent_name) / "steps" / f"step_{step_num}.py"


def format_agent_directive(command: str, agent_name: str, step_num: int) -> str:
    """
    Format a mandatory execution directive for agent steps.

    This uses the centralized _format_directive_core() to ensure consistent
    directive formatting across all protocols.

    Args:
        command: The command to execute
        agent_name: Name of the agent
        step_num: Current step number

    Returns:
        Formatted directive string
    """
    config = get_agent_config(agent_name)
    total_steps = len(config["steps"]) if config else 0
    cognitive_function = config.get("cognitive_function", "UNKNOWN") if config else "UNKNOWN"

    context = f"Agent: {agent_name} ({cognitive_function})"

    return _format_directive_core(
        command,
        context,
        warnings=[
            f"AGENT EXECUTION - Step {step_num + 1} of {total_steps}.",
            "Execute this step before proceeding to the next.",
        ]
    )
