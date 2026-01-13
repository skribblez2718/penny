"""
Base Atomic Skill - Abstract base class for atomic skill wrappers.

Atomic skills are thin wrappers that:
1. Build Task tool invocation payloads for agent invocation
2. Return expected memory file path
3. Do NOT contain cognitive logic (that's in the agent)

The invoke() method returns a dict suitable for Claude's Task tool,
rather than printing directives to stdout.
"""

from __future__ import annotations

import sys
from abc import ABC, abstractmethod
from typing import Any, Optional
from pathlib import Path

# Path setup - add protocols directory for fully-qualified imports
# This prevents collision between skill/config and agent/config
_ATOMIC_DIR = Path(__file__).resolve().parent
_SKILL_PROTOCOLS_ROOT = _ATOMIC_DIR.parent
_ORCHESTRATION_ROOT = _SKILL_PROTOCOLS_ROOT.parent
_PROTOCOLS_DIR = _ORCHESTRATION_ROOT
if str(_PROTOCOLS_DIR) not in sys.path:
    sys.path.insert(0, str(_PROTOCOLS_DIR))

# Directory paths (defined locally to avoid circular imports)
AGENT_PROTOCOLS_DIR = _ORCHESTRATION_ROOT / "agent"
CLAUDE_ROOT = _ORCHESTRATION_ROOT.parent

from skill.core.agent_invoker import get_invocation_for_phase


class BaseAtomicSkill(ABC):
    """
    Abstract base class for atomic skill wrappers.

    Each atomic skill maps 1:1 to a cognitive agent and provides
    a standardized interface for invoking that agent via Task tool.
    """

    @property
    @abstractmethod
    def skill_name(self) -> str:
        """Return the atomic skill name (e.g., 'orchestrate-clarification')."""
        pass

    @property
    @abstractmethod
    def agent_name(self) -> str:
        """Return the agent name (e.g., 'clarification')."""
        pass

    @property
    @abstractmethod
    def cognitive_function(self) -> str:
        """Return the cognitive function (e.g., 'CLARIFICATION')."""
        pass

    @property
    def description(self) -> str:
        """Return skill description."""
        return f"Invoke {self.agent_name} for {self.cognitive_function} cognitive function"

    def get_agent_entry_path(self) -> Path:
        """Get path to agent's entry.py script."""
        return AGENT_PROTOCOLS_DIR / self.agent_name / "entry.py"

    def get_memory_file_path(self, task_id: str) -> str:
        """
        Get expected memory file path for this agent invocation.

        Args:
            task_id: Task ID for the workflow

        Returns:
            Path to the memory file the agent will create
        """
        memory_dir = CLAUDE_ROOT / "memory"
        return str(memory_dir / f"{task_id}-{self.agent_name}-memory.md")

    def invoke(
        self,
        task_id: str,
        skill_name: Optional[str] = None,
        phase_id: Optional[str] = None,
        phase_name: Optional[str] = None,
        config: Optional[dict[str, Any]] = None,
    ) -> dict[str, Any]:
        """
        Return Task tool invocation parameters for agent invocation.

        This returns a dict that can be used with Claude's Task tool
        to spawn the agent as a subagent.

        Args:
            task_id: Task ID for the workflow
            skill_name: Name of the skill invoking this atomic
            phase_id: Phase ID within the skill
            phase_name: Human-readable phase name
            config: Optional configuration parameters including:
                - context_pattern: WORKFLOW_ONLY | IMMEDIATE_PREDECESSORS | MULTIPLE_PREDECESSORS
                - predecessors: List of predecessor agent names
                - instructions: Phase-specific instructions
                - domain: Task domain

        Returns:
            Dictionary with Task tool parameters:
            - subagent_type: The agent type for Task tool
            - prompt: Full instructions for the agent
            - description: Short summary
            - model: Model to use
            - Plus additional metadata for tracking
        """
        config = config or {}

        # Build the Task tool invocation
        invocation = get_invocation_for_phase(
            task_id=task_id,
            skill_name=skill_name or "adhoc",
            phase_id=phase_id or "0",
            phase_name=phase_name or self.cognitive_function,
            agent_name=self.agent_name,
            context_pattern=config.get("context_pattern", "IMMEDIATE_PREDECESSORS"),
            predecessors=config.get("predecessors", []),
            phase_instructions=config.get("instructions", ""),
            domain=config.get("domain", "technical"),
            config=config,
        )

        # Add tracking metadata
        invocation["_metadata"] = {
            "atomic_skill": self.skill_name,
            "agent": self.agent_name,
            "cognitive_function": self.cognitive_function,
            "memory_file": self.get_memory_file_path(task_id),
            "agent_entry": str(self.get_agent_entry_path()),
        }

        return invocation

    def get_invocation_dict(
        self,
        task_id: str,
        skill_name: Optional[str] = None,
        phase_id: Optional[str] = None,
        phase_name: Optional[str] = None,
        config: Optional[dict[str, Any]] = None,
    ) -> dict[str, Any]:
        """
        Alias for invoke() - returns Task tool invocation parameters.

        This method name makes the intent clearer when called from
        skill phases.
        """
        return self.invoke(task_id, skill_name, phase_id, phase_name, config)
