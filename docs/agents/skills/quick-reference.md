# Skill Quick Reference — One-page reference for skill authors

## What

Quick-reference checklist for creating and validating a new skill on the shared orchestration engine.

## Rules

### Create a skill
1. **Write the playbook.** Add a `BasePlaybook` subclass to `apps/orchestration/src/orchestration/playbooks/<name>.py` — a python-statemachine `machine_cls` plus `NAME`, `PRIMITIVE_BY_STATE`, `route_after`, `done_predicate`, and (as needed) `GATE_STATES`/`gate_questions`/`route_user`, `PARALLEL_BY_STATE`, `TOOL_STATES`/`run_tool_state`, `ESCALATABLE_STATES`/`progress_check`. Model it on `playbooks/code.py` and `playbooks/plan.py`.
2. **Register it** in `playbooks/__init__.py` (`PLAYBOOKS` dict).
3. **Add the delegate.** `.pi/skills/<name>/scripts/orchestrate.py`:
   ```python
   from orchestration.cli import main
   if __name__ == "__main__":
       raise SystemExit(main(default_playbook="<name>"))
   ```
4. **Write SKILL.md** with `metadata.penny.engine: orchestration`: When to Use, When NOT to Use, invocation syntax.
5. **Create `assets/prompts/<agent>.md`** for each agent role (domain guidance).
6. **Write playbook tests** in `apps/orchestration/tests/test_<name>_playbook.py`.
7. **Validate:** `python scripts/system/checks/check_skill_structure.py --skill <name>`

### Validate a skill
- [ ] SKILL.md frontmatter valid; `metadata.penny.engine: orchestration` present
- [ ] `BasePlaybook` subclass registered in `playbooks/__init__.py`
- [ ] `scripts/orchestrate.py` is the thin delegate (no FSM)
- [ ] All subagents have prompt files
- [ ] Tests pass: `python3 -m pytest apps/orchestration/tests/ -v`
- [ ] `check_skill_structure.py` passes

### Common mistakes
- **Legacy `state_machine: true` key.** Removed — use `engine: orchestration`.
- **FSM logic in `orchestrate.py`.** The state machine belongs in the engine playbook; the script only delegates.
- **Template variables in skill prompts.** `{{goal}}` belongs in the task message, not the prompt.
- **Reserved tags in skill prompts.** `<system_directives>`, `<agent_boundary>` are forbidden.
- **Cognitive Frame repeats in agent definitions.** Reference, don't restate.
- **Missing memory tools.** All four required for every agent.

## Files

| File | Purpose |
|------|---------|
| `docs/agents/skills/skill-standard.md` | Full standard |
| `docs/agents/skills/skill-md-format.md` | SKILL.md format |
| `docs/agents/skills/testing.md` | Playbook test requirements |
| `docs/agents/skills/resilience.md` | Crash-resume and error handling |
