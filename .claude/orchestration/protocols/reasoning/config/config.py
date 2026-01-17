"""
config.py
=========

Configuration and path constants for the Mandatory Reasoning Protocol orchestration.

This module provides centralized configuration for:
- Directory paths
- File naming conventions
- Protocol metadata
"""

import sys
from pathlib import Path
from typing import Final

# Import shared directive core (use sys.path.insert - NEVER relative imports)
_ORCHESTRATION_ROOT = Path(__file__).resolve().parent.parent.parent.parent
if str(_ORCHESTRATION_ROOT) not in sys.path:
    sys.path.insert(0, str(_ORCHESTRATION_ROOT))
from directives.base import _format_directive_core

# Path setup - navigate to reasoning protocol root
_CONFIG_DIR = Path(__file__).resolve().parent
_REASONING_ROOT = _CONFIG_DIR.parent

# Base directories
ORCHESTRATION_ROOT: Final[Path] = _REASONING_ROOT
STEPS_DIR: Final[Path] = _REASONING_ROOT / "steps"
CONTENT_DIR: Final[Path] = _REASONING_ROOT / "content"
STATE_DIR: Final[Path] = _REASONING_ROOT / "state"
TESTS_DIR: Final[Path] = _REASONING_ROOT / "tests"

# Protocol metadata
PROTOCOL_NAME: Final[str] = "mandatory-protocols/reasoning"
PROTOCOL_VERSION: Final[str] = "1.0"
SCHEMA_VERSION: Final[str] = "1.0"

# Step configuration
# Protocol has 9 steps: Step 0 (Johari Discovery) + Steps 1-8
TOTAL_STEPS: Final[int] = 9  # 0-8 inclusive

STEP_NAMES: Final[dict[int, str]] = {
    0: "JOHARI_DISCOVERY",
    1: "SEMANTIC_UNDERSTANDING",
    2: "CHAIN_OF_THOUGHT",
    3: "TREE_OF_THOUGHT",
    4: "TASK_ROUTING",
    5: "SELF_CONSISTENCY",
    6: "SOCRATIC_INTERROGATION",
    7: "CONSTITUTIONAL_CRITIQUE",
    8: "KNOWLEDGE_TRANSFER",
}

STEP_TITLES: Final[dict[int, str]] = {
    0: "Johari Window Discovery",
    1: "Semantic Understanding",
    2: "Chain of Thought Decomposition",
    3: "Tree of Thought Exploration",
    4: "Task Routing Decision",
    5: "Self-Consistency Verification",
    6: "Socratic Self-Interrogation",
    7: "Constitutional Self-Critique",
    8: "Knowledge Transfer Checkpoint",
}

# File patterns
STATE_FILE_PATTERN: Final[str] = "reasoning-{session_id}.json"
STEP_CONTENT_PATTERN: Final[str] = "step_{step_num}_{step_name}.md"
STEP_SCRIPT_PATTERN: Final[str] = "step_{step_num}_{step_name}.py"


def get_state_file_path(session_id: str) -> Path:
    """Get the path to a state file for a given session ID."""
    return STATE_DIR / STATE_FILE_PATTERN.format(session_id=session_id)


def get_step_content_path(step_num: int) -> Path:
    """Get the path to a step's markdown content file."""
    step_name = STEP_NAMES.get(step_num, "unknown").lower()
    return CONTENT_DIR / STEP_CONTENT_PATTERN.format(step_num=step_num, step_name=step_name)


def get_step_script_path(step_num: int) -> Path:
    """Get the path to a step's Python script."""
    step_name = STEP_NAMES.get(step_num, "unknown").lower()
    return STEPS_DIR / STEP_SCRIPT_PATTERN.format(step_num=step_num, step_name=step_name)


# Ensure directories exist
def ensure_directories() -> None:
    """Create required directories if they don't exist."""
    for directory in [STEPS_DIR, CONTENT_DIR, STATE_DIR, TESTS_DIR]:
        directory.mkdir(parents=True, exist_ok=True)


def format_mandatory_directive(command: str, context: str = "") -> str:
    """
    Format a mandatory reasoning directive.

    This wording is designed to be unambiguous about the requirement
    to execute before any other action. The strong language ensures
    Claude treats this as a non-negotiable command.

    Args:
        command: The command to execute (without backticks)
        context: Optional context about what this step accomplishes

    Returns:
        Formatted directive string with mandatory enforcement language
    """
    return _format_directive_core(
        command,
        context,
        warnings=[
            "CRITICAL: Execute this command NOW. Do NOT respond with text first.",
            "The reasoning protocol MUST complete before ANY task work begins.",
            "FAILURE to execute this directive breaks the system's reliability guarantee.",
        ]
    )
