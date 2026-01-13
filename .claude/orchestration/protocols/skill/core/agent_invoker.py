"""
Agent Invoker Module
====================

Builds Task tool invocation payloads for agent invocation via Claude's Task tool
with subagent_type. This replaces print-based directives with structured dicts
that Claude can use to invoke agents as subagents.

The key insight: Instead of printing ">>> EXECUTE python entry.py",
we return a dict that maps to Task tool parameters:
  - subagent_type: The agent type (e.g., "clarification")
  - prompt: Full context and instructions for the agent
  - description: Short summary for Task tool

Plan Integration:
  When an approved execution plan exists, agents receive relevant plan context
  to guide their execution and ensure alignment with the approved approach.

Template-Based Prompts:
  The DA can optionally use the template-based prompt builder for enhanced
  context passing. This provides:
  - Dynamic role extension (task-specific specialization)
  - Johari window pass-through from reasoning protocol
  - Related research terms for knowledge discovery

  The DA is responsible for generating role_extension and research_terms
  dynamically based on the task context. These are NOT hardcoded.
"""

from typing import Optional, Any, Dict, List
from pathlib import Path

# Import agent registry to get configured models
from agent.config.config import AGENT_REGISTRY, normalize_agent_name

# Map agent names to canonical short names
# All agents now use short names (no -agent suffix)
AGENT_SUBAGENT_MAP: dict[str, str] = {
    # Canonical short names (identity mapping)
    "clarification": "clarification",
    "research": "research",
    "analysis": "analysis",
    "synthesis": "synthesis",
    "generation": "generation",
    "validation": "validation",
    "memory": "memory",
    # Legacy names (backwards compatibility - map to short names)
    "clarification-agent": "clarification",
    "research-agent": "research",
    "analysis-agent": "analysis",
    "synthesis-agent": "synthesis",
    "generation-agent": "generation",
    "validation-agent": "validation",
    "goal-memory-agent": "memory",
}

# Context loading pattern descriptions
CONTEXT_PATTERNS: dict[str, str] = {
    "WORKFLOW_ONLY": "Load only workflow metadata (task-id, domain, initial requirements)",
    "IMMEDIATE_PREDECESSORS": "Load workflow metadata + output from immediately preceding agent",
    "MULTIPLE_PREDECESSORS": "Load workflow metadata + outputs from multiple specified predecessor agents",
}


