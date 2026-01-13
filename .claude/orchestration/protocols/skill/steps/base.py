"""
Base Phase - Abstract base class for skill phase implementations.

Provides template method pattern for phase execution:
1. Load phase content
2. Execute phase logic (implemented by subclasses)
3. Return agent invocation dict (for non-AUTO phases)
4. Handle FSM transitions after agent completion

Key Changes from v1:
- execute() returns dict with agent_invocation (not print directive)
- handle_agent_completion() processes completion signals and transitions FSM
- Removed verbose banners, keeping minimal output
"""

from __future__ import annotations

import sys
from abc import ABC, abstractmethod
from pathlib import Path
from typing import Any, Optional

# Path setup - add protocols directory for fully-qualified imports
# This prevents collision between skill/config and agent/config
_STEPS_DIR = Path(__file__).resolve().parent
_SKILL_PROTOCOLS_ROOT = _STEPS_DIR.parent
_ORCHESTRATION_ROOT = _SKILL_PROTOCOLS_ROOT.parent
_PROTOCOLS_DIR = _ORCHESTRATION_ROOT
if str(_PROTOCOLS_DIR) not in sys.path:
    sys.path.insert(0, str(_PROTOCOLS_DIR))

# Directory paths (defined locally to avoid circular imports)
COMPOSITE_DIR = _SKILL_PROTOCOLS_ROOT / "composite"
ORCHESTRATION_ROOT = _ORCHESTRATION_ROOT

from skill.config.config import (
    PhaseType,
    get_phase_config,
    get_atomic_skill_agent,
    get_skill_phases,
)
from skill.atomic import get_atomic_skill
from skill.core.state import SkillExecutionState


