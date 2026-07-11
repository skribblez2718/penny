# Skill Standard — Authoring, structure, and compliance for Penny skills

## What

Every skill has two homes: the **playbook** (a `BasePlaybook` subclass in the `orchestration` package) that holds the state machine, and the **skill directory** (`.pi/skills/<name>/`) that holds the SKILL.md manifest, a thin delegate, domain-guidance prompts, and resources. Skills are discovered by Pi and invoked via the `skill` tool.

## Why

Consistent structure enables Pi's auto-discovery, the skill tool's mode detection, and agent context injection. Putting the FSM in the shared engine means resilience, gates, escalation, and parallel fan-out are inherited, not re-authored per skill.

## Rules

1. **SKILL.md is the manifest.** YAML frontmatter with `name`, `description`, `metadata.penny` fields (including `engine: orchestration`). Markdown body with When to Use, When NOT to Use, invocation syntax.
2. **The state machine is a playbook in the engine.** Write a `BasePlaybook` subclass in `apps/orchestration/src/orchestration/playbooks/<name>.py` (a python-statemachine `machine_cls` plus `NAME`, `PRIMITIVE_BY_STATE`, `route_after`, `done_predicate`, and — as needed — `GATE_STATES`/`gate_questions`/`route_user`, `PARALLEL_BY_STATE`, `TOOL_STATES`/`run_tool_state`, `ESCALATABLE_STATES`/`progress_check`). Register it in `playbooks/__init__.py`.
3. **`scripts/orchestrate.py` is a ~5-line delegate.** It only routes `start`/`step`/`status`/`recover` to the engine — no FSM, no state serialization:
   ```python
   from orchestration.cli import main
   if __name__ == "__main__":
       raise SystemExit(main(default_playbook="<name>"))
   ```
4. **`assets/prompts/*.md` are Domain Guidance.** One per agent role used by the skill. Injected via `<skill_context>`.
5. **Tests are mandatory.** The playbook is tested in `apps/orchestration/tests/` (see `testing.md`).
6. **The mempalace footprint is registered.** Every skill has an entry in `scripts/system/tiered_memory/skill_rooms.json` (`{"convention": "penny-wing"}` for `skills/<name>-<session_id>` rooms, or a dedicated-wing entry) so its scratch decays. `check_skill_structure.py` enforces this.
7. **Design precedes structure.** The states, gates, and knowledge split are derived per `design-methodology.md` — this standard specifies the container, not the design.

## Directory Structure

```
apps/orchestration/src/orchestration/playbooks/<name>.py   # BasePlaybook subclass (the FSM)
apps/orchestration/tests/test_<name>_playbook.py           # playbook tests

.pi/skills/<name>/
├── SKILL.md                    # Manifest (engine: orchestration)
├── README.md                   # Detailed docs
├── scripts/
│   └── orchestrate.py          # ~5-line delegate to orchestration.cli
├── assets/
│   └── prompts/
│       ├── echo.md             # Domain guidance per agent
│       └── ...
└── resources/
    ├── reference.md            # Skill-specific reference (checker-required)
    └── flow.mmd                # State diagram mirroring machine_cls (checker-required)
```

## SKILL.md Frontmatter

```yaml
---
name: skill-name
description: "One-line description. Use when … Do not use when …"
license: MIT
metadata:
  penny:
    engine: orchestration
    mempalace: true
    subagents: [echo, piper]
---
```

## State

Run state (current node, iteration count, per-state summaries) lives in the engine's durable SQLite checkpointer keyed by `run_id`. There is **no** `--state`/`--state-data` argv, **no** `/tmp/<skill>-<session_id>.json` session file, and **no** `extract_state`/`restore_state`. Crash-resume is automatic: an interrupted run re-issues its step on the next `step`/`recover`.

## Constraints

- **SKILL.md is Project Index, not Domain Guidance.** It tells Penny when to invoke. Domain patterns go in `assets/prompts/`.
- **No template variables in skill prompts.** `{{goal}}`, `{{session_id}}` belong in task messages.
- **No reserved security tags in skill prompts.** `<system_directives>`, `<system_context>`, `<system_boundary>`, `<agent_boundary>` are reserved.

## Verification

- [ ] SKILL.md has valid YAML frontmatter with `metadata.penny.engine: orchestration`
- [ ] A `BasePlaybook` subclass exists and is registered in `playbooks/__init__.py`
- [ ] `scripts/orchestrate.py` is the thin delegate (no FSM logic)
- [ ] All agent roles have corresponding prompt files
- [ ] Playbook tests pass: `python3 -m pytest apps/orchestration/tests/ -v`

## Files

| File | Purpose |
|------|---------|
| `docs/agents/skills/design-methodology.md` | How to design the workflow this standard packages |
| `docs/agents/skills/skill-md-format.md` | SKILL.md format specification |
| `docs/agents/skills/skill-md-template.md` | Copy-paste template |
| `docs/agents/skills/testing.md` | Playbook test requirements |