def build_agent_prompt(
    task_id: str,
    skill_name: str,
    phase_id: str,
    agent_name: str,
    context_pattern: str = "IMMEDIATE_PREDECESSORS",
    predecessors: Optional[List[str]] = None,
    phase_instructions: str = "",
    domain: str = "technical",
    config: Optional[Dict[str, Any]] = None,
    plan: Optional[Dict[str, Any]] = None,
    # New parameters for DA-generated content
    role_extension: str = "",
    research_terms: str = "",
    johari_findings: Optional[Dict[str, Any]] = None,
    user_request: str = "",
    requirements_list: str = "",
    constraints_list: str = "",
    use_template: bool = False,
) -> str:
    """
    Build full prompt for agent invocation via Task tool.

    The prompt includes:
    1. Task context (task_id, skill, phase, domain)
    2. Role extension (task-specific specialization - DA generates)
    3. Johari window context (from reasoning protocol)
    4. User request with requirements and constraints
    5. Context loading instructions based on pattern
    6. Approved plan context (if available)
    7. Phase-specific instructions
    8. Memory file output requirements
    9. Related research terms (DA generates)
    10. Completion signal instructions

    Args:
        task_id: Unique task identifier
        skill_name: Name of skill being executed (e.g., "develop-project")
        phase_id: Current phase identifier (e.g., "0", "1.5")
        agent_name: Agent to invoke (e.g., "clarification-agent")
        context_pattern: How to load context (WORKFLOW_ONLY, IMMEDIATE_PREDECESSORS, MULTIPLE_PREDECESSORS)
        predecessors: List of predecessor agent names for context loading
        phase_instructions: Skill-specific instructions for this phase
        domain: Task domain (technical, personal, creative, professional, recreational)
        config: Additional configuration parameters
        plan: Approved execution plan from reasoning protocol (if available)
        role_extension: Task-specific role specialization (DA generates dynamically)
        research_terms: Related research keywords (DA generates dynamically)
        johari_findings: Johari findings from reasoning Step 0
        user_request: Original user request
        requirements_list: Task requirements (DA generates)
        constraints_list: Task constraints (DA generates)
        use_template: If True, use template-based builder (requires template file)

    Returns:
        Complete prompt string for Task tool invocation
    """
    predecessors = predecessors or []
    config = config or {}
    johari_findings = johari_findings or {}

    # If use_template is True, use the AgentPromptBuilder
    if use_template:
        from skill.core.prompt_builder import AgentPromptBuilder
        builder = AgentPromptBuilder(
            task_id=task_id,
            skill_name=skill_name,
            phase_id=phase_id,
            agent_name=agent_name,
            domain=domain,
            context_pattern=context_pattern,
            predecessors=predecessors,
            phase_instructions=phase_instructions,
            plan=plan,
            johari_findings=johari_findings,
            user_request=user_request,
            role_extension=role_extension,
            research_terms=research_terms,
            requirements_list=requirements_list,
            constraints_list=constraints_list,
            config=config,
        )
        return builder.build()

    # Build context loading section
    context_section = _build_context_section(task_id, context_pattern, predecessors)

    # Build plan context section (if plan exists)
    plan_section = _build_plan_section(plan, agent_name) if plan else ""

    # Build memory output requirements
    memory_section = _build_memory_section(task_id, agent_name)

    # Build completion signal instructions
    completion_section = _build_completion_section(task_id, phase_id, agent_name)

    # Build role extension section (if provided by DA)
    role_extension_section = ""
    if role_extension:
        role_extension_section = f"""
## Role Extension (Task-Specific)

{role_extension}

"""

    # Build Johari context section (if provided)
    johari_section = ""
    if johari_findings:
        johari_section = _build_johari_section(johari_findings)

    # Build user request section (if provided)
    user_request_section = ""
    if user_request:
        user_request_section = f"""
## User Request

{user_request}

"""
        if requirements_list:
            user_request_section += f"""### Requirements
{requirements_list}

"""
        if constraints_list:
            user_request_section += f"""### Constraints
{constraints_list}

"""

    # Build research terms section (if provided by DA)
    research_terms_section = ""
    if research_terms:
        research_terms_section = f"""
## Related Research Terms

{research_terms}

"""

    prompt = f"""# Agent Invocation: {agent_name}

## Task Context

- **Task ID:** `{task_id}`
- **Skill:** `{skill_name}`
- **Phase:** `{phase_id}`
- **Domain:** `{domain}`
- **Agent:** `{agent_name}`
{role_extension_section}{johari_section}{user_request_section}{context_section}
{plan_section}
## Phase Instructions

{phase_instructions if phase_instructions else "Execute standard cognitive function for this agent."}

{memory_section}

{completion_section}
{research_terms_section}
## Execution Protocol

1. Execute the agent entry script: `python3 .claude/orchestration/protocols/agent/{agent_name}/entry.py {task_id}`
2. Follow all step directives output by the scripts
3. Write memory file in Johari Window format before completion
4. Signal completion via the complete script

**Important:** This agent is invoked as part of skill `{skill_name}` phase `{phase_id}`.
The skill orchestration is tracking your progress and expects:
- Memory file at the specified path
- Completion signal when done
"""

    # Add any additional config as context
    if config:
        config_lines = "\n".join(f"- {k}: {v}" for k, v in config.items())
        prompt += f"\n## Additional Configuration\n\n{config_lines}\n"

    return prompt.strip()


def _build_johari_section(johari_findings: Dict[str, Any]) -> str:
    """Build Johari window context section from findings."""
    if not johari_findings:
        return ""

    lines = [
        "",
        "## Prior Knowledge Context (Johari Window)",
        "",
    ]

    quadrants = [
        ("open", "Shared Understanding (Open)"),
        ("blind", "Identified Gaps (Blind)"),
        ("hidden", "Discovered Insights (Hidden)"),
        ("unknown", "Areas for Exploration (Unknown)"),
    ]

    for key, title in quadrants:
        value = johari_findings.get(key)
        if value:
            lines.append(f"### {title}")
            if isinstance(value, dict):
                for k, v in value.items():
                    if isinstance(v, list):
                        lines.append(f"- **{k}:** {', '.join(str(i) for i in v)}")
                    else:
                        lines.append(f"- **{k}:** {v}")
            elif isinstance(value, list):
                for item in value:
                    lines.append(f"- {item}")
            else:
                lines.append(str(value))
            lines.append("")

    return "\n".join(lines)


