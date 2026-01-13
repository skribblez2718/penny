"""
Skill Protocols Configuration Package.

Exports all configuration constants and helper functions.
"""

import sys
from pathlib import Path

# Path setup - add protocols directory for fully-qualified imports
# This prevents collision between skill/config and agent/config
_CONFIG_DIR = Path(__file__).resolve().parent
_SKILL_PROTOCOLS_ROOT = _CONFIG_DIR.parent
_PROTOCOLS_DIR = _SKILL_PROTOCOLS_ROOT.parent
if str(_PROTOCOLS_DIR) not in sys.path:
    sys.path.insert(0, str(_PROTOCOLS_DIR))

from skill.config.config import (
    # Enums
    PhaseType,
    SkillType,
    # Registries
    ATOMIC_SKILLS,
    COMPOSITE_SKILLS,
    SKILL_PHASES,
    # Phase definitions (only those that exist in config.py)
    DEVELOP_SKILL_PHASES,
    DEVELOP_LEARNINGS_PHASES,
    # Directory paths
    COMPOSITE_DIR,
    ATOMIC_DIR,
    AGENT_PROTOCOLS_DIR,
    # Helper functions
    get_skill_type,
    get_skill_phases,
    get_phase_config,
    get_atomic_skill_agent,
    get_first_phase,
    get_phase_list,
    get_composite_skill_dir,
    get_agent_protocol_dir,
    format_skill_directive,
)

__all__ = [
    # Enums
    "PhaseType",
    "SkillType",
    # Registries
    "ATOMIC_SKILLS",
    "COMPOSITE_SKILLS",
    "SKILL_PHASES",
    # Phase definitions
    "DEVELOP_SKILL_PHASES",
    "DEVELOP_LEARNINGS_PHASES",
    # Directory paths
    "COMPOSITE_DIR",
    "ATOMIC_DIR",
    "AGENT_PROTOCOLS_DIR",
    # Helper functions
    "get_skill_type",
    "get_skill_phases",
    "get_phase_config",
    "get_atomic_skill_agent",
    "get_first_phase",
    "get_phase_list",
    "get_composite_skill_dir",
    "get_agent_protocol_dir",
    "format_skill_directive",
]
