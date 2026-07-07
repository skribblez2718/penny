# Skills

## What They Are

Skills are multi-step workflows that run on a shared **orchestration engine** (`apps/orchestration/`). They are the layer above individual agents: a skill decides which agents to call, in what order, what context to give them, and how to combine their results into a final output. Penny invokes a skill with a single `skill({ skill_name, goal })` call, and the skill handles the rest.

Each skill is a `BasePlaybook` subclass in the engine package (`apps/orchestration/src/orchestration/playbooks/<skill>.py`) with its own named states, per-state SUMMARY contracts, and routing. The `.pi/skills/<skill>/scripts/orchestrate.py` file is a ~5-line delegate that hands `start`/`step`/`status`/`recover` to the engine — it holds no state-machine logic of its own.

If an agent is a specialist, a skill is a playbook for coordinating several specialists to complete a complex job.

## Why They Exist

Some tasks are too large or too multi-faceted for one agent. A design review might need an investigator, a planner, a critic, and a task-decomposer working in sequence. A security review might need parallel analysis followed by synthesis. Encoding that choreography as ad-hoc subagent calls inside Penny's context window would be brittle and hard to repeat.

Skills solve this by encapsulating the workflow. Each playbook defines the states, routing, agent dispatches, and decision points once, and the engine runs them consistently every time the skill is invoked. Penny does not need to remember the internal steps; she only needs to know when to use the skill and what goal to give it.

## Skill vs. Agent vs. Direct

| Approach | Best For | Analogy |
| -------- | -------- | ------- |
| **Direct** | A single tool call with trivial verification. | Penny picks up a pen and writes one sentence. |
| **Agent** | A focused task that benefits from a dedicated role. | Penny asks a specialist to produce one artifact. |
| **Skill** | A multi-step workflow that coordinates several agents and tools. | Penny hands a playbook to an orchestrator and checks back at the end. |

The rule of thumb is: if the work fits in one agent's scope, use an agent. If it needs a multi-step, multi-agent workflow, use a skill. Don't wrap a single agent call in a skill — that adds overhead without adding value.

## What a Skill Directory Contains

A typical skill lives in `.pi/skills/<name>/` and contains:

| Path | Purpose |
| ---- | ------- |
| `SKILL.md` | The manifest: what the skill does, when to use it, and how to invoke it. `metadata.penny.engine: orchestration` routes it to the engine. |
| `README.md` | Detailed documentation for humans and maintainers. |
| `scripts/orchestrate.py` | A ~5-line delegate to the engine (`from orchestration.cli import main`). The playbook itself lives in `apps/orchestration/`. |
| `assets/prompts/` | Domain Guidance prompts for each agent role the skill uses. |
| `resources/` | Reference material specific to the skill's domain. |
| `tests/` | Unit, integration, and E2E tests for the skill. |

This layout is standard across all skills. Consistency lets Pi discover skills automatically and lets agents know where to look for guidance.

## Why Skills Are Resumable

The engine persists run state to a durable SQLite checkpointer keyed by `run_id`, checkpointing after each step. If a step fails or the process is interrupted, the run **auto-resumes** from its last checkpoint on the next invocation rather than starting over — there is no manual resume step and no `/tmp` session file. This is essential for long workflows that may span multiple agent calls.

## Learn More

- [Skill Standard](skill-standard.md): What every skill must include.
- [Orchestration](orchestration.md): How the state machine dispatches agents.
- [Testing](testing.md): How skills are tested.
- Agent-facing reference: [Skill Overview](../../agents/skills/overview.md)
