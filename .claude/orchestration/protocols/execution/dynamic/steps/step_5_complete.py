"""
step_5_complete.py
==================

Step 5 of Dynamic Skill Sequencing Protocol: Complete Workflow

This step finalizes the dynamic skill sequencing workflow and stores
an episode in episodic memory.

All imports are ABSOLUTE - no relative imports allowed.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

# Path setup - navigate to execution protocol root
_STEPS_DIR = Path(__file__).resolve().parent
_PROTOCOL_DIR = _STEPS_DIR.parent
_EXECUTION_ROOT = _PROTOCOL_DIR.parent
_ORCHESTRATION_DIR = _EXECUTION_ROOT.parent.parent  # orchestration/

# Add paths for absolute imports
if str(_EXECUTION_ROOT) not in sys.path:
    sys.path.insert(0, str(_EXECUTION_ROOT))
if str(_ORCHESTRATION_DIR) not in sys.path:
    sys.path.insert(0, str(_ORCHESTRATION_DIR))

# Absolute imports
from steps.base import BaseStep
from config.config import ProtocolType

# Import episode storage (optional - graceful degradation if not available)
try:
    from skill.episode_store_helper import store_dynamic_episode, create_episode_from_skill_state
    from skill.learning_trigger import should_trigger_learnings, format_trigger_prompt
    from skill.episodic_memory import Episode
    EPISODIC_MEMORY_AVAILABLE = True
except ImportError:
    EPISODIC_MEMORY_AVAILABLE = False


class Step5Complete(BaseStep):
    """
    Step 5: Complete Workflow

    Finalizes the dynamic skill sequencing workflow.
    """
    _step_num = 5
    _step_name = "COMPLETE"
    _protocol_type = ProtocolType.DYNAMIC_SKILL_SEQUENCING

    def _extract_task_id(self) -> str:
        """Extract task ID from workflow context."""
        # Try step 1 output
        step1 = self.state.get_step_output(1)
        if step1 and "orchestrator_response" in step1:
            # Use first 50 chars as a simplified task ID
            response = step1["orchestrator_response"][:50].strip()
            return f"dynamic-{hash(response) % 10000:04d}"
        return f"dynamic-{self.state.session_id[:8]}"

    def _extract_task_description(self) -> str:
        """Extract task description from workflow context."""
        step1 = self.state.get_step_output(1)
        if step1 and "orchestrator_response" in step1:
            return step1["orchestrator_response"][:500]
        return f"Dynamic skill sequencing task {self.state.session_id}"

    def _extract_skills_invoked(self) -> List[str]:
        """Extract list of skills invoked from step 3 output."""
        skills = []

        step3 = self.state.get_step_output(3)
        if step3 and "orchestrator_response" in step3:
            response = step3["orchestrator_response"]
            # Look for orchestrate-* skill mentions
            skill_indicators = [
                "orchestrate-clarification", "orchestrate-research",
                "orchestrate-analysis", "orchestrate-synthesis",
                "orchestrate-generation", "orchestrate-validation",
            ]
            for skill in skill_indicators:
                if skill in response.lower():
                    skills.append(skill)

        return skills

    def _store_completion_episode(self) -> Optional[str]:
        """
        Store an episode for the dynamic skill sequencing workflow.

        Returns:
            Episode ID if stored, None otherwise
        """
        if not EPISODIC_MEMORY_AVAILABLE:
            return None

        try:
            task_id = self._extract_task_id()
            task_description = self._extract_task_description()
            skills_invoked = self._extract_skills_invoked()

            episode_id = store_dynamic_episode(
                task_id=task_id,
                task_description=task_description,
                skills_invoked=skills_invoked,
                outcome="success",
            )

            return episode_id
        except Exception:
            # Don't fail completion due to episode storage errors
            return None

    def process_step(self) -> Dict[str, Any]:
        """
        Process workflow completion.

        Finalizes the workflow and prepares completion summary.
        """
        # Store episode
        episode_id = self._store_completion_episode()

        return {
            "workflow_complete": True,
            "instruction": "Finalize workflow and present deliverables",
            "episode_id": episode_id,
        }

    def _create_episode_for_learning_trigger(self) -> Episode | None:
        """Create an Episode object for learning trigger evaluation."""
        if not EPISODIC_MEMORY_AVAILABLE:
            return None

        try:
            task_id = self._extract_task_id()
            task_description = self._extract_task_description()
            skills_invoked = self._extract_skills_invoked()

            # Map orchestrate-* skills to their underlying agents
            agent_sequence = [s.replace("orchestrate-", "") + "-agent" for s in skills_invoked]

            return create_episode_from_skill_state(
                task_id=task_id,
                skill_name="dynamic",  # Canonical short name
                task_description=task_description,
                domain="technical",  # Default for dynamic sequencing
                agents_invoked=agent_sequence,
                outcome="success",
            )
        except Exception:
            return None

    def print_next_directive(self) -> None:
        """
        Override to indicate protocol completion instead of next step.
        """
        print("**DYNAMIC_SKILL_SEQUENCING_COMPLETE**")

        # Trigger develop-learnings evaluation
        if EPISODIC_MEMORY_AVAILABLE:
            episode = self._create_episode_for_learning_trigger()
            if episode:
                should_learn, reason = should_trigger_learnings(episode)
                if should_learn:
                    print(format_trigger_prompt(episode, reason))


# Allow running as script
if __name__ == "__main__":
    sys.exit(Step5Complete.main())
