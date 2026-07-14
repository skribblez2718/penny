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

## Bitter-Lesson / Atomic-Loops Compliance (mandatory for new skills)

Every new playbook MUST comply with the [Atomic Loop Components](../architecture/atomic-loop-components.md) doctrine and the [Bitter-Lesson gate](../architecture/project-standards.md#the-bitter-lesson-gate--before-adding-scaffolding). The six shipped playbooks (`prd`/`plan`/`research`/`sca`/`jsa`/`rez`) are the reference implementations. The rules, with the engine seam that implements each:

1. **No keyword routers or magic-number tables.** Task understanding lives in the model, not an `if keyword in text` ladder or a `THRESHOLD_BY_MODE` dict. Mode/domain/topology decisions are **caller-constraint > model-declared (in a SUMMARY field) > safe default**, captured in `route_after`. (See `prd` domain, `research` mode.) A count/size that must be bounded is a **Budget** (`constraints["max_..."]`, a default clamp), not a frozen constant.
2. **Verify is evidence-gated.** Any VERIFY/VALIDATE/critique state declares an `evidence` field in its contract (`_c(required={..., "evidence": list}, evidence=["evidence"])`) so the engine rejects a PASS carrying no captured evidence (Rec 4). The verifier prompt states the evidence-tier hierarchy (execute > apply-the-rule > judge); a PASS that could have been executed but was only judged is under-verified. The captured evidence rides to `ctx.verify_evidence` and the outcome ledger automatically.
3. **Fan topology is the model's runtime output**, not a fixed `PARALLEL_BY_STATE`. A scoping/planning state emits the branches (`{branch_id: focus}`) which `route_after` turns into `ctx.extras["dynamic_branches"][state]`; the engine dispatches one branch per item, bounded by `constraints["max_fan_width"]`. Keep any legacy fixed topology only as a **tagged LOAN** fallback (`orchestration/loans.py`) with an `Ablate` toggle. (See `plan` scoping, `research` fan.) Pin branch agents to read-only roles when exploration must not mutate (a consequence boundary).
4. **Recall rides the first directive.** If your playbook overrides `_task_summary` (most do, for per-state task text), it MUST re-add the base's advisory lesson injection: `if ctx.recall_lessons and ctx.total_steps == 0: base += "...Lessons from prior runs (advisory...)..."`. The base `_task_summary` does this for free; an override that forgets it silently drops F2 Recall.
5. **Prompts state goals/constraints/capabilities, never procedure.** Each `assets/prompts/*.md` follows the **Mission / Blackboard protocol (wire) / Non-negotiables (boundaries) / Output (SUMMARY contract)** skeleton, ~≤80 lines. Wire formats (SUMMARY keys, confidence vocab, `needs_clarification`, mempalace room/drawer headers) are stated once, leanly. Domain criteria are *referenced* from `resources/` guidance, never restated as step-by-step. Consequence boundaries (READ-ONLY, NO-EXECUTION, output-dir scoping, "never call `questionnaire` from a subagent") are kept verbatim or strengthened. Domain **knowledge packs** the model reads (e.g. jsa's per-vuln-class files) are legitimate artifacts — not procedure to prune.
6. **Honest exhaustion + strategy-change on retry.** Bounded loops route to a terminal `met=False` with the unresolved issues on budget exhaustion — never a fabricated pass. The default-on engine guards (`progress_check` strategy-repeat + stall escalation) apply; a domain `progress_check` override supersedes them but must keep the needs-clarification and stall paths.
7. **Document the control-flow dial** in the module docstring: which routing is code-owned (wire verdicts) vs model-owned (topology, `fire_model_route`). Moving the dial toward the model must be a small edit, not a rewrite.
8. **Any kept heuristic is a tagged LOAN.** A threshold, table, or fallback the current model still needs goes in `orchestration/loans.py` with rationale + `review_by` + an `Ablate` toggle — never hard-coded untagged.

The reference PRDs in `research/atomic-loop-components/prds/` show each rule applied end-to-end per skill; the pre-ship checklist lives in [atomic-loop-components.md](../architecture/atomic-loop-components.md#pre-ship-checklist-run-on-any-new-loop).

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
- [ ] All agent roles have corresponding prompt files (Mission/Blackboard/Non-negotiables/Output skeleton, ≤~80 lines)
- [ ] Playbook tests pass: `python3 -m pytest apps/orchestration/tests/ -v`
- [ ] **Compliance (see the section above):** no keyword router / magic-number table; VERIFY states are evidence-gated; fan topology is model-emitted (fixed topology only as a tagged LOAN); `_task_summary` overrides re-add Recall injection; honest exhaustion on budget spend; the dial is documented; every kept heuristic is a tagged LOAN in `orchestration/loans.py`

## Files

| File | Purpose |
|------|---------|
| `docs/agents/skills/design-methodology.md` | How to design the workflow this standard packages |
| `docs/agents/skills/skill-md-format.md` | SKILL.md format specification |
| `docs/agents/skills/skill-md-template.md` | Copy-paste template |
| `docs/agents/skills/testing.md` | Playbook test requirements |
