"""
Skill Protocols Configuration - Registry for skills and phase definitions.

Defines:
- PhaseType enum for different phase patterns
- Skill registry mapping skill names to configurations
- Phase definitions for each skill
- Helper functions for skill/phase lookups
"""

from __future__ import annotations

import sys
from enum import Enum, auto
from typing import Dict, List, Optional, Any
from pathlib import Path

# Path setup - navigate from config/ to skill protocol root
_CONFIG_DIR = Path(__file__).resolve().parent
_SKILL_PROTOCOLS_ROOT = _CONFIG_DIR.parent
_ORCHESTRATION_ROOT = _SKILL_PROTOCOLS_ROOT.parent
if str(_SKILL_PROTOCOLS_ROOT) not in sys.path:
    sys.path.insert(0, str(_SKILL_PROTOCOLS_ROOT))

# Directory paths (using skill protocol root's __init__.py constants)
COMPOSITE_DIR = _SKILL_PROTOCOLS_ROOT / "composite"
ATOMIC_DIR = _SKILL_PROTOCOLS_ROOT / "atomic"
AGENT_PROTOCOLS_DIR = _ORCHESTRATION_ROOT / "protocols/agent"


class PhaseType(Enum):
    """Types of phases in skill workflows."""
    LINEAR = auto()      # Standard sequential phase
    OPTIONAL = auto()    # Conditional phase (may be skipped based on trigger)
    ITERATIVE = auto()   # Loop phase (3A, 3B, 3C, 3D pattern)
    REMEDIATION = auto() # Re-try phase after validation failure
    AUTO = auto()        # DEPRECATED: Use LINEAR with appropriate agent instead
    PARALLEL = auto()    # Execute multiple branches concurrently, merge results


class SkillType(Enum):
    """Types of skills."""
    ATOMIC = auto()      # Single agent wrapper
    COMPOSITE = auto()   # Multi-phase workflow


# =============================================================================
# ATOMIC SKILL REGISTRY
# =============================================================================
# Atomic skills are thin wrappers that invoke protocols/agent

ATOMIC_SKILLS: Dict[str, Dict[str, Any]] = {
    "orchestrate-clarification": {
        "agent": "clarification",
        "cognitive_function": "CLARIFICATION",
        "description": "Transform vague inputs into actionable specifications",
        "semantic_trigger": "ambiguity resolution, requirements refinement",
        "not_for": "well-defined tasks with clear specifications",
    },
    "orchestrate-analysis": {
        "agent": "analysis",
        "cognitive_function": "ANALYSIS",
        "description": "Decompose complexity, assess risks, map dependencies",
        "semantic_trigger": "complexity decomposition, risk assessment",
        "not_for": "simple tasks without dependencies",
    },
    "orchestrate-research": {
        "agent": "research",
        "cognitive_function": "RESEARCH",
        "description": "Investigate options, gather domain knowledge",
        "semantic_trigger": "knowledge gaps, options exploration",
        "not_for": "tasks with complete information",
    },
    "orchestrate-synthesis": {
        "agent": "synthesis",
        "cognitive_function": "SYNTHESIS",
        "description": "Integrate findings into coherent designs",
        "semantic_trigger": "integration of findings, design creation",
        "not_for": "single-source tasks without integration",
    },
    "orchestrate-generation": {
        "agent": "generation",
        "cognitive_function": "GENERATION",
        "description": "Create artifacts using TDD methodology",
        "semantic_trigger": "artifact creation, TDD implementation",
        "not_for": "read-only or research tasks",
    },
    "orchestrate-validation": {
        "agent": "validation",
        "cognitive_function": "VALIDATION",
        "description": "Verify artifacts against quality criteria",
        "semantic_trigger": "quality verification, acceptance testing",
        "not_for": "tasks without deliverables to verify",
    },
    "orchestrate-memory": {
        "agent": "memory",
        "cognitive_function": "METACOGNITION",
        "description": "Metacognitive assessment of workflow state and progress",
        "semantic_trigger": "progress tracking, impasse detection",
        "not_for": "simple linear workflows",
    },
}


# =============================================================================
# COMPOSITE SKILL REGISTRY
# =============================================================================
# Composite skills orchestrate multiple phases with atomic skills

