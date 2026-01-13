"""
step_3b_skill_detection.py
==========================

Step 3b of the Mandatory Reasoning Protocol: Semantic Skill Detection

This step runs AFTER Step 3 (Tree of Thought) and BEFORE Step 4 (Task Routing).
It presents available skills to the orchestrator for SEMANTIC evaluation based on the
"When to Use" patterns defined in DA.md.

NO KEYWORD MATCHING is used. The orchestrator makes the skill detection decision based on
semantic understanding of the user's query and the skill descriptions.

Agent Mode Routing:
- Normal sessions: Step 3b → Step 4 (Task Routing)
- Agent mode sessions: Step 3b → Step 5 (Self-Consistency) - agents are already routed
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any, Dict

# Path setup - add protocols directory for fully-qualified imports
# This prevents collision between reasoning/config and skill/config
_STEPS_DIR = Path(__file__).resolve().parent
_REASONING_ROOT = _STEPS_DIR.parent
_PROTOCOLS_DIR = _REASONING_ROOT.parent
if str(_PROTOCOLS_DIR) not in sys.path:
    sys.path.insert(0, str(_PROTOCOLS_DIR))

from reasoning.steps.base import BaseStep


# Skill information is now centralized in:
# - DA.md (Skill Routing Table section) - used at session start
# - skill/config/config.py (COMPOSITE_SKILLS, ATOMIC_SKILLS) - master registry with semantic_trigger/not_for
#
# This step references the DA.md context already loaded at session start, avoiding duplication.


class Step3bSkillDetection(BaseStep):
    """
    Step 3b: Semantic Skill Detection

    Presents available skills to the orchestrator for SEMANTIC evaluation.
    No keyword matching - the orchestrator decides based on understanding from DA.md.

    Also handles agent mode routing:
    - Normal sessions proceed to Step 4 (Task Routing)
    - Agent mode sessions skip to Step 5 (Self-Consistency)
    """
    _step_num = 3  # Logically part of step 3
    _step_name = "SKILL_DETECTION"

    def is_agent_mode(self) -> bool:
        """
        Check if running in agent mode.

        In agent mode, Step 4 (Task Routing) is skipped since agents are already routed.

        Returns:
            True if running in agent mode, False otherwise
        """
        return self.state.metadata.get("is_agent_session", False)

    def process_step(self) -> Dict[str, Any]:
        """
        Process skill detection.

        Returns minimal output - the orchestrator makes the semantic decision.
        """
        return {
            "skill_detection_method": "semantic",
            "note": "Orchestrator evaluates skills semantically based on DA.md patterns",
            "completed": True,
        }

    def get_extra_context(self) -> str:
        """
        Present skill detection instructions referencing DA.md routing table.

        The Skill Routing Table in DA.md contains semantic_trigger and not_for
        fields for each skill. This step references that context (already loaded
        at session start) rather than duplicating skill information here.
        """
        query = getattr(self.state, "user_query", "")

        return f"""## Step 3b: Semantic Skill Detection

Evaluate the user's query against the **Skill Routing Table** in your DA.md context.

**User Query:** {query}

---

## Semantic Evaluation Instructions

1. **Reference DA.md Skill Routing Table** - Compare query intent against semantic_trigger and not_for columns
2. **Evaluate semantically** - Does the query's INTENT match a skill's semantic trigger?
3. **Check NOT for exclusions** - Does the query match any skill's "NOT for" criteria?

## Confidence-Based Action

- **HIGH confidence** → Proceed to routing
- **MEDIUM/LOW confidence** → Flag for user clarification (will HALT in Step 8)

**Respond with your detection in this format:**
```
SKILL_DETECTED: [yes|no]
SKILL_NAME: [skill-name or null]
SKILL_TYPE: [composite|atomic|null]
CONFIDENCE: [high|medium|low]
REASONING: [Brief semantic justification referencing semantic_trigger match]
```
"""

    def execute(self) -> bool:
        """
        Execute semantic skill detection step.
        """
        from reasoning.core.fsm import ReasoningState
        from datetime import datetime, timezone

        # Transition to SKILL_DETECTION state
        if not self.state.fsm.transition(ReasoningState.SKILL_DETECTION):
            print(f"ERROR: Cannot transition to SKILL_DETECTION from {self.state.fsm.state}")
            return False

        output = self.process_step()

        # Store in state
        self.state.step_outputs["3b"] = output
        self.state.step_timestamps["3b"] = {
            "started_at": datetime.now(timezone.utc).isoformat(),
            "completed_at": datetime.now(timezone.utc).isoformat(),
        }
        self.state.save()

        # Print skill context for semantic evaluation
        context = self.get_extra_context()
        print(context)

        # Route based on agent mode
        if self.is_agent_mode():
            # Agent mode: skip Step 4 (Task Routing) and go directly to Step 5
            self.print_next_step_5_directive()
        else:
            # Normal mode: proceed to Step 4 (Task Routing)
            self.print_next_step_4_directive()

        return True

    def print_next_step_4_directive(self) -> None:
        """Print directive to execute Step 4 (Task Routing)."""
        from reasoning.config.config import STEPS_DIR, format_mandatory_directive

        step_4_script = STEPS_DIR / "step_4_task_routing.py"

        directive = format_mandatory_directive(
            f"python3 {step_4_script} --state {self.state.state_file_path}",
            "Skill detection complete. Execute Step 4 (Task Routing). "
        )
        print(directive)

    def print_next_step_5_directive(self) -> None:
        """Print directive to execute Step 5 (Self-Consistency) for agent mode."""
        from reasoning.config.config import STEPS_DIR, format_mandatory_directive

        step_5_script = STEPS_DIR / "step_5_self_consistency.py"

        directive = format_mandatory_directive(
            f"python3 {step_5_script} --state {self.state.state_file_path}",
            "Agent mode: Step 4 skipped. Execute Step 5 (Self-Consistency). "
        )
        print(directive)

    @classmethod
    def main(cls) -> int:
        """Main entry point for step 3b script."""
        import argparse
        from reasoning.core.state import ProtocolState

        parser = argparse.ArgumentParser(
            description="Execute Step 3b: Semantic Skill Detection",
        )
        parser.add_argument(
            "--state",
            required=True,
            help="Path to the state file"
        )

        args = parser.parse_args()

        state_path = Path(args.state)
        if not state_path.exists():
            print(f"ERROR: State file not found: {args.state}", file=sys.stderr)
            return 1

        session_id = state_path.stem.replace("reasoning-", "")

        state = ProtocolState.load(session_id)
        if not state:
            print(f"ERROR: Could not load state from {args.state}", file=sys.stderr)
            return 1

        step = cls(state)
        if not step.execute():
            return 1

        return 0


if __name__ == "__main__":
    sys.exit(Step3bSkillDetection.main())
