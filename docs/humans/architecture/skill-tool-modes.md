# Skill Tool Modes: How Penny Runs Multi-Step Work

## What It Is

The `skill` tool is how Penny invokes structured, multi-step workflows. A skill can be run in one of four modes: single, parallel, chain, or resume. Each mode exists because different kinds of tasks need different execution patterns.

Penny decides when to invoke a skill; the skill decides how to execute internally. Communication between Penny and the skill's agents happens through mempalace, so Penny's own context stays clean.

## Why Different Modes Exist

Some tasks are simple: do one thing and return. Some tasks have independent parts that can run at the same time. Some tasks must happen in order, with each step building on the previous one. Some long chains fail partway through and need to be restarted without redoing the work that already succeeded.

A single mode would force one of these patterns onto every task. The four modes let the invocation match the shape of the work.

## The Four Modes

### Single

One skill, one goal. This is the default for straightforward tasks.

Example: run the planning skill to design an authentication refactor.

When to see it: when the task is self-contained and does not need coordination with other skills.

### Parallel

Up to three skills run at the same time. Each skill can spawn its own agents. The failure of one skill does not abort the others.

Example: research OAuth 2.1 while simultaneously planning the auth refactor.

When to see it: when independent workstreams can save time.

### Chain

Up to ten steps run in sequence. Each step receives a summary of the previous step's output. The chain stops on the first error, but it writes a checkpoint so it can be resumed.

Example: research auth patterns, then plan a refactor based on that research, then generate the implementation plan based on the plan.

When to see it: when steps depend on each other and must happen in order.

### Resume

A chain that failed is restarted from its checkpoint. Completed steps are skipped; execution picks up at the failed step.

When to see it: after a chain error, when the underlying problem has been fixed and the remaining work should continue.

## How the Mode Is Chosen

The `skill` tool looks for mode indicators in this order:

1. `resume_chain` — if present, resume mode
2. `chain` — if present, chain mode
3. `skills` — if present, parallel mode
4. otherwise, single mode

Only one mode is allowed per invocation. Ambiguous parameters produce an error rather than guessing.

## Limits and Constraints

| Limit | Value | Why It Exists |
| --- | --- | --- |
| Max parallel skills | 3 | Prevents too many concurrent subagent swarms |
| Max chain steps | 10 | Keeps chains from becoming untraceable scripts |
| Previous-step summary | 2,000 characters | Fits in context without dumping full agent output |
| Skill timeout | 90 minutes | Hard ceiling for long-running work |
| Agent timeout | 30 minutes | Base ceiling for individual agent invocations |
| Checkpoints | `/tmp/skill-checkpoints/` | Kept out of the project tree; OS may clear them on reboot |

## What Happens When Things Fail

| Mode | Failure Behavior |
| --- | --- |
| **Single** | The skill returns an error result. Penny decides whether to retry, escalate, or stop. |
| **Parallel** | The failing skill returns an error; the other skills continue. Results are reported per skill. |
| **Chain** | Execution stops at the first failing step. A checkpoint is written so the chain can be resumed. |
| **Resume** | The resumed chain skips completed steps and starts from the failed step. Stale checkpoints warn but still allow resume. |

## Related Documents

- Agent docs: `docs/agents/architecture/skill-tool-modes.md`
- Operational guide: `docs/agents/capabilities/skill-tool/skill-tool.md`
- State management: `docs/humans/state-management/state-management.md`