COMPOSITE_SKILLS: Dict[str, Dict[str, Any]] = {
    "develop-skill": {
        "description": "Meta-skill for creating and modifying workflow skills",
        "semantic_trigger": "create skill, modify skill, update workflow, new skill",
        "not_for": "system modifications, direct code execution, architecture changes",
        "composition_depth": 0,
        "phases": "DEVELOP_SKILL_PHASES",  # Reference to phase config below
    },
    "develop-learnings": {
        "description": "Transform workflow experiences into structured learnings",
        "semantic_trigger": "capture learnings, document insights, preserve knowledge",
        "not_for": "mid-workflow tasks, skill creation, active execution",
        "composition_depth": 0,
        "phases": "DEVELOP_LEARNINGS_PHASES",
    },
    "develop-command": {
        "description": "Create and manage Claude Code slash commands",
        "semantic_trigger": "create command, slash command, modify command, utility command",
        "not_for": "workflow skills, multi-phase operations, cognitive workflows",
        "composition_depth": 0,
        "phases": "DEVELOP_COMMAND_PHASES",
    },
    "perform-research": {
        "description": "Production-grade research with adaptive depth and quality validation",
        "semantic_trigger": "deep research, comprehensive investigation, multi-source research, literature review, research with validation, academic research, thorough research",
        "not_for": "quick lookups, simple searches, single-source queries, \"what is X\" questions",
        "composition_depth": 0,
        "phases": "PERFORM_RESEARCH_PHASES",
    },
}


# =============================================================================
# PHASE DEFINITIONS - develop-skill
# =============================================================================

DEVELOP_SKILL_PHASES: Dict[str, Dict[str, Any]] = {
    "0": {
        "name": "REQUIREMENTS_CLARIFICATION",
        "title": "Requirements Clarification",
        "type": PhaseType.LINEAR,
        "uses_atomic_skill": "orchestrate-clarification",
        "script": "phase_0_requirements_clarification.py",
        "content": "phase_0_requirements_clarification.md",
        "next": "0.5",
        "description": "Clarify skill requirements via Socratic questioning",
    },
    "0.5": {
        "name": "ATOMIC_PROVISIONING",
        "title": "Atomic Skill Provisioning",
        "type": PhaseType.LINEAR,  # Changed from AUTO - all phases use agents
        "uses_atomic_skill": "orchestrate-generation",  # Creates missing atomic skills
        "script": "phase_0_5_atomic_provisioning.py",
        "content": "phase_0_5_atomic_provisioning.md",
        "trigger": "phase_0_identifies_missing_atomics",
        "next": "0.6",
        "description": "Verify/create required atomic skills",
    },
    "0.6": {
        "name": "COMPOSITE_VALIDATION",
        "title": "Composite Skill Validation",
        "type": PhaseType.LINEAR,  # Changed from AUTO - all phases use agents
        "uses_atomic_skill": "orchestrate-validation",  # Validates composite references
        "script": "phase_0_6_composite_validation.py",
        "content": "phase_0_6_composite_validation.md",
        "trigger": "phase_0_identifies_composite_references",
        "next": "1",
        "description": "Validate composite skill references and depth",
    },
    "1": {
        "name": "COMPLEXITY_ANALYSIS",
        "title": "Complexity Analysis",
        "type": PhaseType.LINEAR,
        "uses_atomic_skill": "orchestrate-analysis",
        "script": "phase_1_complexity_analysis.py",
        "content": "phase_1_complexity_analysis.md",
        "next": "1.5",
        "description": "Analyze skill complexity and dependencies",
    },
    "1.5": {
        "name": "PATTERN_RESEARCH",
        "title": "Pattern Research",
        "type": PhaseType.LINEAR,
        "uses_atomic_skill": "orchestrate-research",
        "script": "phase_1_5_pattern_research.py",
        "content": "phase_1_5_pattern_research.md",
        "configuration": {"research_depth": "standard"},
        "next": "2",
        "description": "Research similar skill patterns",
    },
    "2": {
        "name": "DESIGN_SYNTHESIS",
        "title": "Design Synthesis",
        "type": PhaseType.LINEAR,
        "uses_atomic_skill": "orchestrate-synthesis",
        "script": "phase_2_design_synthesis.py",
        "content": "phase_2_design_synthesis.md",
        "next": "3",
        "description": "Synthesize optimal cognitive flow",
    },
    "3": {
        "name": "SKILL_GENERATION",
        "title": "Skill Generation",
        "type": PhaseType.LINEAR,
        "uses_atomic_skill": "orchestrate-generation",
        "script": "phase_3_skill_generation.py",
        "content": "phase_3_skill_generation.md",
        "next": "4",
        "description": "Generate skill SKILL.md file",
    },
    "4": {
        "name": "SKILL_VALIDATION",
        "title": "Skill Validation",
        "type": PhaseType.LINEAR,
        "uses_atomic_skill": "orchestrate-validation",
        "script": "phase_4_skill_validation.py",
        "content": "phase_4_skill_validation.md",
        "configuration": {
            "validation_target": "orchestrate-generation",
            "quality_criteria": [
                "orchestration-only",
                "sequential-agents",
                "zero-redundancy",
                "atomic-references-valid",
                "composite-references-valid",
                "depth-constraint-satisfied",
            ],
        },
        "next": "5",
        "description": "Validate skill against orchestration checklist",
    },
    "5": {
        "name": "DA_REGISTRATION",
        "title": "DA.md Registration",
        "type": PhaseType.LINEAR,
        "uses_atomic_skill": "orchestrate-generation",
        "content": "phase_5_da_registration.md",
        "next": None,  # Final phase
        "description": "Register new skill in DA.md",
    },
}


