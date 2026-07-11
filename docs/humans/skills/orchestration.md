# Skill Orchestration

## What It Is

Orchestration is the mechanism by which a skill turns a high-level goal into a sequence of concrete actions. At the center is a Python state machine that advances step by step, asking Penny to dispatch agents or tools, and then deciding what to do based on the results it gets back. That state machine runs on a shared **orchestration engine** (`apps/orchestration/`); each skill's `scripts/orchestrate.py` is a ~5-line delegate into it.

Think of the orchestrator as the director of a play. It knows the script, calls the actors onto stage, and handles the plot twists.

## Why State Machines?

State machines make complex workflows explicit. Every state represents a meaningful phase of the work. Every transition represents a decision. This makes the skill easier to reason about, easier to test, and easier to resume after a failure.

Without a state machine, a multi-agent workflow tends to become a pile of conditional branches that are hard to follow. With a state machine, the structure is visible: intake, planning, execution, review, completion.

## The Three-Layer Model

Skill orchestration operates across three layers:

| Layer | Responsibility | Who It Is |
| ----- | -------------- | --------- |
| **Penny** | Decides to use the skill and interprets the final summary. | The main assistant. |
| **Orchestrator** | Manages the state machine and emits action directives. | The engine (`apps/orchestration/`), running the skill's `BasePlaybook` subclass; launched via the `scripts/orchestrate.py` delegate. |
| **Agents** | Perform specialized reasoning tasks and write full output to mempalace. | The subprocesses invoked by Penny on the orchestrator's behalf. |

Penny hands a goal to the orchestrator. The orchestrator emits a directive like "invoke echo to investigate" or "invoke piper to plan." Penny performs the dispatch, the agent returns a SUMMARY, and Penny passes that SUMMARY back to the orchestrator's `step` handler. The cycle repeats until the orchestrator reaches a `complete` or `error` state.

## What the Engine Does

Through the `orchestrate.py` delegate, the engine has three jobs:

1. **Initialize.** The `start` subcommand sets up the state machine, records the goal and session context, and returns the first action directive.
2. **Advance.** The `step` subcommand consumes the result of the previous action, updates the state machine, and returns the next action directive.
3. **Persist.** Between calls, the engine checkpoints its state to a durable SQLite store keyed by `run_id` so it can resume if interrupted. There is no `/tmp` session file to write and no manual serialization.

## Engine-Backed Skills

Every workflow skill delegates to the shared **orchestration engine** (`apps/orchestration/`). Its `scripts/orchestrate.py` is a ~5-line delegate, and the real state machine is a `BasePlaybook` subclass in the engine package, with its own states and a per-state contract that validates each agent's SUMMARY. Two things this buys you:

- **Durable resume.** State lives in a durable checkpointer keyed by a `run_id`, not in a `/tmp` file. An interrupted run **auto-resumes** on the next invocation — there is no manual resume step.
- **Shared capabilities.** Every skill gets the same budgets, self-recovery, parallel fan-out, planned approval gates, and correlated observability without re-implementing them.

Every workflow skill runs on the engine — `code`, `plan`, `prd`, `research`, `agent`, `sca`, `jsa`, `rez`, and `learn` — with no exceptions.

Every action directive is a JSON object emitted on stdout. Common directives include:

| Directive | Meaning |
| --------- | ------- |
| `invoke_agent` | Run one agent with a task summary and a mempalace room. |
| `invoke_agents_parallel` | Run several agents at once. |
| `escalate_to_user` | Pause the skill and ask the user a clarifying question. |
| `complete` | The skill has finished; return the final result. |
| `error` | Something went wrong; include diagnostics. |

## How Agents Are Dispatched Within a Skill

When the orchestrator emits an `invoke_agent` directive, it provides:

- The agent name.
- A short `task_summary` describing what the agent should do.
- The `session_room` where the agent should read and write context.

Penny then invokes the agent, passing the skill's Domain Guidance prompt along with the task. The agent works in isolation, writes its full output to mempalace, and returns a SUMMARY. Penny passes that SUMMARY back to the orchestrator, which uses it to choose the next transition.

This loop lets a skill chain agents, run them in parallel, or branch based on results — all without Penny needing to hold the entire plan in her head.

## Learn More

- [Skills Overview](overview.md): The bigger picture of why skills exist.
- [Skill Standard](skill-standard.md): The structural requirements a skill must meet.
- [Testing](testing.md): How orchestration is covered by tests.
- Agent-facing reference: [Skill Orchestration](../../agents/skills/orchestration.md)
