"""
Skill Protocols - Python-enforced orchestration for Claude Code skills.

This module provides infrastructure for executing skill workflows with:
- FSM-based phase transitions (including sub-phases like 0.5, 0.6)
- State persistence across phases
- Atomic skill wrappers that invoke protocols/agent
- Composite skill orchestration

Directory Structure:
    skill/
    ├── __init__.py          # This file
    ├── config/              # Skill registry, phase definitions
    │   ├── __init__.py
    │   └── config.py
    ├── core/                # Core infrastructure
    │   ├── __init__.py
    │   ├── fsm.py           # SkillFSM with complex phase handling
    │   ├── state.py         # SkillExecutionState
    │   ├── advance_phase.py # Phase transitions with verification
    │   ├── agent_invoker.py # Task tool invocation builder
    │   └── execution_verifier.py  # Hard enforcement
    ├── steps/               # Phase step base classes
    │   ├── __init__.py
    │   └── base.py          # BasePhase, AutoPhase
    ├── atomic/              # Thin wrappers invoking protocols/agent
    │   ├── __init__.py
    │   ├── base.py          # BaseAtomicSkill
    │   ├── enforcer.py      # Atomic skill enforcement
    │   └── orchestrate_*.py # Atomic skill implementations
    └── composite/           # Full phase orchestration per skill
"""

from pathlib import Path

# Directory paths
SKILL_PROTOCOLS_ROOT = Path(__file__).parent
ORCHESTRATION_ROOT = SKILL_PROTOCOLS_ROOT.parent
CLAUDE_ROOT = ORCHESTRATION_ROOT.parent
PROJECT_ROOT = CLAUDE_ROOT.parent

# Sub-directories
ATOMIC_DIR = SKILL_PROTOCOLS_ROOT / "atomic"
COMPOSITE_DIR = SKILL_PROTOCOLS_ROOT / "composite"
STATE_DIR = SKILL_PROTOCOLS_ROOT / "state"
CONFIG_DIR = SKILL_PROTOCOLS_ROOT / "config"
CORE_DIR = SKILL_PROTOCOLS_ROOT / "core"
STEPS_DIR = SKILL_PROTOCOLS_ROOT / "steps"

# Related orchestration directories
AGENT_PROTOCOLS_DIR = ORCHESTRATION_ROOT / "agent"
EXECUTION_PROTOCOLS_DIR = ORCHESTRATION_ROOT / "execution"
REASONING_PROTOCOL_DIR = ORCHESTRATION_ROOT / "reasoning"

# Skills directory (source of truth for SKILL.md files)
SKILLS_DIR = CLAUDE_ROOT / "skills"

__all__ = [
    # Path constants
    "SKILL_PROTOCOLS_ROOT",
    "ORCHESTRATION_ROOT",
    "CLAUDE_ROOT",
    "PROJECT_ROOT",
    "ATOMIC_DIR",
    "COMPOSITE_DIR",
    "STATE_DIR",
    "CONFIG_DIR",
    "CORE_DIR",
    "STEPS_DIR",
    "AGENT_PROTOCOLS_DIR",
    "EXECUTION_PROTOCOLS_DIR",
    "REASONING_PROTOCOL_DIR",
    "SKILLS_DIR",
]