class BasePhase(ABC):
    """
    Abstract base class for skill phase implementations.

    Subclasses must implement:
    - skill_name: Property returning the skill name
    - phase_id: Property returning the phase ID (e.g., "0", "0.5", "1")
    - process_phase(): Method containing phase-specific logic
    """

    def __init__(self, state: SkillExecutionState):
        """
        Initialize phase with execution state.

        Args:
            state: SkillExecutionState instance
        """
        self.state = state

        # Load phase config
        self.phase_config = get_phase_config(self.skill_name, self.phase_id)
        if not self.phase_config:
            raise ValueError(
                f"Phase {self.phase_id} not found for skill {self.skill_name}"
            )

    @property
    @abstractmethod
    def skill_name(self) -> str:
        """Return the skill name (e.g., 'develop-skill')."""
        pass

    @property
    @abstractmethod
    def phase_id(self) -> str:
        """Return the phase ID (e.g., '0', '0.5', '1')."""
        pass

    @property
    def phase_name(self) -> str:
        """Return the phase name from config."""
        return self.phase_config.get("name", f"PHASE_{self.phase_id}")

    @property
    def phase_title(self) -> str:
        """Return the phase title from config."""
        return self.phase_config.get("title", self.phase_name)

    @property
    def phase_type(self) -> PhaseType:
        """Return the phase type."""
        return self.phase_config.get("type", PhaseType.LINEAR)

    @property
    def uses_atomic_skill(self) -> Optional[str]:
        """Return the atomic skill used by this phase, if any."""
        return self.phase_config.get("uses_atomic_skill")

    @property
    def content_file(self) -> str:
        """Return the content file name."""
        return self.phase_config.get("content", f"phase_{self.phase_id.replace('.', '_')}.md")

    def get_content_path(self) -> Path:
        """Get full path to phase content file."""
        skill_dir = COMPOSITE_DIR / self.skill_name.replace("-", "_")
        return skill_dir / "content" / self.content_file

    def load_content(self) -> str:
        """Load phase content from markdown file."""
        content_path = self.get_content_path()
        if content_path.exists():
            return content_path.read_text()
        return f"# Phase {self.phase_id}: {self.phase_title}\n\nContent file not found: {content_path}"

    def load_shared_content(self, content_path: str) -> str:
        """
        Load content from shared directory.

        Args:
            content_path: Relative path within shared/

        Returns:
            Content string or empty string if not found
        """
        shared_dir = ORCHESTRATION_ROOT / "shared"
        full_path = shared_dir / content_path
        if full_path.exists():
            return full_path.read_text()
        return ""

    def print_content(self) -> None:
        """Print phase content to stdout (minimal)."""
        content = self.load_content()
        print(content)

    def print_phase_header(self) -> None:
        """Print minimal phase header (no output - content is self-explanatory)."""
        pass

    def get_agent_invocation(self) -> Optional[dict[str, Any]]:
        """
        Get Task tool invocation dict for this phase's agent.

        Returns None for AUTO phases or phases without atomic skills.

        Returns:
            Dict with Task tool parameters, or None
        """
        atomic_skill_name = self.uses_atomic_skill
        if not atomic_skill_name:
            return None

        # Get the atomic skill instance using the class registry
        try:
            atomic_skill = get_atomic_skill(atomic_skill_name)
        except ValueError:
            return None

        # Get phase configuration for context
        config = self.phase_config.get("configuration", {})

        # Determine predecessors based on phase position
        predecessors = config.get("predecessors", [])
        if not predecessors:
            # Try to determine from phase sequence
            phases = get_skill_phases(self.skill_name)
            phase_ids = list(phases.keys())
            if self.phase_id in phase_ids:
                idx = phase_ids.index(self.phase_id)
                if idx > 0:
                    prev_phase_id = phase_ids[idx - 1]
                    prev_phase = phases[prev_phase_id]
                    if prev_phase.get("uses_atomic_skill"):
                        prev_agent = get_atomic_skill_agent(prev_phase["uses_atomic_skill"])
                        if prev_agent:
                            predecessors = [prev_agent]

        # Build invocation
        return atomic_skill.invoke(
            task_id=self.state.task_id,
            skill_name=self.skill_name,
            phase_id=self.phase_id,
            phase_name=self.phase_title,
            config={
                "context_pattern": config.get("context_pattern", "IMMEDIATE_PREDECESSORS"),
                "predecessors": predecessors,
                "instructions": config.get("instructions", ""),
                "domain": self.state.metadata.get("domain", "technical"),
                **config,
            },
        )

    def _transition_fsm(self) -> None:
        """Transition FSM to next phase."""
        if self.state.fsm:
            next_phase = self.phase_config.get("next")
            self.state.fsm.transition(next_phase)
            self.state.save()

    def handle_agent_completion(self, agent_name: str) -> dict[str, Any]:
        """
        Handle agent completion: verify memory, transition FSM.

        Called after an agent signals completion (via completion_signals).

        Args:
            agent_name: Name of the agent that completed

        Returns:
            Dict with completion status and next phase info
        """
        # Import from skill root (these files haven't been reorganized yet)
        from skill.memory_verifier import verify_exists, verify_format, get_memory_path
        from skill.completion_signals import read_signal, clear_signal

        # Check for completion signal
        signal = read_signal(self.state.task_id, self.phase_id)
        if not signal:
            return {"error": f"No completion signal for phase {self.phase_id}"}

        # Verify memory file exists
        if not verify_exists(self.state.task_id, agent_name):
            memory_path = get_memory_path(self.state.task_id, agent_name)
            return {"error": f"Memory file missing: {memory_path}"}

        # Verify memory file format
        memory_path = get_memory_path(self.state.task_id, agent_name)
        valid, errors = verify_format(memory_path)
        if not valid:
            return {"error": f"Invalid memory format: {errors}"}

        # Clear the completion signal
        clear_signal(self.state.task_id, self.phase_id)

        # Transition FSM
        self._transition_fsm()

        # Get next phase info
        next_phase_id = self.phase_config.get("next")
        next_phase_config = get_phase_config(self.skill_name, next_phase_id) if next_phase_id else None

        return {
            "status": "completed",
            "phase_id": self.phase_id,
            "next_phase": next_phase_id,
            "next_phase_title": next_phase_config.get("title") if next_phase_config else None,
        }

    def get_next_phase_directive(self) -> dict[str, Any]:
        """Get directive for next phase execution."""
        next_phase_id = self.phase_config.get("next")
        skill_dir = COMPOSITE_DIR / self.skill_name.replace("-", "_")

        if next_phase_id is None:
            # Final phase - return complete directive
            return {
                "type": "complete",
                "command": f"python3 {skill_dir}/complete.py {self.state.session_id}",
                "message": "All phases completed. Run completion script.",
            }

        next_config = get_phase_config(self.skill_name, next_phase_id)
        if next_config:
            # Use advance_phase.py for all phase transitions (no individual phase scripts)
            return {
                "type": "next_phase",
                "phase_id": next_phase_id,
                "title": next_config.get("title", "Unknown"),
                "command": f"python3 .claude/orchestration/protocols/skill/core/advance_phase.py {self.skill_name} {self.state.session_id}",
            }

        return {"type": "unknown"}

    @abstractmethod
    def process_phase(self) -> dict[str, Any]:
        """
        Execute phase-specific logic.

        Returns:
            Dictionary of outputs from this phase
        """
        pass

    def execute(self) -> dict[str, Any]:
        """
        Execute the phase.

        Returns dict with:
        - output: Phase processing output
        - agent_invocation: Task tool invocation dict (if agent needed)
        - awaiting_agent: True if waiting for agent completion
        - next_directive: Info for next phase (if AUTO)
        """
        # Record phase start
        self.state.start_phase(self.phase_id)

        # Print minimal header
        self.print_phase_header()

        # Print phase content
        self.print_content()

        # Execute phase logic
        output = self.process_phase()

        result = {"output": output, "phase_id": self.phase_id}

        if self.phase_type == PhaseType.AUTO:
            # AUTO phase - complete and transition immediately
            self.state.complete_phase(self.phase_id, output)
            self._transition_fsm()
            self.state.save()
            result["next_directive"] = self.get_next_phase_directive()
        else:
            # Non-AUTO phase - return agent invocation
            invocation = self.get_agent_invocation()
            if invocation:
                result["agent_invocation"] = invocation
                result["awaiting_agent"] = True
            else:
                # No agent invocation available - treat as AUTO
                self.state.complete_phase(self.phase_id, output)
                self._transition_fsm()
                self.state.save()
                result["next_directive"] = self.get_next_phase_directive()

        return result

    @classmethod
    def main(cls, session_id: str = None, task_id: str = None) -> None:
        """
        Main entry point for running a phase.

        Args:
            session_id: Session ID for existing state
            task_id: Task ID for new execution
        """
        # Load or create state
        if session_id:
            state = SkillExecutionState.load(cls.skill_name, session_id)
            if not state:
                print(f"ERROR: State not found for session {session_id}", file=sys.stderr)
                sys.exit(1)
        elif task_id:
            # Get skill_name from the class (requires concrete implementation)
            phase_instance = cls.__new__(cls)
            state = SkillExecutionState(
                skill_name=phase_instance.skill_name,
                task_id=task_id,
            )
        else:
            print("ERROR: Either session_id or task_id required", file=sys.stderr)
            sys.exit(1)

        # Create and execute phase
        phase = cls(state)
        result = phase.execute()

        # Output result summary
        if result.get("awaiting_agent"):
            invocation = result["agent_invocation"]
            print(f"\n## Agent Invocation Required")
            print(f"Use Task tool with:")
            print(f"- subagent_type: {invocation['subagent_type']}")
            print(f"- description: {invocation['description']}")
        elif result.get("next_directive"):
            directive = result["next_directive"]
            if directive["type"] == "complete":
                print(f"\n## Skill Complete")
                print(directive["message"])
            else:
                print(f"\n## Next: Phase {directive['phase_id']}")
                print(f"Run: `{directive['command']}`")


class AutoPhase(BasePhase):
    """
    Base class for AUTO phases that execute Python logic without agent invocation.

    AUTO phases:
    - Print content to stdout for context enrichment
    - Execute Python logic directly
    - Do not invoke cognitive agents
    - Transition directly to next phase
    """

    def get_agent_invocation(self) -> Optional[dict[str, Any]]:
        """AUTO phases don't invoke agents."""
        return None

    def execute(self) -> dict[str, Any]:
        """
        Execute AUTO phase.

        AUTO phases execute Python logic and immediately transition,
        without requiring agent invocation.
        """
        # Record phase start
        self.state.start_phase(self.phase_id)

        # Print minimal header
        self.print_phase_header()
        print("(AUTO - no agent invocation)")
        print()

        # Print phase content
        self.print_content()

        # Execute phase logic
        output = self.process_phase()

        # Record phase completion
        self.state.complete_phase(self.phase_id, output)

        # Transition FSM to next phase
        self._transition_fsm()

        # Save state
        self.state.save()

        # Return with next directive
        return {
            "output": output,
            "phase_id": self.phase_id,
            "next_directive": self.get_next_phase_directive(),
        }
