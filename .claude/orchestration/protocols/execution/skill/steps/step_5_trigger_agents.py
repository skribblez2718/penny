"""
step_5_trigger_agents.py
========================

Step 5 of Skill Orchestration: Trigger Cognitive Agents

This step dispatches to either:
1. skill-protocols (for composite skills with Python-enforced phases)
2. protocols/agent directly (for atomic skills or ad-hoc agent sequences)

Enhancement: Includes episodic memory recommendations from similar past tasks.

All imports are ABSOLUTE - no relative imports allowed.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Optional, Dict, Any

# Path setup - add protocols directory for fully-qualified imports
# This prevents collision between skill/config and agent/config
_STEPS_DIR = Path(__file__).resolve().parent
_PROTOCOL_DIR = _STEPS_DIR.parent
_EXECUTION_ROOT = _PROTOCOL_DIR.parent
_PROTOCOLS_DIR = _EXECUTION_ROOT.parent  # protocols/
_ORCHESTRATION_DIR = _PROTOCOLS_DIR.parent  # orchestration/

# Add paths for absolute imports
if str(_EXECUTION_ROOT) not in sys.path:
    sys.path.insert(0, str(_EXECUTION_ROOT))
if str(_PROTOCOLS_DIR) not in sys.path:
    sys.path.insert(0, str(_PROTOCOLS_DIR))
if str(_ORCHESTRATION_DIR) not in sys.path:
    sys.path.insert(0, str(_ORCHESTRATION_DIR))

# Absolute imports from execution_protocols package
from steps.base import ExecutionBaseStep
from config.config import ProtocolType

# Path to protocols/skill
SKILL_PROTOCOLS_PATH = _EXECUTION_ROOT.parent / "skill"

# Import episodic retrieval for pattern recommendations
try:
    from skill.episodic_retrieval import (
        get_episodic_context_for_task,
        format_retrieval_summary,
    )
    EPISODIC_MEMORY_AVAILABLE = True
except ImportError:
    EPISODIC_MEMORY_AVAILABLE = False


class Step5TriggerAgents(ExecutionBaseStep):
    """Step 5: Trigger Cognitive Agents"""
    _step_num = 5
    _step_name = "TRIGGER_AGENTS"
    _protocol_type = ProtocolType.SKILL_ORCHESTRATION

    def get_skill_name(self) -> Optional[str]:
        """Extract skill name from workflow context."""
        step3 = self.state.get_step_output(3)
        if step3 and "orchestrator_response" in step3:
            # Look for skill name in workflow response
            response = step3["orchestrator_response"]
            # Common patterns: "develop-skill", "perform-research", etc.
            skill_indicators = [
                "develop-skill", "develop-learnings",
                "orchestrate-clarification", "orchestrate-analysis",
                "orchestrate-research", "orchestrate-synthesis",
                "orchestrate-generation", "orchestrate-validation",
            ]
            for skill in skill_indicators:
                if skill in response.lower():
                    return skill
        return None

    def get_context_type(self) -> Optional[str]:
        """Extract context/domain type from Step 2 output."""
        step2 = self.state.get_step_output(2)
        if step2 and "orchestrator_response" in step2:
            response = step2["orchestrator_response"].lower()
            # Map common domain indicators
            domain_indicators = {
                "technical": ["technical", "code", "programming", "software", "api", "system"],
                "personal": ["personal", "life", "health", "wellness", "hobby"],
                "creative": ["creative", "design", "art", "writing", "content"],
                "professional": ["professional", "business", "work", "career"],
                "recreational": ["recreational", "fun", "game", "entertainment"],
            }
            for domain, keywords in domain_indicators.items():
                if any(kw in response for kw in keywords):
                    return domain
        return "technical"  # Default fallback

    def get_task_description(self) -> str:
        """Extract task description from metadata or workflow context."""
        # Try metadata first
        if hasattr(self.state, 'metadata') and self.state.metadata:
            desc = self.state.metadata.get("task_description", "")
            if desc:
                return desc

        # Fall back to step 3 workflow response
        step3 = self.state.get_step_output(3)
        if step3 and "orchestrator_response" in step3:
            return step3["orchestrator_response"][:500]
        return ""

    def get_episodic_recommendations(self) -> str:
        """
        Get episodic memory recommendations for current task.

        Retrieves similar past episodes and formats recommendations
        for agent sequence and approach based on prior successes.
        """
        if not EPISODIC_MEMORY_AVAILABLE:
            return ""

        skill_name = self.get_skill_name()
        if not skill_name:
            return ""

        context_type = self.get_context_type()
        task_description = self.get_task_description()

        if not task_description:
            return ""

        try:
            return get_episodic_context_for_task(
                task_description=task_description,
                skill_name=skill_name,
                domain=context_type
            )
        except Exception:
            # Don't fail task execution due to episodic memory errors
            return ""

    def is_composite_skill(self, skill_name: str) -> bool:
        """Check if skill has Python-enforced orchestration."""
        try:
            from skill.config.config import get_skill_type, SkillType
            skill_type = get_skill_type(skill_name)
            return skill_type == SkillType.COMPOSITE
        except ImportError:
            return False

    def dispatch_to_skill_protocol(self, skill_name: str, task_id: str) -> Dict[str, Any]:
        """Dispatch to skill-protocols for composite skill execution."""
        try:
            # Import the specific skill's entry module
            skill_module_name = skill_name.replace("-", "_")
            entry_path = SKILL_PROTOCOLS_PATH / "composite" / skill_module_name / "entry.py"

            if entry_path.exists():
                # Concise directive - no decoration
                return {
                    "dispatch_type": "skill_protocol",
                    "skill_name": skill_name,
                    "entry_script": str(entry_path),
                    "execution_session_id": self.state.session_id,
                }
            else:
                print(f"WARNING: Skill protocol not found for {skill_name}. Expected: {entry_path}", file=sys.stderr)
                return {"dispatch_type": "not_found", "skill_name": skill_name}

        except Exception as e:
            print(f"ERROR dispatching to skill-protocols: {e}", file=sys.stderr)
            return {"dispatch_type": "error", "error": str(e)}

    def get_extra_context(self) -> str:
        """Include memory file status from Step 4, skill dispatch info, and episodic recommendations."""
        context_parts = []

        # Get task-id
        step1 = self.state.get_step_output(1)
        task_id = None
        if step1 and "orchestrator_response" in step1:
            task_id = step1["orchestrator_response"][:150].strip()
            context_parts.append("TASK ID:")
            context_parts.append(task_id)
            context_parts.append("")

        # Get workflow
        step3 = self.state.get_step_output(3)
        if step3 and "orchestrator_response" in step3:
            context_parts.append("WORKFLOW:")
            context_parts.append(step3["orchestrator_response"][:300])
            context_parts.append("")

        # Get memory file status
        step4 = self.state.get_step_output(4)
        if step4 and "orchestrator_response" in step4:
            context_parts.append("MEMORY FILE STATUS (from Step 4):")
            context_parts.append(step4["orchestrator_response"][:300])
            context_parts.append("")

        # Check for composite skill dispatch
        skill_name = self.get_skill_name()
        if skill_name:
            context_parts.append("SKILL DETECTION:")
            context_parts.append(f"Detected skill: {skill_name}")

            if self.is_composite_skill(skill_name):
                context_parts.append("Type: COMPOSITE (Python-enforced phases)")
                context_parts.append("")
                context_parts.append("This skill has Python-enforced orchestration.")
                context_parts.append("Dispatch to skill-protocols for phase execution.")

                # Actually dispatch
                if task_id:
                    dispatch_result = self.dispatch_to_skill_protocol(skill_name, task_id)
                    context_parts.append(f"Dispatch result: {dispatch_result.get('dispatch_type', 'unknown')}")
            else:
                context_parts.append("Type: ATOMIC or AD-HOC")
                context_parts.append("")
                context_parts.append("Use protocols/agent directly for execution.")

        # Add episodic memory recommendations (if any)
        episodic_recs = self.get_episodic_recommendations()
        if episodic_recs:
            context_parts.append(episodic_recs)

        return "\n".join(context_parts)


if __name__ == "__main__":
    sys.exit(Step5TriggerAgents.main())
