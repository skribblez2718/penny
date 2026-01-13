# Read Skill Definition or Create Cognitive Workflow

Determine the cognitive workflow for this task.

## Skill Lookup

**Check for existing skill:** `${CAII_DIRECTORY}/.claude/skills/{skill-name}/SKILL.md`

If a matching skill exists:
1. Read the SKILL.md file
2. Extract the workflow phases and agent sequence
3. Note any domain-specific configuration

## Fallback: Standard Cognitive Workflow

If no specific skill exists, use the universal cognitive sequence:

| Phase | Agent | Purpose |
|-------|-------|---------|
| 0 | CLARIFICATION | Resolve ambiguity (optional, use if needed) |
| 1 | RESEARCH | Gather information, explore options |
| 2 | ANALYSIS | Decompose complexity, assess risks |
| 3 | SYNTHESIS | Integrate findings into design |
| 4 | GENERATION | Create artifacts (code, docs, etc.) |
| 5 | VALIDATION | Verify quality against criteria |

## Workflow Customization

Based on task characteristics:
- **Simple tasks:** May skip RESEARCH, ANALYSIS
- **Research-only:** May stop after SYNTHESIS
- **Complex tasks:** May require multiple GENERATION iterations
- **Ambiguous tasks:** Insert CLARIFICATION as needed

## Output Requirements

Output:
1. Whether using existing skill or standard workflow
2. The agent sequence for this task
3. Any phase customizations

**Format your response as:**
```
WORKFLOW SOURCE: {skill-name|standard-cognitive}
AGENT SEQUENCE: [list of agents in order]
CUSTOMIZATIONS: {any phase modifications or notes}
```
