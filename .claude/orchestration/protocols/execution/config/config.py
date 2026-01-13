"""
config.py
=========

Configuration for execution protocols.

This module defines:
- Protocol types and their configurations
- Route mapping from reasoning protocol
- Paths and constants
- Step definitions for each protocol
"""

import sys
from enum import Enum, auto
from pathlib import Path
from typing import Dict, List

# =============================================================================
# Path Setup
# =============================================================================

# Config module location - navigate up to protocol root
_CONFIG_DIR = Path(__file__).resolve().parent
_EXECUTION_PROTOCOLS_ROOT = _CONFIG_DIR.parent

# Ensure protocol root is in path for imports
if str(_EXECUTION_PROTOCOLS_ROOT) not in sys.path:
    sys.path.insert(0, str(_EXECUTION_PROTOCOLS_ROOT))


# =============================================================================
# Paths
# =============================================================================

# Root of execution protocols
EXECUTION_PROTOCOLS_ROOT = _EXECUTION_PROTOCOLS_ROOT

# Orchestration root (parent of protocols/execution)
ORCHESTRATION_ROOT = EXECUTION_PROTOCOLS_ROOT.parent


# =============================================================================
# Protocol Types
# =============================================================================

class ProtocolType(Enum):
    """Types of execution protocols."""
    SKILL_ORCHESTRATION = auto()
    DYNAMIC_SKILL_SEQUENCING = auto()


# =============================================================================
# Route Mapping
# =============================================================================

# Valid routes from reasoning protocol (canonical short names)
VALID_ROUTES = [
    "skill",
    "dynamic",
]

# Legacy route aliases for backwards compatibility
ROUTE_ALIASES: Dict[str, str] = {
    "skill-orchestration": "skill",
    "dynamic-skill-sequencing": "dynamic",
}

def normalize_route_name(route: str) -> str:
    """Convert legacy route names to canonical short names."""
    return ROUTE_ALIASES.get(route, route)

# Map route strings to protocol types (canonical short names)
ROUTE_TO_PROTOCOL: Dict[str, ProtocolType] = {
    "skill": ProtocolType.SKILL_ORCHESTRATION,
    "dynamic": ProtocolType.DYNAMIC_SKILL_SEQUENCING,
    # Legacy aliases for backwards compatibility
    "skill-orchestration": ProtocolType.SKILL_ORCHESTRATION,
    "dynamic-skill-sequencing": ProtocolType.DYNAMIC_SKILL_SEQUENCING,
}

# Map protocol types to directory names (canonical short names)
PROTOCOL_TO_DIR: Dict[ProtocolType, str] = {
    ProtocolType.SKILL_ORCHESTRATION: "skill",
    ProtocolType.DYNAMIC_SKILL_SEQUENCING: "dynamic",
}


# =============================================================================
# Protocol Step Definitions
# =============================================================================

# Skill Orchestration Protocol - 6 steps
SKILL_ORCHESTRATION_STEPS: Dict[int, Dict[str, str]] = {
    1: {
        "name": "GENERATE_TASK_ID",
        "title": "Generate Task ID",
        "script": "step_1_generate_task_id.py",
    },
    2: {
        "name": "CLASSIFY_DOMAIN",
        "title": "Classify Domain",
        "script": "step_2_classify_domain.py",
    },
    3: {
        "name": "READ_SKILL",
        "title": "Read Skill Definition",
        "script": "step_3_read_skill.py",
    },
    4: {
        "name": "CREATE_MEMORY",
        "title": "Create Memory File",
        "script": "step_4_create_memory.py",
    },
    5: {
        "name": "TRIGGER_AGENTS",
        "title": "Trigger Cognitive Agents",
        "script": "step_5_trigger_agents.py",
    },
    6: {
        "name": "COMPLETE_WORKFLOW",
        "title": "Complete Workflow",
        "script": "step_6_complete_workflow.py",
    },
}

