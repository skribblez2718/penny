"""
Orchestration System Root Package
==================================

Provides centralized path management and shared utilities for all orchestration
modules. Import paths from here instead of using sys.path.insert patterns.

Usage:
    from orchestration import ORCHESTRATION_ROOT, AGENT_PROTOCOLS_DIR
    # OR
    from orchestration.paths import get_orchestration_root
"""

from pathlib import Path

# ============================================================================
# CANONICAL PATH DEFINITIONS
# ============================================================================
# All orchestration modules should import paths from here instead of
# computing them locally with sys.path.insert patterns.

ORCHESTRATION_ROOT = Path(__file__).resolve().parent
"""Root directory of the orchestration system."""

CLAUDE_ROOT = ORCHESTRATION_ROOT.parent
"""Root of .claude directory."""

PROJECT_ROOT = CLAUDE_ROOT.parent
"""Root of the project."""

# --- Protocol Directories (NEW UNIFIED STRUCTURE) ---
PROTOCOLS_DIR = ORCHESTRATION_ROOT / "protocols"
"""Parent directory for all protocol types."""

AGENT_PROTOCOLS_DIR = PROTOCOLS_DIR / "agent"
"""Directory containing cognitive agent protocols."""

EXECUTION_PROTOCOLS_DIR = PROTOCOLS_DIR / "execution"
"""Directory containing execution protocols (skill-orchestration, dynamic-skill-sequencing)."""

REASONING_PROTOCOL_DIR = PROTOCOLS_DIR / "reasoning"
"""Directory containing the 9-step reasoning protocol."""

SKILL_PROTOCOLS_DIR = PROTOCOLS_DIR / "skill"
"""Directory containing skill protocols (atomic and composite)."""

# --- Support Directories ---
SHARED_DIR = ORCHESTRATION_ROOT / "shared"
"""Directory containing reusable markdown content."""

# Backwards compatibility aliases
SHARED_CONTENT_DIR = SHARED_DIR

# --- Skill Protocol Sub-directories ---
ATOMIC_SKILLS_DIR = SKILL_PROTOCOLS_DIR / "atomic"
"""Directory containing atomic skill wrappers."""

COMPOSITE_SKILLS_DIR = SKILL_PROTOCOLS_DIR / "composite"
"""Directory containing composite skill orchestrations."""

SKILL_STATE_DIR = SKILL_PROTOCOLS_DIR / "state"
"""Directory for skill execution state files."""

# --- External Directories ---
SKILLS_DIR = CLAUDE_ROOT / "skills"
"""Directory containing skill SKILL.md definitions and resources."""

LEARNINGS_DIR = CLAUDE_ROOT / "learnings"
"""Directory containing domain-specific learnings."""

MEMORY_DIR = CLAUDE_ROOT / "memory"
"""Directory for agent memory files."""

PLANS_DIR = CLAUDE_ROOT / "plans"
"""Directory for plan tracking files."""

# ============================================================================
# AGENT DIRECTORIES
# ============================================================================

AGENT_DIRS = {
    "clarification": AGENT_PROTOCOLS_DIR / "clarification",
    "research": AGENT_PROTOCOLS_DIR / "research",
    "analysis": AGENT_PROTOCOLS_DIR / "analysis",
    "synthesis": AGENT_PROTOCOLS_DIR / "synthesis",
    "generation": AGENT_PROTOCOLS_DIR / "generation",
    "validation": AGENT_PROTOCOLS_DIR / "validation",
    "memory": AGENT_PROTOCOLS_DIR / "memory",
}
"""Mapping of agent names to their directories."""

# Backwards compatibility: map old names to new
AGENT_NAME_ALIASES = {
    "clarification": "clarification",
    "research": "research",
    "analysis": "analysis",
    "synthesis": "synthesis",
    "generation": "generation",
    "validation": "validation",
    "memory": "memory",
}


def normalize_agent_name(agent_name: str) -> str:
    """Normalize agent name to canonical short form.

    Args:
        agent_name: Name of the agent (old or new format)

    Returns:
        Canonical agent name (e.g., "analysis", "memory")
    """
    return AGENT_NAME_ALIASES.get(agent_name, agent_name)


def get_agent_dir(agent_name: str) -> Path:
    """Get the directory for a specific agent.

    Args:
        agent_name: Name of the agent (e.g., "clarification" or "clarification")

    Returns:
        Path to the agent's directory

    Raises:
        ValueError: If agent_name is not recognized
    """
    normalized = normalize_agent_name(agent_name)
    if normalized not in AGENT_DIRS:
        raise ValueError(f"Unknown agent: {agent_name}. Valid agents: {list(AGENT_DIRS.keys())}")
    return AGENT_DIRS[normalized]


def get_agent_step_script(agent_name: str, step_num: int, step_name: str) -> Path:
    """Get the path to an agent's step script.

    Args:
        agent_name: Name of the agent
        step_num: Step number (0-indexed)
        step_name: Name of the step (e.g., "learning_injection")

    Returns:
        Path to the step script
    """
    return get_agent_dir(agent_name) / "steps" / f"step_{step_num}_{step_name}.py"


