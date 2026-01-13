# Create Atomic Skill Protocol

## Overview

Protocol for creating new atomic skills when they don't exist but are needed by a composite skill.

## Pre-requisites

- Atomic skill name follows pattern: `orchestrate-{function}`
- Function maps to exactly one cognitive agent
- No existing atomic skill provides this function

## Valid Atomic Skill Functions

| Function | Agent | Purpose |
|----------|-------|---------|
| clarification | clarification | Transform vague inputs to specifications |
| analysis | analysis | Decompose problems, assess complexity, identify risks |
| research | research | Investigate options, gather knowledge |
| synthesis | synthesis | Integrate findings, produce recommendations |
| generation | generation | Generate artifacts using TDD methodology |
| validation | validation | Verify artifacts against criteria |

## Creation Steps

### Step 1: Validate Need

Before creating, verify:
- [ ] Function maps to exactly one cognitive agent (1:1 mapping)
- [ ] No existing atomic skill provides this function
- [ ] Skill name follows `orchestrate-{function}` pattern

### Step 2: Create Directory

```bash
mkdir -p ${CAII_DIRECTORY}/.claude/skills/orchestrate-{function}
```

### Step 3: Generate SKILL.md

Use template from `${CAII_DIRECTORY}/.claude/skills/develop-skill/resources/atomic-skill-template.md` with:
- name: `orchestrate-{function}`
- description: "Atomic skill for {function} using {agent-name} agent"
- type: atomic

### Step 4: Validate Structure

Verify the new atomic skill:
- [ ] Has `type: atomic` in YAML frontmatter
- [ ] Has exactly one agent in Agent Sequence
- [ ] Follows standard atomic skill interface
- [ ] References correct protocols

## Template Reference

See `${CAII_DIRECTORY}/.claude/skills/develop-skill/resources/atomic-skill-template.md` for the complete template structure.

## Example: Creating orchestrate-analysis

```yaml
---
name: orchestrate-analysis
description: Atomic skill for analysis using analysis
tags: atomic-skill, analysis, complexity, risk
type: atomic
---
```

## Anti-Patterns

| Anti-Pattern | Instead |
|--------------|---------|
| Multiple agents in one atomic | Create separate atomics |
| Custom function names | Use standard 6 functions |
| Skipping validation | Always verify 1:1 mapping |