# =============================================================================
# PHASE DEFINITIONS - develop-learnings
# =============================================================================

DEVELOP_LEARNINGS_PHASES: Dict[str, Dict[str, Any]] = {
    "1": {
        "name": "DISCOVERY",
        "title": "Discovery",
        "type": PhaseType.LINEAR,
        "uses_atomic_skill": "orchestrate-analysis",
        "script": "phase_1_discovery.py",
        "content": "phase_1_discovery.md",
        "next": "2",
        "description": "Identify resolved Unknowns and map to candidate learning records",
    },
    "2": {
        "name": "PER_FUNCTION_AUTHORING",
        "title": "Per-Function Authoring",
        "type": PhaseType.ITERATIVE,
        "uses_atomic_skill": None,  # Multi-agent: all 6 agents sequentially
        "script": "phase_2_per_function_authoring.py",
        "content": "phase_2_per_function_authoring.md",
        "iteration_agents": [
            "clarification",
            "research",
            "analysis",
            "synthesis",
            "generation",
            "validation",
        ],
        "next": "2.5",
        "description": "Each agent proposes normalized learning entries",
    },
    "2.5": {
        "name": "INTEGRATION_ANALYSIS",
        "title": "Integration Analysis",
        "type": PhaseType.LINEAR,
        "uses_atomic_skill": "orchestrate-synthesis",
        "script": "phase_2_5_integration_analysis.py",
        "content": "phase_2_5_integration_analysis.md",
        "next": "3",
        "description": "Determine which learnings should integrate into skills/protocols",
    },
    "3": {
        "name": "CONSOLIDATION",
        "title": "Consolidation",
        "type": PhaseType.LINEAR,
        "uses_atomic_skill": "orchestrate-synthesis",
        "script": "phase_3_consolidation.py",
        "content": "phase_3_consolidation.md",
        "next": "4",
        "description": "Merge overlapping entries, ensure consistent IDs/tags",
    },
    "4": {
        "name": "VALIDATION",
        "title": "Validation",
        "type": PhaseType.REMEDIATION,
        "uses_atomic_skill": "orchestrate-validation",
        "script": "phase_4_validation.py",
        "content": "phase_4_validation.md",
        "remediation_target": "2",
        "max_remediation": 1,
        "next": "5",
        "description": "Validate learnings against update rubric",
    },
    "5": {
        "name": "COMMIT",
        "title": "Commit",
        "type": PhaseType.LINEAR,
        "uses_atomic_skill": "orchestrate-generation",  # Generation agent writes learnings
        "script": "phase_5_commit.py",
        "content": "phase_5_commit.md",
        "next": "5.5",
        "description": "Write approved learnings to learnings files",
    },
    "5.5": {
        "name": "POST_INTEGRATION_CLEANUP",
        "title": "Post-Integration Cleanup",
        "type": PhaseType.LINEAR,
        "uses_atomic_skill": "orchestrate-analysis",
        "script": "phase_5_5_post_integration_cleanup.py",
        "content": "phase_5_5_post_integration_cleanup.md",
        "next": None,
        "description": "Apply skill integrations and evaluate learning retention",
    },
}


