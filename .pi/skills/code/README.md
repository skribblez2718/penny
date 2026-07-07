# Code Skill

## Overview

- **Purpose**: TDD-first coding skill using the Ralph Wiggum Loop. Always invoked for code generation, refactoring, or bug fixes. Uses skribble for implementation with mandatory security and coding standard compliance.
- **Hard Dependency**: Requires PRD + IDEAL_STATE from the `prd` skill. Use chain mode: `skill({ chain: [{ skill_name: "prd", ... }, { skill_name: "code", ... }] })`.
- **Use When**: Multi-step process requiring code orchestration after a PRD has been written
- **Outcome**: Validated implementation matching the IDEAL STATE from the PRD

## State Machine

The code skill runs on the shared orchestration engine — one `BasePlaybook`
subclass, `orchestration.playbooks.code:CodePlaybook`, whose `CodeMachine` FSM
has custom-named states:

```
intake → exploring → analyzing → checking_criteria
  → [criteria_gate: refine/accept/skip] → planning
  → [plan_gate: approve/refine/deny] → implementing → verifying ⇄ learning

learning gap=false → one final verifying → complete
learning gap=true  → implementing (within budget) | complete met=False (budget spent)
plan_gate deny     → error

Terminal: complete, error
Escalation: <working state incl. learning> → unknown → awaiting_clarification → exploring
```

Entry point is `exploring`. The `prd` skill handles intake and specification
(IDEAL_STATE), a hard dependency resolved by `start()`. See
`resources/flow.mmd` for the full mermaid diagram.

## Subagents Used

| Subagent | State(s) | Purpose | Prompt File |
|----------|----------|---------|-------------|
| echo | exploring | Deep exploration — find impacted files, verify IDEAL_STATE | assets/prompts/echo.md |
| annie | analyzing | Security analysis — risks, integration surface, dependencies | assets/prompts/annie.md |
| carren | checking_criteria, learning | Judge criteria quality before planning; judge output-vs-IDEAL-STATE gap | assets/prompts/carren.md |
| piper | planning | TDD implementation planning | assets/prompts/piper.md |
| skribble | implementing, verifying | Code implementation (RED → GREEN → REFACTOR) and verification | assets/prompts/skribble.md |

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
| `scripts/orchestrate.py` | Thin delegate routing `start`/`step`/`status`/`recover` to the orchestration engine |
| `assets/prompts/*.md` | Domain Guidance for subagents |
| `resources/reference.md` | Technical reference |
| `resources/flow.mmd` | Pure Mermaid state diagram |

The FSM itself lives in `apps/orchestration/src/orchestration/playbooks/code.py`
(and `code_detection.py` for server-framework detection).

## Testing

The playbook and detection logic are tested in the orchestration package:

```bash
pytest apps/orchestration/tests/test_code_playbook.py -v
pytest apps/orchestration/tests/test_code_detection.py -v
```

## Version History

- **1.0.0** — Initial scaffold
- **2.0.0** — Removed intake/define_specs; PRD skill is now a hard dependency. Explore is the entry point.
- **3.0.0** — Migrated onto the shared orchestration engine. `scripts/orchestrate.py` is now a thin delegate; the FSM lives in `orchestration.playbooks.code:CodePlaybook`. State persists in the engine's durable checkpointer (no `--state-data`).
