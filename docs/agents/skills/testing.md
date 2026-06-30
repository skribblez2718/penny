# Skill Testing — Test requirements for skills

## What

Every skill requires unit, integration, and E2E tests. Tests validate the orchestrator state machine, agent SUMMARY parsing, and full pipeline execution.

## Why

Skills are complex state machines with multiple agents and mempalace interactions. Without comprehensive tests, regressions are invisible until runtime failures.

## Rules

1. **Unit tests** — per-module tests for state transitions, guards, SUMMARY parsing, action generation.
2. **Integration tests** — multi-module tests for serialization, advance flow, state restoration.
3. **E2E tests** — full pipeline from `start` to `complete` with mocked agent results.
4. **Run with pytest.** `python3 -m pytest tests/ -v`
5. **Test all states and transitions.** Every FSM state and every guard condition must have coverage.

## Test Structure

```
tests/
├── test_unit.py          # State transitions, guards, actions
├── test_integration.py   # Serialization, advance flow
└── test_e2e.py           # Full pipeline simulation
```

## Constraints

- **E2E tests are mandatory.** Not optional. Stubs and placeholders are not acceptable.
- **Mock agent results, not agent processes.** E2E tests feed pre-built SUMMARY JSON to `step`.
- **Test state serialization round-trips.** `extract_state()` → `restore_state()` must be lossless.

## Verification

- [ ] Unit tests cover all states and transitions
- [ ] Integration tests cover serialization and advance flow
- [ ] E2E tests cover full pipeline
- [ ] All tests pass: `python3 -m pytest tests/ -v`

## Files

| File | Purpose |
|------|---------|
| `docs/agents/skills/skill-standard.md` | Full skill standard |
| `docs/agents/skills/orchestration.md` | Orchestrator protocol |
