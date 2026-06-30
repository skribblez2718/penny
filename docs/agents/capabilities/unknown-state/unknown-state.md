# UNKNOWN_STATE — FSM state when an agent cannot proceed

## What

When an agent returns `confidence: UNCERTAIN`, the FSM halts and escalates to the user for direction. Penny relays between user and orchestrator — the FSM decides how to handle the response.

## Why

Agents hit blockers: missing information, ambiguous requirements, contradictory constraints. UNKNOWN_STATE provides a structured pause-and-resume path instead of guessing or failing silently.

## Rules

1. **Triggered by `confidence: UNCERTAIN` in agent SUMMARY.** The `_check_confidence_and_handle()` gatekeeper catches this.
2. **Penny relays, does not decide.** The FSM's `process_user_clarification()` handles the user's response.
3. **Three user choices.** `restart` (abandon session), `skip` (clear blocker and resume), `retry` (resume with same context).

## Procedure

### Entry
1. Agent returns `confidence: UNCERTAIN` with `unknown_reason`
2. `_check_confidence_and_handle()` saves `previous_state`, sends `escalate` transition
3. FSM enters `awaiting_clarification`
4. Penny presents the question to the user

### Resume
- `restart` → `abandon` → session ends
- `skip` → clear `unknown_reason`, resume to `previous_state`
- `retry` (default) → resume to `previous_state`

## Constraints

- **UNKNOWN_STATE is not an error.** It's a structured pause. The session is recoverable.
- **`previous_state` must be preserved** across the UNKNOWN_STATE round-trip for correct resume.
- **All UNKNOWN_STATE fields must be serialized** in `extract_state()` for CLI persistence.

## Verification

- [ ] `confidence: UNCERTAIN` triggers UNKNOWN_STATE, not silent failure
- [ ] `restart`, `skip`, `retry` all route correctly
- [ ] State serialization preserves `previous_state`, `unknown_reason`, `clarification_text`

## Files

| File | Purpose |
|------|---------|
| `.pi/skills/plan/scripts/orchestrate.py` | `PlanWorkflow`, `process_user_clarification()` |
| `.pi/skills/plan/tests/test_unit.py` | Unit tests |
| `.pi/skills/plan/tests/test_integration.py` | Integration tests |
