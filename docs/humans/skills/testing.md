# Skill Testing

## What Testing Standards Exist

Every skill's state machine — its `BasePlaybook` subclass — is tested step by step in the engine package (`apps/orchestration/tests/test_<name>_playbook.py`). The tests drive the playbook exactly the way production does: each step constructs a fresh playbook instance pointed at the same temporary checkpointer, feeds it a pre-built agent SUMMARY, and asserts the directive that comes back.

| What Gets Covered | Why It Matters |
| ----------------- | -------------- |
| The happy path from `start` to `complete`. | Proves the skill can finish its intended job. |
| Every gate branch (approve / refine / deny). | Human decision points must route correctly in all three directions. |
| Retry loops and their budgets, including exhaustion. | An exhausted budget must end in an honest "not met" report, never a fabricated success. |
| Stall detection and escalation. | A loop making no progress must ask the human instead of burning its budget. |
| Malformed or uncertain agent results. | Bad data must re-issue or escalate, never advance the workflow. |
| Crash-resume. | A killed run must pick up where it left off. |

## Why This Shape

A playbook is a state machine coordinating several agents. The only way to trust it is to walk every branch — including the unhappy ones. The tests deliberately mirror production reality: production runs one subprocess per step, so tests build a fresh playbook instance per step and let the durable checkpointer carry the state between them. If the tests pass, the persistence contract has been exercised for free.

Importantly, the tests do not spin up real agent processes. Agent results are mocked by providing pre-built SUMMARY JSON to the `step` handler. This keeps the tests fast, deterministic, and independent of model availability.

There is one thing the tests deliberately do *not* cover per skill: state serialization round-trips. Persistence belongs to the engine's checkpointer and is covered once by the engine's own tests — skills inherit it rather than re-proving it.

## What a Well-Tested Skill Looks Like

One test file per skill in `apps/orchestration/tests/`, runnable with a single command from `apps/orchestration/` (using the project's virtual environment, where the engine package is installed):

```bash
.venv/bin/python -m pytest tests/ -v
```

A skill that only tests the happy path is not well tested. Full-branch coverage — every gate route, every loop edge, every terminal outcome — is the standard, and the whole engine suite is re-run after any change to catch cross-skill regressions.

## Learn More

- [Skills Overview](overview.md): What skills are and when to use them.
- [Skill Standard](skill-standard.md): The structural requirements that include testing.
- [Orchestration](orchestration.md): How the orchestrator protocol is tested.
- Agent-facing reference: [Skill Testing](../../agents/skills/testing.md)