def _build_context_section(task_id: str, pattern: str, predecessors: list[str]) -> str:
    """Build context loading instructions based on pattern."""
    memory_base = ".claude/memory"

    if pattern == "WORKFLOW_ONLY":
        return f"""## Context Loading

**Pattern:** WORKFLOW_ONLY

Load workflow metadata only:
- `{memory_base}/{task_id}-workflow-metadata.md`

No predecessor agent outputs required for this phase."""

    elif pattern == "IMMEDIATE_PREDECESSORS":
        if predecessors:
            pred_files = "\n".join(
                f"- `{memory_base}/{task_id}-{p}-memory.md`" for p in predecessors
            )
            return f"""## Context Loading

**Pattern:** IMMEDIATE_PREDECESSORS

Load workflow metadata:
- `{memory_base}/{task_id}-workflow-metadata.md`

Load immediate predecessor output:
{pred_files}"""
        else:
            return f"""## Context Loading

**Pattern:** IMMEDIATE_PREDECESSORS

Load workflow metadata:
- `{memory_base}/{task_id}-workflow-metadata.md`

No specific predecessors specified - check workflow state for actual predecessor."""

    elif pattern == "MULTIPLE_PREDECESSORS":
        if predecessors:
            pred_files = "\n".join(
                f"- `{memory_base}/{task_id}-{p}-memory.md`" for p in predecessors
            )
            return f"""## Context Loading

**Pattern:** MULTIPLE_PREDECESSORS

Load workflow metadata:
- `{memory_base}/{task_id}-workflow-metadata.md`

Load multiple predecessor outputs:
{pred_files}"""
        else:
            return f"""## Context Loading

**Pattern:** MULTIPLE_PREDECESSORS

Load workflow metadata and all available predecessor memory files from:
- `{memory_base}/{task_id}-*-memory.md`"""

    else:
        return f"""## Context Loading

**Pattern:** {pattern} (unknown - defaulting to workflow only)

Load workflow metadata:
- `{memory_base}/{task_id}-workflow-metadata.md`"""


def _build_plan_section(plan: dict[str, Any], agent_name: str) -> str:
    """
    Build plan context section for agent invocation.

    Extracts relevant plan information to guide the agent's execution.

    Args:
        plan: The approved execution plan
        agent_name: Current agent being invoked

    Returns:
        Formatted plan section string
    """
    if not plan:
        return ""

    lines = [
        "",
        "## Approved Execution Plan",
        "",
        "This execution follows a user-approved plan. Align your work with these guidelines:",
        "",
    ]

    # Add task summary
    task_summary = plan.get("task_summary", "")
    if task_summary:
        lines.append(f"**Task:** {task_summary}")
        lines.append("")

    # Add understanding section
    understanding = plan.get("understanding", {})
    if understanding:
        interpreted_goal = understanding.get("interpreted_goal", "")
        if interpreted_goal:
            lines.append(f"**Goal:** {interpreted_goal}")
            lines.append("")

        key_requirements = understanding.get("key_requirements", [])
        if key_requirements:
            lines.append("**Key Requirements:**")
            for req in key_requirements[:5]:  # Limit to 5 requirements
                lines.append(f"- {req}")
            lines.append("")

    # Add approach overview
    approach = plan.get("approach", {})
    if approach:
        strategy = approach.get("strategy", "")
        if strategy:
            lines.append(f"**Strategy:** {strategy}")
            lines.append("")

        # Include relevant steps for context
        steps = approach.get("steps", [])
        if steps:
            lines.append("**Planned Steps:**")
            for step in steps[:6]:  # Limit to 6 steps
                step_num = step.get("step", "?")
                action = step.get("action", "")
                lines.append(f"{step_num}. {action}")
            lines.append("")

    # Add success criteria
    success_criteria = plan.get("success_criteria", [])
    if success_criteria:
        lines.append("**Success Criteria:**")
        for criterion in success_criteria[:4]:  # Limit to 4 criteria
            lines.append(f"- {criterion}")
        lines.append("")

    # Add risk awareness
    risk_assessment = plan.get("risk_assessment", {})
    potential_issues = risk_assessment.get("potential_issues", [])
    if potential_issues:
        lines.append("**Risks to Consider:**")
        for issue in potential_issues[:3]:  # Limit to 3 risks
            lines.append(f"- {issue}")
        lines.append("")

    lines.append("**Important:** Your output should align with and advance this approved plan.")
    lines.append("")

    return "\n".join(lines)


