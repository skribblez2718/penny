# Skill Quick Reference — One-page reference for skill authors

## What

Quick-reference checklist for creating and validating a new skill on the shared orchestration engine.

## Rules

### Design first

Before any file is written, work through `design-methodology.md`: prove the
workflow manually, extract the phases with their failure-mode justifications,
front-load global decisions behind a gate, and draw `resources/flow.mmd`.

### Create a skill
1. **Write the playbook.** Add a `BasePlaybook` subclass to `apps/orchestration/src/orchestration/playbooks/<name>.py` — a python-statemachine `machine_cls` plus `NAME`, `PRIMITIVE_BY_STATE`, `route_after`, `done_predicate`, and (as needed) `GATE_STATES`/`gate_questions`/`route_user`, `PARALLEL_BY_STATE`, `TOOL_STATES`/`run_tool_state`, `ESCALATABLE_STATES`/`progress_check`, `skill_context` (per-state prompt files). Model it on `playbooks/code.py`, `playbooks/plan.py`, and `playbooks/learn.py`.
2. **Register it** in `playbooks/__init__.py` (`PLAYBOOKS` dict).
3. **Add the delegate.** `.pi/skills/<name>/scripts/orchestrate.py`:
   ```python
   from orchestration.cli import main
   if __name__ == "__main__":
       raise SystemExit(main(default_playbook="<name>"))
   ```
4. **Write SKILL.md** with `metadata.penny.engine: orchestration`: When to Use, When NOT to Use, invocation syntax.
5. **Create `assets/prompts/<agent>.md`** for each agent role (domain guidance). One agent serving multiple states gets per-state files (`<agent>-<state>.md`) named by the playbook's `skill_context()`.
6. **Create the checker-required files:** `README.md` (include the order-rule → failure-mode table), `resources/reference.md` (FSM/contracts/constraints reference mirroring the playbook), `resources/flow.mmd` (state diagram).
7. **Register the mempalace footprint** in `scripts/system/tiered_memory/skill_rooms.json` — `{"convention": "penny-wing"}` for `skills/<name>-<session_id>` rooms, or a dedicated-wing entry. Unregistered skills fail the checker (scratch would never decay).
8. **Write playbook tests** in `apps/orchestration/tests/test_<name>_playbook.py`.
9. **Validate:** `python scripts/system/checks/check_skill_structure.py --skill <name>`

### Validate a skill
- [ ] SKILL.md frontmatter valid; `metadata.penny.engine: orchestration` present
- [ ] `BasePlaybook` subclass registered in `playbooks/__init__.py`
- [ ] `scripts/orchestrate.py` is the thin delegate (no FSM)
- [ ] All subagents have prompt files (incl. per-state variants named by `skill_context()`)
- [ ] `README.md`, `resources/reference.md`, `resources/flow.mmd` present (checker-enforced)
- [ ] Skill registered in `scripts/system/tiered_memory/skill_rooms.json` (checker-enforced)
- [ ] Tests pass: `python3 -m pytest apps/orchestration/tests/ -v` (use the project venv — the `orchestration` package is installed there)
- [ ] Full suite still green (regression check), not just the new test file
- [ ] `check_skill_structure.py` passes
- [ ] Live smoke test: `.venv/bin/python .pi/skills/<name>/scripts/orchestrate.py start …` emits the expected first directive, and `status` reads back from the checkpointer

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
| `docs/agents/skills/design-methodology.md` | Design process (before this checklist) |
| `docs/agents/skills/skill-standard.md` | Full standard |
| `docs/agents/skills/skill-md-format.md` | SKILL.md format |
| `docs/agents/skills/testing.md` | Playbook test requirements |
| `docs/agents/skills/resilience.md` | Crash-resume and error handling |
