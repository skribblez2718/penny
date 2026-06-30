# Skill Testing

## What Testing Standards Exist

Every skill is required to have three kinds of tests: unit tests, integration tests, and end-to-end tests. Together they cover the skill from its smallest pieces to its full multi-agent pipeline.

| Test Type | What It Covers | Why It Matters |
| --------- | -------------- | -------------- |
| **Unit** | Individual functions, state transitions, guards, and SUMMARY parsing. | Catches bugs in the logic that drives the state machine. |
| **Integration** | How modules fit together: serialization, state restoration, and the advance flow. | Catches mismatches between parts that work in isolation. |
| **End-to-End (E2E)** | The full pipeline from `start` through one or more `step` calls to `complete`. | Catches problems that only appear when the whole workflow runs. |

## Why Each Layer Matters

Unit tests are the microscope. They verify that each state transition happens when it should, that guards return the right boolean, and that the orchestrator parses agent SUMMARYs correctly. A state machine with dozens of transitions is too easy to break with a small change; unit tests catch that immediately.

Integration tests are the assembly check. They make sure the orchestrator can save its state to disk and load it back losslessly. They verify that the `step` command correctly consumes a result and produces the next directive. These tests sit between unit and E2E, catching problems that involve multiple modules but do not need a live agent.

E2E tests are the dress rehearsal. They feed pre-built agent SUMMARYs into the orchestrator and run the entire workflow from start to finish. No live agent subprocess is needed, but every state and transition is exercised. E2E tests prove that the skill can complete its intended job.

## What a Well-Tested Skill Looks Like

A well-tested skill has a `tests/` directory containing `test_unit.py`, `test_integration.py`, and `test_e2e.py`. The tests run with a single command:

```bash
python3 -m pytest tests/ -v
```

Importantly, the tests do not spin up real agent processes. Agent results are mocked by providing pre-built SUMMARY JSON to the `step` handler. This keeps the tests fast, deterministic, and independent of model availability.

The test suite also exercises failure paths. A skill that only tests the happy path is not well tested. Good coverage includes malformed SUMMARYs, state restore failures, and transitions into error states.

## Why E2E Is Mandatory

E2E tests are not a nice-to-have. Because skills coordinate multiple agents and state transitions, the only way to be confident the whole workflow behaves as designed is to run it end to end. Stubs and placeholders in the E2E suite mean the skill has not actually been exercised as a complete system.

## Learn More

- [Skills Overview](overview.md): What skills are and when to use them.
- [Skill Standard](skill-standard.md): The structural requirements that include testing.
- [Orchestration](orchestration.md): How the orchestrator protocol is tested.
- Agent-facing reference: [Skill Testing](../../agents/skills/testing.md)