# =============================================================================
# PHASE DEFINITIONS - develop-command
# =============================================================================

DEVELOP_COMMAND_PHASES: Dict[str, Dict[str, Any]] = {
    "0": {
        "name": "REQUIREMENTS_CLARIFICATION",
        "title": "Requirements Clarification",
        "type": PhaseType.LINEAR,
        "uses_atomic_skill": "orchestrate-clarification",
        "script": None,
        "content": "phase_0_requirements_clarification.md",
        "next": "1",
        "description": "Clarify command requirements and category placement",
    },
    "1": {
        "name": "COMMAND_GENERATION",
        "title": "Command Generation",
        "type": PhaseType.LINEAR,
        "uses_atomic_skill": "orchestrate-generation",
        "script": None,
        "content": "phase_1_command_generation.md",
        "next": "2",
        "description": "Generate command file with frontmatter and bash script",
    },
    "2": {
        "name": "COMMAND_VALIDATION",
        "title": "Command Validation",
        "type": PhaseType.LINEAR,
        "uses_atomic_skill": "orchestrate-validation",
        "script": None,
        "content": "phase_2_command_validation.md",
        "next": None,
        "description": "Validate command and update DA.md registration",
    },
}


# =============================================================================
# PHASE DEFINITIONS - perform-research
# =============================================================================

PERFORM_RESEARCH_PHASES: Dict[str, Dict[str, Any]] = {
    "0": {
        "name": "REQUIREMENTS_CLARIFICATION",
        "title": "Requirements Clarification",
        "type": PhaseType.LINEAR,
        "uses_atomic_skill": "orchestrate-clarification",
        "content": "phase_0_requirements_clarification.md",
        "next": "1",
        "description": "Clarify research scope, depth, and source priorities using Johari Window",
    },
    "1": {
        "name": "PARALLEL_RESEARCH",
        "title": "Parallel Research Execution",
        "type": PhaseType.PARALLEL,
        "uses_atomic_skill": None,  # Branches define their own agents
        "content": "phase_1_parallel_research.md",
        "next": "1.5",
        "description": "Execute three parallel research branches (native, Perplexity, Tavily)",
        "parallel_branches": {
            "1A": {
                "name": "Native WebSearch",
                "uses_atomic_skill": "orchestrate-research",
                "fail_on_error": False,  # Resilient: continue if this branch fails
            },
            "1B": {
                "name": "Perplexity Search",
                "uses_atomic_skill": "orchestrate-research",
                "fail_on_error": False,  # Resilient: continue if API key missing
            },
            "1C": {
                "name": "Tavily Search",
                "uses_atomic_skill": "orchestrate-research",
                "fail_on_error": False,  # Resilient: continue if API key missing
            },
        },
    },
    "1.5": {
        "name": "RESULT_SYNTHESIS",
        "title": "Result Synthesis",
        "type": PhaseType.LINEAR,
        "uses_atomic_skill": "orchestrate-synthesis",
        "content": "phase_1_5_result_synthesis.md",
        "next": "2",
        "description": "Merge and deduplicate findings from parallel research branches",
    },
    "2": {
        "name": "COMPLETENESS_VALIDATION",
        "title": "Completeness Validation",
        "type": PhaseType.REMEDIATION,
        "uses_atomic_skill": "orchestrate-validation",
        "content": "phase_2_completeness_validation.md",
        "remediation_target": "1",  # Re-execute Phase 1 if validation fails
        "max_remediation": 2,  # Maximum 2 remediation loops
        "next": "3",
        "description": "Validate research quality with remediation loop if gaps found",
    },
    "3": {
        "name": "SYNTHESIS",
        "title": "Synthesis",
        "type": PhaseType.LINEAR,
        "uses_atomic_skill": "orchestrate-synthesis",
        "content": "phase_3_synthesis.md",
        "next": "4",
        "description": "Integrate validated findings into coherent narrative",
    },
    "4": {
        "name": "REPORT_GENERATION",
        "title": "Report Generation",
        "type": PhaseType.LINEAR,
        "uses_atomic_skill": "orchestrate-generation",
        "content": "phase_4_report_generation.md",
        "next": None,  # Final phase
        "description": "Generate final research report to .claude/research/",
        "configuration": {
            "output_directory": ".claude/research/",
            "output_format": "markdown",
        },
    },
}


