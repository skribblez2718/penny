"""
Centralized path management for orchestration - SINGLE SOURCE OF TRUTH.

All orchestration modules should import paths from here rather than
computing them locally. This eliminates the 175+ variations of
sys.path.insert() scattered across step files.

Usage:
    import sys
    from pathlib import Path
    sys.path.insert(0, str(Path(__file__).parent.parent.parent))  # to orchestration
    from paths import ORCHESTRATION_ROOT, setup_paths

    # Or simply:
    import paths  # Auto-configures sys.path on import
"""
from __future__ import annotations

import sys
from pathlib import Path

# Core path constants - computed once, used everywhere
ORCHESTRATION_ROOT = Path(__file__).parent
CLAUDE_ROOT = ORCHESTRATION_ROOT.parent
PROJECT_ROOT = CLAUDE_ROOT.parent

# Protocol directories (NEW UNIFIED STRUCTURE)
PROTOCOLS_DIR = ORCHESTRATION_ROOT / "protocols"
REASONING_PROTOCOL_DIR = PROTOCOLS_DIR / "reasoning"
EXECUTION_PROTOCOLS_DIR = PROTOCOLS_DIR / "execution"
AGENT_PROTOCOLS_DIR = PROTOCOLS_DIR / "agent"
SKILL_PROTOCOLS_DIR = PROTOCOLS_DIR / "skill"

# Support directories
SHARED_DIR = ORCHESTRATION_ROOT / "shared"

# Backwards compatibility aliases
SHARED_CONTENT_DIR = SHARED_DIR

# Memory and state
MEMORY_DIR = CLAUDE_ROOT / "memory"
LEARNINGS_DIR = CLAUDE_ROOT / "learnings"


def setup_paths() -> None:
    """
    Add orchestration root to sys.path if not already present.

    Call this at module load time to enable absolute imports from
    the orchestration root. Idempotent - safe to call multiple times.
    """
    root_str = str(ORCHESTRATION_ROOT)
    if root_str not in sys.path:
        sys.path.insert(0, root_str)


def get_agent_dir(agent_name: str) -> Path:
    """Get the directory path for a specific agent."""
    return AGENT_PROTOCOLS_DIR / agent_name


def get_agent_steps_dir(agent_name: str) -> Path:
    """Get the steps directory for a specific agent."""
    return get_agent_dir(agent_name) / "steps"


def get_agent_content_dir(agent_name: str) -> Path:
    """Get the content directory for a specific agent."""
    return get_agent_dir(agent_name) / "content"


def get_composite_skill_dir(skill_name: str) -> Path:
    """Get the directory path for a composite skill."""
    return SKILL_PROTOCOLS_DIR / "composite" / skill_name


def get_atomic_skill_dir(skill_name: str) -> Path:
    """Get the directory path for an atomic skill."""
    return SKILL_PROTOCOLS_DIR / "atomic" / skill_name


def get_memory_file_path(task_id: str, agent_name: str) -> Path:
    """Build the memory file path for an agent's output."""
    return MEMORY_DIR / f"{task_id}-{agent_name}-memory.md"


def get_skill_state_file(skill_name: str, session_id: str) -> Path:
    """Build the state file path for a skill session."""
    return SKILL_PROTOCOLS_DIR / "state" / f"{skill_name}-{session_id}.json"


def get_agent_state_file(agent_name: str, task_id: str) -> Path:
    """Build the state file path for an agent session."""
    return AGENT_PROTOCOLS_DIR / "state" / f"{agent_name}-{task_id}.json"


def get_reasoning_state_file(session_id: str) -> Path:
    """Build the state file path for a reasoning session."""
    return REASONING_PROTOCOL_DIR / "state" / f"reasoning-{session_id}.json"


def get_execution_state_file(protocol_name: str, session_id: str) -> Path:
    """Build the state file path for an execution protocol session."""
    return EXECUTION_PROTOCOLS_DIR / protocol_name / "state" / f"{protocol_name}-{session_id}.json"


# Auto-setup on import - this is the key feature that eliminates boilerplate
setup_paths()
