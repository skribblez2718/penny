# Skill Overview — What skills are and how they work

## What

A skill is a multi-step workflow that runs on the **shared orchestration engine** at `apps/orchestration/`. Each skill is a bespoke `BasePlaybook` subclass (in `apps/orchestration/src/orchestration/playbooks/<skill>.py`) with custom-named states, per-state SUMMARY contracts, routing, and a done predicate. The engine dispatches agents, persists run state, and produces structured output. Penny invokes skills via the `skill` tool.

## Why

Skills encapsulate complex multi-agent workflows behind a single invocation, all on ONE engine substrate. Penny doesn't need to know the internal state graph — she routes actions and presents the per-state summaries. Sharing one engine means crash-resume, escalation, gates, and parallel fan-out are implemented once, not re-invented per skill.

## Rules

1. **Skills are discovered by Pi** from `.pi/skills/*/SKILL.md` frontmatter.
2. **The playbook lives in the engine package**, not in the skill directory. `.pi/skills/<skill>/scripts/orchestrate.py` is a ~5-line delegate to `orchestration.cli:main`.
3. **Skills use the `skill` tool** for invocation, not direct subagent calls.
4. **Skill output goes to mempalace.** Agents write full results; Penny receives structured SUMMARY per state.
5. **Skills are resumable automatically.** Run state lives in the engine's durable SQLite checkpointer keyed by `run_id`; an interrupted run re-issues its last step on the next `step`/`recover`.

## Skill vs. Agent vs. Direct

| Mechanism | Use When |
|-----------|----------|
| **Direct** | Single tool call, trivial verification |
| **Agent** | Single-domain task, benefits from role constraints |
| **Skill** | Multi-agent orchestration on the engine |

## Constraints

- **Skills are not for simple tasks.** Don't wrap a single agent call in a skill.
- **Skills must have tests.** Playbook tests live in `apps/orchestration/tests/`.

## Verification

- [ ] SKILL.md has valid frontmatter with `metadata.penny.engine: orchestration`
- [ ] A `BasePlaybook` subclass exists and is registered in `playbooks/__init__.py`
- [ ] `scripts/orchestrate.py` delegates to the engine
- [ ] Tests pass

## Files

| File | Purpose |
|------|---------|
| `docs/agents/skills/skill-standard.md` | Full skill standard |
| `docs/agents/skills/skill-md-format.md` | SKILL.md specification |
| `docs/agents/skills/testing.md` | Playbook test requirements |
