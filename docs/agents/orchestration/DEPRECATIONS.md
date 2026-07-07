# Orchestration Deprecation Ledger

Tracks the legacy per-skill orchestration mechanisms that the shared
`orchestration` engine replaces. Every skill's SKILL.md now sets
`metadata.penny.engine: orchestration`, so the single-skill legacy path in
`.pi/extensions/skill/index.ts` has been deleted outright (see "Removed"
below) rather than gated behind a flag. Migration template:
[`research/penny-unified-overhaul/04-future-migration-playbook.md`](../../../research/penny-unified-overhaul/04-future-migration-playbook.md).

> **Removal discipline:** an entry is removed (code deleted) ONLY when its
> "Remove when" trigger is fully met — i.e. no skill still uses it. Grep tag for
> in-code markers: `DEPRECATED[ORCH-MIGRATION]`.

## Active deprecations

| ID | Item | Path(s) | Replaced by (engine path) | Remove when | Status |
|----|------|---------|---------------------------|-------------|--------|
| ORCH-1xx | *each migrated legacy skill's `orchestrate.py` FSM* | `.pi/skills/<skill>` | its `BasePlaybook` subclass in `apps/orchestration/.../playbooks/<skill>.py` | `<skill>` runs on the engine | added per skill as it migrates |

## Removed

| ID | Item | Removed from | Removed on | Notes |
|----|------|---------------|------------|-------|
| **ORCH-001** | `--state` argv state transport (FSM position + `orchestrator_state` blob passed on the command line) | `.pi/extensions/skill/index.ts` (`pythonStart`/`pythonStep`, `Action.orchestrator_state`, `SkillResult.escalation.orchestrator_state`) | `<DATE>` | Removed for the single-skill path — every directive now carries only `run_id`; the durable checkpointer owns all FSM state. The escalation-resume trigger was also fixed to key on `constraints.user_response` alone (engine `escalate_to_user` directives never carried `orchestrator_state` to begin with — see `apps/orchestration/.../contracts.py`). |
| **ORCH-002** | `/tmp/skill-checkpoints` single-skill resume files (`SkillCheckpoint`, `saveSkillCheckpoint`/`readSkillCheckpoint`) | `.pi/extensions/skill/index.ts` | `<DATE>` | Removed for the single-skill path. **Partially still active**: `ChainCheckpoint`/`saveCheckpoint`/`readCheckpoint` (chain mode, `resume_chain`) are chain-orthogonal and were deliberately KEPT — chain checkpoints still live under the same `/tmp/skill-checkpoints/` directory. |
| **ORCH-003** | manual `resume_skill` tool surface (`SkillParams.resume_skill`, the `resume_skill` execute case, `detectSkillMode`'s `resume_skill` mode) | `.pi/extensions/skill/index.ts`, `.pi/extensions/skill/skill-utils.ts` | `<DATE>` | Removed — had zero test coverage and depended on the now-deleted single-skill `/tmp` checkpoint (ORCH-002). **`resume_chain` is UNCHANGED and remains active** (chain mode is engine-orthogonal). |

## In-code marker convention

```
# DEPRECATED[ORCH-MIGRATION] ORCH-00X: replaced by orchestration (<what>).
# Remove when: <trigger>. Ledger: docs/agents/orchestration/DEPRECATIONS.md
```
(TS equivalent as a comment; add a one-time `logger.warn` if a deprecated branch
is ever entered on the engine path.)

## What is NOT deprecated

- The JSON directive contract (`invoke_agent` / `invoke_agents_parallel` /
  `escalate_to_user` / `complete` / `error` / `status`) — reused unchanged.
- `python-statemachine` — kept (the pain was per-skill duplication + argv-state
  transport, not the FSM library).
- Agent definitions (`.pi/agents/*.md`) and the questionnaire renderer — reused.
- The `caido` extension (`.pi/extensions/caido`) and its `caido_*` tools — still
  used (e.g. by the `jsa` skill).

## Removal procedure

1. `grep -rn "DEPRECATED\[ORCH-MIGRATION\]"` to find all markers.
2. For each, confirm its ledger "Remove when" trigger is met (no remaining user).
3. Delete the code + the ledger row; re-run the CI grep guards
   (`_force_state`, `--state` → zero in `apps/orchestration`).
