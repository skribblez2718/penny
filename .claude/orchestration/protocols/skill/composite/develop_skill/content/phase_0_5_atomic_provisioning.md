# Phase 0.5: Atomic Skill Provisioning

**Uses Atomic Skill:** `orchestrate-generation`
**Phase Type:** LINEAR

## Purpose

Ensure all required atomic skills exist before proceeding with skill development. The generation agent creates any missing atomic skills.

## Trigger

Phase 0 identifies atomic skills needed for the new skill.

## Actions

The generation agent performs the following:

1. **Scan Atomic Skill Registry**
   - Read `${CAII_DIRECTORY}/.claude/skills/*/SKILL.md` files
   - Filter for `type: atomic` in frontmatter
   - Build available atomic skill list

2. **Compare Against Requirements**
   - Match needed skills from Phase 0 against available
   - Identify any missing atomic skills

3. **Provision Missing Skills**
   - For each missing atomic skill:
     - Use `${CAII_DIRECTORY}/.claude/skills/develop-skill/resources/create-atomic-skill.md` template
     - Write to `${CAII_DIRECTORY}/.claude/skills/orchestrate-{function}/SKILL.md`
     - Log creation for user awareness

4. **Update Registry**
   - Ensure skill-protocols/config.py ATOMIC_SKILLS is current
   - Verify protocols/agent exist for each atomic

## Available Atomic Skills (Standard Set)

| Skill | Agent | Function |
|-------|-------|----------|
| orchestrate-clarification | clarification | CLARIFICATION |
| orchestrate-analysis | analysis | ANALYSIS |
| orchestrate-research | research | RESEARCH |
| orchestrate-synthesis | synthesis | SYNTHESIS |
| orchestrate-generation | generation | GENERATION |
| orchestrate-validation | validation | VALIDATION |

## Gate Exit Criteria

- [ ] All needed atomic skills exist
- [ ] Registry verified current
- [ ] Agent-protocols exist for each atomic

## Output

List of available atomic skills and any created during this phase.