# =============================================================================
# SKILL PHASE REGISTRY
# =============================================================================
# Maps skill names to their phase configurations

SKILL_PHASES: Dict[str, Dict[str, Dict[str, Any]]] = {
    "develop-skill": DEVELOP_SKILL_PHASES,
    "develop-learnings": DEVELOP_LEARNINGS_PHASES,
    "develop-command": DEVELOP_COMMAND_PHASES,
    "perform-research": PERFORM_RESEARCH_PHASES,
}


# =============================================================================
# HELPER FUNCTIONS
# =============================================================================

def get_skill_type(skill_name: str) -> Optional[SkillType]:
    """Get the type of a skill."""
    if skill_name in ATOMIC_SKILLS:
        return SkillType.ATOMIC
    elif skill_name in COMPOSITE_SKILLS:
        return SkillType.COMPOSITE
    return None


def get_skill_phases(skill_name: str) -> Optional[Dict[str, Dict[str, Any]]]:
    """Get phase definitions for a composite skill."""
    return SKILL_PHASES.get(skill_name)


def get_phase_config(skill_name: str, phase_id: str) -> Optional[Dict[str, Any]]:
    """Get configuration for a specific phase."""
    phases = get_skill_phases(skill_name)
    if phases:
        return phases.get(phase_id)
    return None


def get_atomic_skill_agent(skill_name: str) -> Optional[str]:
    """Get the agent name for an atomic skill."""
    if skill_name in ATOMIC_SKILLS:
        return ATOMIC_SKILLS[skill_name]["agent"]
    return None


def get_first_phase(skill_name: str) -> Optional[str]:
    """Get the first phase ID for a skill (usually '0' or '1')."""
    phases = get_skill_phases(skill_name)
    if not phases:
        return None

    # Check common starting phases
    for start in ["0", "1"]:
        if start in phases:
            return start

    # Fallback: find phase with no predecessor (nothing points to it as 'next')
    all_next = {p.get("next") for p in phases.values() if p.get("next")}
    for phase_id in phases:
        if phase_id not in all_next:
            return phase_id

    return None


def get_phase_list(skill_name: str) -> List[str]:
    """Get ordered list of phase IDs for a skill."""
    phases = get_skill_phases(skill_name)
    if not phases:
        return []

    # Build ordered list by following 'next' pointers
    ordered = []
    current = get_first_phase(skill_name)

    while current is not None:
        if current in phases:
            ordered.append(current)
            current = phases[current].get("next")
        else:
            break

    return ordered


def get_composite_skill_dir(skill_name: str) -> Path:
    """Get the directory for a composite skill's Python files."""
    return COMPOSITE_DIR / skill_name


def get_agent_protocol_dir(agent_name: str) -> Path:
    """Get the directory for an agent protocol."""
    return AGENT_PROTOCOLS_DIR / agent_name


def format_skill_directive(
    command: str,
    skill_name: str,
    phase_id: str,
    context: str = "",
) -> str:
    """
    Format a mandatory execution directive for skill phases.

    This matches the format used in protocols/reasoning/config/config.py:format_mandatory_directive
    to ensure Claude treats skill phase execution as non-negotiable.

    Args:
        command: The command to execute (without backticks)
        skill_name: Name of the skill being executed
        phase_id: Current phase ID (e.g., "0", "0.5", "1")
        context: Optional context about what this phase accomplishes

    Returns:
        Formatted directive string with mandatory enforcement language
    """
    phases = get_skill_phases(skill_name)
    total_phases = len(phases) if phases else 9

    directive = f"""
**MANDATORY - EXECUTE IMMEDIATELY BEFORE ANY OTHER ACTION:**
`{command}`

⚠️ This is Phase {phase_id} of {total_phases} in the {skill_name} workflow.
{context}DO NOT proceed with any other action until this command is executed.
"""
    return directive.strip()
