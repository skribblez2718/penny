# SKILL.md Template — Copy-paste template for new skills

## What

Use this template as the starting point for any new skill's SKILL.md. Fill in the bracketed placeholders.

## Template

```markdown
---
name: [skill-name]
description: "[One-line description]"
license: MIT
metadata:
  version: "0.1.0"
  penny:
    state_machine: true
    mempalace: true
    subagents:
      - [agent1]
      - [agent2]
---

# [Skill Name]

[One-paragraph overview of what this skill does.]

## When to Use

- [Condition 1]
- [Condition 2]

## When NOT to Use

- [Anti-condition 1]
- [Anti-condition 2]

## Invocation

skill({ skill_name: "[name]", goal: "[goal description]" })

## Parameters

| Parameter | Required | Description |
|-----------|:--------:|-------------|
| `[param]` | Yes/No | [Description] |

## Output

[Where output lands and what format.]

## Chain Integration

[How this skill chains with others, if applicable.]

## Post-Completion

[What Penny should do after the skill completes.]
```

## Constraints

- **Replace all `[brackets]`.** No placeholder text in committed files.
- **Keep descriptions one line.** The body is for agents to read; be concise.
- **No deprecation notices.** Remove deprecated skills; don't leave warnings.

## Verification

- [ ] All bracketed placeholders replaced
- [ ] YAML frontmatter parses without errors
- [ ] When to Use / When NOT to Use sections present
- [ ] Invocation syntax documented

## Files

| File | Purpose |
|------|---------|
| `docs/agents/skills/skill-md-format.md` | Format specification |
| `docs/agents/skills/skill-standard.md` | Full skill standard |
