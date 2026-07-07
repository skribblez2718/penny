# SKILL.md Template — Copy-paste template for new skills

## What

Use this template as the starting point for any new skill's SKILL.md. Fill in the bracketed placeholders. It mirrors the reference manifest at `.pi/skills/code/SKILL.md`.

## Template

```markdown
---
name: [skill-name]
description: "[One sentence]. Use when [trigger conditions + signal phrases]. Do not use when [anti-cases — use X instead]."
license: MIT
metadata:
  penny:
    engine: orchestration
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

Invoke via the `skill` tool. The skill runs on the shared orchestration engine
(`orchestration.playbooks.[skill-name]:[Skill]Playbook`); the thin
`scripts/orchestrate.py` delegate only routes `start`/`step`/`status`/`recover`.
Run state lives in the engine's durable checkpointer keyed by `run_id` — there is
no `--state`.

skill({ skill_name: "[name]", goal: "[goal description]" })

## Parameters

| Parameter | Required | Description |
|-----------|:--------:|-------------|
| `[param]` | Yes/No | [Description] |

## Output

[Where output lands and what format. Agents write to mempalace; Penny sees per-state SUMMARYs.]

## Chain Integration

[How this skill chains with others, if applicable.]

## Post-Completion

[What Penny should do after the skill completes.]
```

## Constraints

- **Replace all `[brackets]`.** No placeholder text in committed files.
- **Use `engine: orchestration`.** Do not add the removed `state_machine` key.
- **Keep descriptions one line.** The body is for agents to read; be concise.
- **No deprecation notices.** Remove deprecated skills; don't leave warnings.

## Verification

- [ ] All bracketed placeholders replaced
- [ ] YAML frontmatter parses; `metadata.penny.engine: orchestration` present
- [ ] When to Use / When NOT to Use sections present
- [ ] Invocation syntax documented

## Files

| File | Purpose |
|------|---------|
| `docs/agents/skills/skill-md-format.md` | Format specification |
| `docs/agents/skills/skill-standard.md` | Full skill standard |
