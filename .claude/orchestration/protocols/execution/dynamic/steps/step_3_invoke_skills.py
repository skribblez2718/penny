"""
step_3_invoke_skills.py
=======================

Step 3 of Dynamic Skill Sequencing Protocol: Invoke Skills in Sequence

This step executes each orchestrate-* skill according to the planned sequence.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any, Dict

# Path setup - navigate to execution protocol root
_STEPS_DIR = Path(__file__).resolve().parent
_PROTOCOL_DIR = _STEPS_DIR.parent
_EXECUTION_ROOT = _PROTOCOL_DIR.parent
if str(_EXECUTION_ROOT) not in sys.path:
    sys.path.insert(0, str(_EXECUTION_ROOT))

from steps.base import BaseStep
from config.config import ProtocolType, format_mandatory_directive


class Step3InvokeSkills(BaseStep):
    """
    Step 3: Invoke Skills in Sequence

    Executes each orchestrate-* skill according to the planned sequence.
    This step prints MANDATORY directives for Claude to invoke atomic skills.
    """
    _step_num = 3
    _step_name = "INVOKE_SKILLS"
    _protocol_type = ProtocolType.DYNAMIC_SKILL_SEQUENCING

    def process_step(self) -> Dict[str, Any]:
        """
        Process the skill invocation step.

        Returns tracking info. The actual skill invocations are triggered
        by MANDATORY directives printed in print_next_directive().
        """
        return {
            "invocation_in_progress": True,
            "awaiting_skill_invocations": True,
            "instruction": "Execute each skill using the Skill tool per MANDATORY directive below"
        }

    def print_next_directive(self) -> None:
        """
        Override to print MANDATORY skill invocation directive before Step 4.

        This is the critical fix: we print an enforceable directive that tells
        Claude to invoke the Skill tool for each planned skill, rather than
        just explanatory markdown that gets ignored.
        """
        # Print skill invocation directive using standard format
        skill_directive = format_mandatory_directive(
            command='Skill(skill="orchestrate-{name}") for EACH skill in your Step 2 sequence',
            context="""Invoke each atomic skill in your planned sequence NOW.

**CRITICAL - PROMPT FORMAT:**
When invoking the Task tool for each agent, you MUST structure your prompt using the
Agent Prompt Template format. See DA.md "Agent Prompt Template Requirements" section.

Required sections in your Task tool prompt:
1. Task Context (task_id, skill, phase, domain, agent)
2. Role Extension (generate 3-5 task-specific focus areas)
3. Johari Context (from reasoning protocol Step 0 if available)
4. Task Instructions (specific cognitive work for this agent)
5. Related Research Terms (generate 7-10 keywords)
6. Output Requirements (memory file path)

Do NOT pass plain text prompts to agents. Always use the structured template.

**INVOCATION SEQUENCE:**

1. For each skill you planned (e.g., orchestrate-analysis, orchestrate-synthesis):
   - Call: Skill(skill="orchestrate-{name}")
   - The skill's SKILL.md will guide you on the Agent Invocation Format
   - Wait for the skill to complete before invoking the next one

2. Each skill will invoke its cognitive agent via the Task tool internally

3. After ALL skills complete, proceed to Step 4 below to verify completion.

Example sequence:
- Skill(skill="orchestrate-clarification")
- Skill(skill="orchestrate-research")
- Skill(skill="orchestrate-analysis")
- Skill(skill="orchestrate-synthesis")
""",
            protocol_type=ProtocolType.DYNAMIC_SKILL_SEQUENCING
        )
        print(skill_directive)

        # Then print the Step 4 directive
        super().print_next_directive()


# Allow running as script
if __name__ == "__main__":
    sys.exit(Step3InvokeSkills.main())