def _build_memory_section(task_id: str, agent_name: str) -> str:
    """Build memory output requirements section."""
    memory_path = f".claude/memory/{task_id}-{agent_name}-memory.md"

    return f"""## Memory Output Requirements

**Output Path:** `{memory_path}`

**Format:** Johari Window Structure

```markdown
# Agent Memory: {agent_name}
Task: {task_id}

## Open (Shared Knowledge)
[Facts, findings, and validated information]

## Blind (Unknown to Agent)
[Gaps identified that require external input]

## Hidden (Internal Processing)
[Internal reasoning and intermediate conclusions]

## Unknown (To Be Discovered)
[Open questions and areas for future investigation]

## Deliverables
[Primary outputs of this cognitive function]
```

**Requirement:** Memory file MUST exist before signaling completion."""


def _build_completion_section(task_id: str, phase_id: str, agent_name: str) -> str:
    """Build completion signal instructions."""
    return f"""## Completion Signal

When agent work is complete:

1. Verify memory file exists at expected path
2. Execute completion script:
   `python3 .claude/orchestration/protocols/agent/{agent_name}/complete.py --task-id {task_id} --phase-id {phase_id}`
3. The completion script will:
   - Verify memory file exists
   - Write completion signal for skill orchestration
   - Output next phase directive (if applicable)"""


def get_task_invocation(
    agent_name: str,
    prompt: str,
    description: str,
    model: str = "sonnet",
) -> dict:
    """
    Return dict for Task tool invocation.

    This dict maps directly to the Task tool parameters that Claude
    uses to spawn subagents.

    Args:
        agent_name: The agent name (maps to subagent_type)
        prompt: Full prompt for the agent
        description: Short (3-5 word) description for Task tool
        model: Model to use (haiku, sonnet, opus)

    Returns:
        Dict with Task tool parameters:
        - subagent_type: The agent type
        - prompt: Full instructions
        - description: Short summary
        - model: Optional model override
    """
    # Map agent name to subagent type
    subagent_type = AGENT_SUBAGENT_MAP.get(agent_name, agent_name)

    return {
        "subagent_type": subagent_type,
        "prompt": prompt,
        "description": description,
        "model": model,
    }


def get_invocation_for_phase(
    task_id: str,
    skill_name: str,
    phase_id: str,
    phase_name: str,
    agent_name: str,
    context_pattern: str = "IMMEDIATE_PREDECESSORS",
    predecessors: Optional[list[str]] = None,
    phase_instructions: str = "",
    domain: str = "technical",
    config: Optional[dict] = None,
    plan: Optional[dict[str, Any]] = None,
) -> dict:
    """
    Convenience function to get full Task tool invocation for a skill phase.

    This combines build_agent_prompt() and get_task_invocation() into a single call.

    Args:
        task_id: Unique task identifier
        skill_name: Name of skill being executed
        phase_id: Current phase identifier
        phase_name: Human-readable phase name
        agent_name: Agent to invoke
        context_pattern: Context loading pattern
        predecessors: List of predecessor agents
        phase_instructions: Phase-specific instructions
        domain: Task domain
        config: Additional configuration
        plan: Approved execution plan from reasoning protocol (if available)

    Returns:
        Complete Task tool invocation dict
    """
    prompt = build_agent_prompt(
        task_id=task_id,
        skill_name=skill_name,
        phase_id=phase_id,
        agent_name=agent_name,
        context_pattern=context_pattern,
        predecessors=predecessors,
        phase_instructions=phase_instructions,
        domain=domain,
        config=config,
        plan=plan,
    )

    description = f"Phase {phase_id}: {phase_name}"

    # Look up agent's configured model from AGENT_REGISTRY
    normalized_name = normalize_agent_name(agent_name)
    agent_config = AGENT_REGISTRY.get(normalized_name, {})
    agent_model = agent_config.get("model", "sonnet")

    return get_task_invocation(
        agent_name=agent_name,
        prompt=prompt,
        description=description,
        model=agent_model,
    )
