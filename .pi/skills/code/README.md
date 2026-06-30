# Code Skill

## Overview

- **Purpose**: TDD-first coding skill using the Ralph Wiggum Loop. Always invoked for code generation, refactoring, or bug fixes. Uses skribble for implementation with mandatory security and coding standard compliance.
- **Hard Dependency**: Requires PRD + IDEAL_STATE from the `prd` skill. Use chain mode: `skill({ chain: [{ skill_name: "prd", ... }, { skill_name: "code", ... }] })`.
- **Use When**: Multi-step process requiring code orchestration after a PRD has been written
- **Outcome**: Validated implementation matching the IDEAL STATE from the PRD

## State Machine

```
explore → analyze → plan → implement → verify → learn
   ↑                                                │
   └────────────────────────────────────────────────┘
                  (loop back on gap)

Terminal: complete, error
Escalation: unknown → awaiting_clarification → resume → explore
```

Entry point is `explore`. The `prd` skill handles intake and specification (formerly `intake` → `define_specs`).

## Subagents Used

| Subagent | Purpose | Prompt File |
|----------|---------|-------------|
| echo | Deep exploration — find impacted files, verify IDEAL_STATE | assets/prompts/echo.md |
| annie | Security analysis — risks, integration surface, dependencies | assets/prompts/annie.md |
| piper | TDD implementation planning | assets/prompts/piper.md |
| skribble | Code implementation (RED → GREEN → REFACTOR) and verification | assets/prompts/skribble.md |
| carren | Gap evaluation — compare output to IDEAL STATE | assets/prompts/carren.md |

## Mempalace Integration

**Context Retrieved (before workflow)**:
- Read `skills/prd-{session_id}/IDEAL_STATE` — IDEAL STATE JSON from prd skill (required)
- Read `skills/prd-{session_id}/PRD Narrative` — PRD document (optional, for context)
- Search `skills/code-<session_id>` for prior session context

**Learnings Stored (after completion)**:
- `penny/skills` — Session summary, decisions, outcomes

## Files

| File | Purpose |
|------|---------|
| `scripts/orchestrate.py` | State machine entry point |
| `tests/test_*.py` | Unit, integration, and E2E tests |
| `assets/prompts/*.md` | Domain Guidance for subagents |
| `resources/reference.md` | Technical reference |
| `resources/flow.mmd` | Pure Mermaid state diagram |

## Testing

```bash
cd .pi/skills/code/tests
pytest test_unit.py test_integration.py test_server_detection.py -v
pytest test_e2e.py -m e2e -v
```

## Version History

- **1.0.0** — Initial scaffold
- **2.0.0** — Removed intake/define_specs; PRD skill is now hard dependency. Explore is the entry point.
