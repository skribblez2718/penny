# Skill Standard — Authoring, structure, and compliance for Penny skills

## What

Every skill follows a canonical structure: SKILL.md manifest, Python orchestrator, domain guidance prompts, and tests. Skills are discovered by Pi and invoked via the `skill` tool.

## Why

Consistent skill structure enables Pi's auto-discovery, the skill tool's mode detection, and agent context injection. Deviation breaks the pipeline.

## Rules

1. **SKILL.md is the manifest.** YAML frontmatter with `name`, `description`, `metadata.penny` fields. Markdown body with When to Use, When NOT to Use, invocation syntax.
2. **`orchestrate.py` is the state machine.** Must accept `start`, `step`, `status` subcommands. Must output JSON action directives to stdout.
3. **`assets/prompts/*.md` are Domain Guidance.** One per agent role used by the skill. Injected via `<skill_context>`.
4. **Tests are mandatory.** Unit, integration, and E2E tests in `tests/` directory.
5. **New skills use the scaffold.** `python scripts/tools/scaffold-skill.py --name <name>`. Never create skill files manually.

## Directory Structure

```
.pi/skills/<name>/
├── SKILL.md                    # Manifest
├── README.md                   # Detailed docs
├── scripts/
│   └── orchestrate.py          # State machine
├── assets/
│   └── prompts/
│       ├── echo.md             # Domain guidance per agent
│       └── ...
├── resources/
│   └── reference.md            # Skill-specific reference
└── tests/
    ├── test_unit.py
    ├── test_integration.py
    └── test_e2e.py
```

## SKILL.md Format

```yaml
---
name: skill-name
description: "One-line description"
license: MIT
metadata:
  version: "1.0.0"
  penny:
    state_machine: true
    mempalace: true
    subagents:
      - echo
      - piper
---
```

## Constraints

- **SKILL.md is Project Index, not Domain Guidance.** It tells Penny when to invoke. Domain patterns go in `assets/prompts/`.
- **No template variables in skill prompts.** `{{goal}}`, `{{session_id}}` belong in task messages.
- **No reserved security tags in skill prompts.** `<system_directives>`, `<system_context>`, `<system_boundary>`, `<agent_boundary>` are reserved.

## Verification

- [ ] SKILL.md has valid YAML frontmatter
- [ ] `orchestrate.py` accepts start/step/status
- [ ] All agent roles have corresponding prompt files
- [ ] Tests pass: `python3 -m pytest tests/ -v`
- [ ] `check_skill_structure.py --skill <name>` passes

## Files

| File | Purpose |
|------|---------|
| `docs/agents/skills/skill-md-format.md` | SKILL.md format specification |
| `docs/agents/skills/orchestration.md` | Orchestrator protocol |
| `docs/agents/skills/testing.md` | Test requirements |
