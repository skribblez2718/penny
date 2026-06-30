# Skill Quick Reference — One-page reference for skill authors

## What

Quick-reference checklist for creating and validating a new skill.

## Rules

### Create a skill
1. Run scaffold: `python scripts/tools/scaffold-skill.py --name <name> --description "..." --agents echo,piper`
2. Fill in SKILL.md: When to Use, When NOT to Use, invocation syntax
3. Implement `orchestrate.py`: start/step/status subcommands, JSON action output
4. Create `assets/prompts/<agent>.md` for each agent role
5. Write tests: unit, integration, E2E
6. Validate: `python scripts/system/checks/check_skill_structure.py --skill <name>`

### Validate a skill
- [ ] SKILL.md has valid YAML frontmatter
- [ ] `orchestrate.py` accepts start/step/status
- [ ] All subagents have prompt files
- [ ] Tests pass: `python3 -m pytest tests/ -v`
- [ ] `check_skill_structure.py` passes

### Common mistakes
- **Template variables in skill prompts.** `{{goal}}` belongs in task message, not prompt.
- **Reserved tags in skill prompts.** `<system_directives>`, `<agent_boundary>` are forbidden.
- **Cognitive Frame repeats in agent definitions.** Reference, don't restate.
- **Missing memory tools.** All four required for every agent.

## Files

| File | Purpose |
|------|---------|
| `docs/agents/skills/skill-standard.md` | Full standard |
| `docs/agents/skills/skill-md-format.md` | SKILL.md format |
| `docs/agents/skills/orchestration.md` | Orchestrator protocol |
| `docs/agents/skills/testing.md` | Test requirements |
