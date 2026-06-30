# Skill Overview — What skills are and how they work

## What

Skills are multi-step workflows orchestrated by Python state machines. They dispatch agents, process results, and produce structured output. Penny invokes them via the `skill` tool.

## Why

Skills encapsulate complex multi-agent workflows behind a single invocation. Penny doesn't need to know the internal state machine — she just routes actions and presents results.

## Rules

1. **Skills are discovered by Pi** from `.pi/skills/*/SKILL.md` frontmatter.
2. **Skills use the `skill` tool** for invocation, not direct subagent calls.
3. **Skill output goes to mempalace.** Agents write full results; Penny receives structured SUMMARY.
4. **Skills are resumable.** Chain mode and state serialization enable recovery from failure.

## Skill vs. Agent vs. Direct

| Mechanism | Use When |
|-----------|----------|
| **Direct** | Single tool call, trivial verification |
| **Agent** | Single-domain task, benefits from role constraints |
| **Skill** | Multi-agent orchestration with state machine |

## Constraints

- **Skills are not for simple tasks.** Don't wrap a single agent call in a skill.
- **Skills must have tests.** Unit, integration, and E2E.

## Verification

- [ ] SKILL.md has valid frontmatter
- [ ] Orchestrator accepts start/step/status
- [ ] Tests pass

## Files

| File | Purpose |
|------|---------|
| `docs/agents/skills/skill-standard.md` | Full skill standard |
| `docs/agents/skills/orchestration.md` | Orchestrator protocol |
| `docs/agents/skills/skill-md-format.md` | SKILL.md specification |