def get_agent_content_file(agent_name: str, step_num: int) -> Path:
    """Get the path to an agent's step content file.

    Args:
        agent_name: Name of the agent
        step_num: Step number

    Returns:
        Path to the step content markdown file
    """
    return get_agent_dir(agent_name) / "content" / f"step_{step_num}.md"


# ============================================================================
# SKILL DIRECTORIES
# ============================================================================

COMPOSITE_SKILL_NAMES = [
    "develop_skill",
    "develop_learnings",
]
"""List of registered composite skill names (underscore format)."""


def get_composite_skill_dir(skill_name: str) -> Path:
    """Get the orchestration directory for a composite skill.

    Args:
        skill_name: Name of the skill (dash or underscore format)

    Returns:
        Path to the skill's orchestration directory
    """
    # Normalize to underscore format (directory naming convention)
    normalized = skill_name.replace("-", "_")
    return COMPOSITE_SKILLS_DIR / normalized


def get_skill_content_file(skill_name: str, phase_id: str) -> Path:
    """Get the path to a skill's phase content file.

    Args:
        skill_name: Name of the skill
        phase_id: Phase identifier (e.g., "0", "0_5", "1")

    Returns:
        Path to the phase content markdown file
    """
    return get_composite_skill_dir(skill_name) / "content" / f"phase_{phase_id}.md"


def get_skill_definition_file(skill_name: str) -> Path:
    """Get the path to a skill's SKILL.md definition file.

    Args:
        skill_name: Name of the skill

    Returns:
        Path to the SKILL.md file in .claude/skills/
    """
    # Skill definitions use dash format
    normalized = skill_name.replace("_", "-")
    return SKILLS_DIR / normalized / "SKILL.md"


# ============================================================================
# MEMORY FILE HELPERS
# ============================================================================

def get_memory_file_path(task_id: str, agent_name: str) -> Path:
    """Get the path to an agent's memory file.

    Args:
        task_id: Task identifier
        agent_name: Name of the agent

    Returns:
        Path to the memory file
    """
    return MEMORY_DIR / f"{task_id}-{agent_name}-memory.md"


def get_goal_memory_file_path(task_id: str, from_phase: str, to_phase: str) -> Path:
    """Get the path to a goal-memory phase transition file.

    Args:
        task_id: Task identifier
        from_phase: Source phase ID
        to_phase: Target phase ID

    Returns:
        Path to the goal-memory file
    """
    return MEMORY_DIR / f"{task_id}-goal-memory-phase-{from_phase}-to-{to_phase}-memory.md"


# ============================================================================
# STATE FILE HELPERS
# ============================================================================

def get_reasoning_state_dir() -> Path:
    """Get the directory for reasoning protocol state files."""
    return REASONING_PROTOCOL_DIR / "state"


def get_execution_state_dir(protocol_name: str) -> Path:
    """Get the directory for execution protocol state files.

    Args:
        protocol_name: Name of the protocol ("skill-orchestration" or "dynamic-skill-sequencing")

    Returns:
        Path to the state directory
    """
    return EXECUTION_PROTOCOLS_DIR / protocol_name / "state"


def get_skill_state_file(skill_name: str, session_id: str) -> Path:
    """Get the path to a skill's state file.

    Args:
        skill_name: Name of the skill
        session_id: Session identifier

    Returns:
        Path to the state file
    """
    normalized = skill_name.replace("_", "-")
    return SKILL_STATE_DIR / f"{normalized}-{session_id}.json"


def get_agent_state_file(agent_name: str, task_id: str) -> Path:
    """Get the path to an agent's state file.

    Args:
        agent_name: Name of the agent
        task_id: Task identifier

    Returns:
        Path to the state file
    """
    return AGENT_PROTOCOLS_DIR / "state" / f"{agent_name}-{task_id}.json"


# ============================================================================
# EXPORTS
# ============================================================================

__all__ = [
    # Root paths
    "ORCHESTRATION_ROOT",
    "CLAUDE_ROOT",
    "PROJECT_ROOT",
    # Protocol directories
    "PROTOCOLS_DIR",
    "AGENT_PROTOCOLS_DIR",
    "EXECUTION_PROTOCOLS_DIR",
    "REASONING_PROTOCOL_DIR",
    "SKILL_PROTOCOLS_DIR",
    # Support directories
    "SHARED_DIR",
    # Backwards compatibility
    "SHARED_CONTENT_DIR",
    # Skill sub-directories
    "ATOMIC_SKILLS_DIR",
    "COMPOSITE_SKILLS_DIR",
    "SKILL_STATE_DIR",
    # External directories
    "SKILLS_DIR",
    "LEARNINGS_DIR",
    "MEMORY_DIR",
    "PLANS_DIR",
    # Agent helpers
    "AGENT_DIRS",
    "AGENT_NAME_ALIASES",
    "normalize_agent_name",
    "get_agent_dir",
    "get_agent_step_script",
    "get_agent_content_file",
    # Skill helpers
    "COMPOSITE_SKILL_NAMES",
    "get_composite_skill_dir",
    "get_skill_content_file",
    "get_skill_definition_file",
    # Memory helpers
    "get_memory_file_path",
    "get_goal_memory_file_path",
    # State helpers
    "get_reasoning_state_dir",
    "get_execution_state_dir",
    "get_skill_state_file",
    "get_agent_state_file",
]
