# Verification State — High-stakes gate before irreversible actions

## What

When a plan has high or irreversible stakes and confidence ≤ POSSIBLE, the FSM halts and requires explicit user confirmation before proceeding. Penny does not manually trigger verification — the FSM handles it.

## Why

Irreversible actions (file deletion, production changes, architectural decisions) require a human in the loop. Verification prevents the model from proceeding on low-confidence plans without review.

## Rules

1. **Verification is automatic.** The FSM's `needs_verification()` guard triggers it. Penny never invokes it manually.
2. **Three outcomes only.** `confirm` → proceed. `reject` → revise. `escalate` → user clarification.
3. **Verification cannot be skipped by any priority override.** It is a safety gate, not a preference.

## Procedure

### Guard: `needs_verification()`
Returns true when:
- `verification_mode` is not `off`
- `confidence` is UNCERTAIN, or POSSIBLE with high/irreversible stakes, or PROBABLE with strict mode + high/irreversible stakes

### Result handling
- `confirm` → advances to critiquing
- `reject` → returns to revising (agent re-plans)
- `escalate` → enters UNKNOWN_STATE → user clarification

## Constraints

- **Verification mode is set per plan.** `off` / `relaxed` / `default` / `strict`.
- **Stakes are set per plan.** `low` / `high` / `irreversible`.
- **Verification cannot be bypassed by "just do it" user intent.** Safety (in `<system_directives>`) overrides all numbered priorities.

## Verification

- [ ] `needs_verification()` returns true for high-stakes + POSSIBLE confidence
- [ ] `confirm` advances state; `reject` returns to revising
- [ ] State serialization preserves all verification fields across CLI round-trips

## Files

| File | Purpose |
|------|---------|
| `.pi/skills/plan/scripts/orchestrate.py` | `PlanWorkflow`, `needs_verification()`, `process_verification_result()` |
| `.pi/skills/plan/tests/test_unit.py` | Guards and transitions |
| `.pi/skills/plan/tests/test_integration.py` | Orchestrator API tests |