# Dynamic Skill Sequencing Protocol - 5 steps
DYNAMIC_SKILL_SEQUENCING_STEPS: Dict[int, Dict[str, str]] = {
    1: {
        "name": "ANALYZE_REQUIREMENTS",
        "title": "Analyze Task Requirements",
        "script": "step_1_analyze_requirements.py",
    },
    2: {
        "name": "PLAN_SEQUENCE",
        "title": "Plan Skill Sequence",
        "script": "step_2_plan_sequence.py",
    },
    3: {
        "name": "INVOKE_SKILLS",
        "title": "Invoke Skills in Sequence",
        "script": "step_3_invoke_skills.py",
    },
    4: {
        "name": "VERIFY_COMPLETION",
        "title": "Verify Completion",
        "script": "step_4_verify_completion.py",
    },
    5: {
        "name": "COMPLETE",
        "title": "Complete Workflow",
        "script": "step_5_complete.py",
    },
}

# Map protocol type to step definitions
PROTOCOL_STEPS: Dict[ProtocolType, Dict[int, Dict[str, str]]] = {
    ProtocolType.SKILL_ORCHESTRATION: SKILL_ORCHESTRATION_STEPS,
    ProtocolType.DYNAMIC_SKILL_SEQUENCING: DYNAMIC_SKILL_SEQUENCING_STEPS,
}

# Total steps per protocol
PROTOCOL_TOTAL_STEPS: Dict[ProtocolType, int] = {
    ProtocolType.SKILL_ORCHESTRATION: 6,
    ProtocolType.DYNAMIC_SKILL_SEQUENCING: 5,
}


# =============================================================================
# State Configuration
# =============================================================================

SCHEMA_VERSION = "1.0"
EXECUTION_PROTOCOL_VERSION = "1.0"


# =============================================================================
# Helper Functions
# =============================================================================

def get_protocol_dir(protocol_type: ProtocolType) -> Path:
    """Get the directory path for a protocol type."""
    dir_name = PROTOCOL_TO_DIR[protocol_type]
    return EXECUTION_PROTOCOLS_ROOT / dir_name


def get_protocol_steps_dir(protocol_type: ProtocolType) -> Path:
    """Get the steps directory for a protocol type."""
    return get_protocol_dir(protocol_type) / "steps"


def get_protocol_content_dir(protocol_type: ProtocolType) -> Path:
    """Get the content directory for a protocol type."""
    return get_protocol_dir(protocol_type) / "content"


def get_protocol_state_dir(protocol_type: ProtocolType) -> Path:
    """Get the state directory for a protocol type."""
    return get_protocol_dir(protocol_type) / "state"


def get_step_script_path(protocol_type: ProtocolType, step_num: int) -> Path:
    """Get the path to a step script."""
    steps = PROTOCOL_STEPS.get(protocol_type, {})
    step_info = steps.get(step_num, {})
    script_name = step_info.get("script", f"step_{step_num}.py")
    return get_protocol_steps_dir(protocol_type) / script_name


def get_step_content_path(protocol_type: ProtocolType, step_num: int) -> Path:
    """Get the path to a step's markdown content."""
    steps = PROTOCOL_STEPS.get(protocol_type, {})
    step_info = steps.get(step_num, {})
    step_name = step_info.get("name", "").lower()
    if step_name:
        return get_protocol_content_dir(protocol_type) / f"step_{step_num}_{step_name}.md"
    return get_protocol_content_dir(protocol_type) / f"step_{step_num}.md"


def get_state_file_path(protocol_type: ProtocolType, session_id: str) -> Path:
    """Get the path to a state file for a protocol session."""
    dir_name = PROTOCOL_TO_DIR[protocol_type]
    return get_protocol_state_dir(protocol_type) / f"{dir_name}-{session_id}.json"


def format_mandatory_directive(
    command: str,
    context: str = "",
    protocol_type: ProtocolType | None = None
) -> str:
    """
    Format a mandatory execution directive.

    This wording is designed to be unambiguous about the requirement
    to execute before any other action. The strong language ensures
    Claude treats this as a non-negotiable command.

    Args:
        command: The command to execute (without backticks)
        context: Optional context about what this step accomplishes
        protocol_type: Optional protocol type for step count info

    Returns:
        Formatted directive string with mandatory enforcement language
    """
    total_steps = ""
    if protocol_type:
        total = PROTOCOL_TOTAL_STEPS.get(protocol_type, 0)
        if total:
            total_steps = f" ({total} steps) "

    directive = f"""
**MANDATORY - EXECUTE IMMEDIATELY BEFORE ANY OTHER ACTION:**
`{command}`

⚠️ The Execution Protocol{total_steps}MUST complete ALL steps before task work concludes.
{context}DO NOT proceed with any other action until this command is executed.
"""
    return directive.strip()
