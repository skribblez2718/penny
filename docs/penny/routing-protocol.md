# Routing & Delegation Protocol

Read this on demand when choosing an execution path or constructing a delegation.
SYSTEM.md carries only the concise trigger (choose the lowest-complexity path
expected to succeed); this doc holds the full policy and mechanics.

## The routing policy

Choose the lowest-complexity path expected to succeed. Work directly when
Penny's current context and tools suffice. Use a subagent when specialization,
isolated context, parallel exploration, or a separate review adds material
value. Use a skill when an established workflow's durable state, approval
gates, retries, iteration budget, or resume behavior adds material value.

Direct work is a first-class path, not a failure to orchestrate — and as models
improve, more work becomes cheap to do directly. Delegation has real costs
(handoff formulation, context loss, result integration, latency, correlated
errors); pay them only when the machinery earns its keep.

| Path         | Use when                                                                                         | Avoid when                                                                                 |
| ------------ | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| **Direct**   | Current context and tools are sufficient; handoff would add more overhead than value             | The task needs context isolation, parallel exploration, durable state, or a gated workflow |
| **Subagent** | A specialist role, isolated context, separate review, or parallel branch will improve the result | Single reads/edits/calls; the parent already has all context and tools                     |
| **Skill**    | A known workflow needs checkpoints, retries, gates, receipts, or resume                          | Ad hoc work where no workflow state is valuable                                            |

Route by capability reasoning against this table — what does the task actually
need? — not by keyword matching. "Multi-step" alone justifies neither a skill
nor a subagent.

## Bounded work coordination

For substantial decomposition or dependent execution, read [Bounded Work](../agents/agents/bounded-work.md). Use one coherent delegation without a graph when that suffices; use execution-ready leaves and explicit consumed-output dependencies when long-horizon work warrants them. Do not delegate merely to satisfy a task count.

Penny supplies a bounded outcome, sufficient exact inputs, applicable constraints and change scope, expected outputs/evidence, and the context-fit basis through existing invocation fields. Ensure the worker has the applicable guidance rather than assuming it inherits this parent-only protocol. Select a suitable role within its actual authority; an approved plan or task description does not authorize implementation, deployment, or broader tools.

After execution is authorized, choose an eligible task whose prerequisites are satisfied and dispatch it to a fresh worker. Inspect the captured result and appropriate evidence before accepting its outcome or releasing dependent work. Process completion and successful artifact delivery alone do not establish task acceptance. Clarify, repair, or re-decompose when the result is blocked, incomplete, or reveals unsupported scope/context assumptions; do not advance on a success-looking report or a transport-only chain gate.

Reuse accepted products through exact IDs, assess shared-resource conflicts before parallel dispatch, and include integration outcomes. Keep coordinator context focused on the current decision and needed refs. Honor registered workflow state and completion rules where applicable; no parallel execution ledger, new scheduler, or universal reviewer/step limit is introduced.

## Engine-backed skills (orchestration)

Playbooks are registered TypeScript `PlaybookCore` implementations.
`PLAYBOOK_REGISTRY` is the sole executable registry; the common engine owns
validated phase results, deterministic repair routing, bounded attempts,
checkpointing, and terminal admission.

The generic `skill()` ingress exposes the six catalog skills `assess`, `decide`,
`diagnose`, `plan`, `produce`, and `research`. `knowledge-base` is also a
registered playbook, but it is classified `dedicated_tool` and is reached through
the `knowledge_base` tool rather than generic skill ingress. Direct work remains
a first-class routing path outside `PLAYBOOK_REGISTRY`; use ordinary tool-capable
model behavior when orchestration state would add no value.

Role/state prompt guidance is resolved from the active registry binding for each
phase. Review and approval are task- and consequence-conditioned: the six generic
skills declare no additional planned approval gate, while knowledge-base
publication paths use their host-mediated review/approval states. Existing trust
and action boundaries still govern every direct or orchestrated action.

State lives in a durable checkpointer keyed by `run_id` (no `--state`, no `/tmp`),
and interrupted runs resume from durable state. Route by capability, then invoke
a matching generic skill with `skill({ skill_name, goal })`; use the dedicated
knowledge-base tool for knowledge-base operations. Do not implement hidden
skill-specific executable branches outside the registry.

## Context passing

Agents lack your conversation history. When delegating, structure tasks as:

`Task: <goal> | Context: <background> | Sources: <paths or URLs> | Constraints: <hard limits>`

Task is required. Include only what the agent cannot discover.

Never pass a memory drawer ID, room, or search query as a workflow source. Memory
is curated durable knowledge, not a handoff channel; an agent pointed at memory
for a predecessor's output will search for it instead of reading it.

## Passing a predecessor's output forward

Every delegation result prints its exact output artifact ID. To give the next
agent that output, pass the ID — do not re-run the producer and do not paste its
text into the task:

```text
subagent({ agent: "skribble", task: "Fix the blockers in the review.",
           input_artifacts: ["art_<id from the review result>"] })
```

The owner performs exact manifest lookup and digest/length verification before spawn,
then appends the ID/read instruction to the task. IDs may come from different agents,
runs, sessions, or branches; multi-source fan-in is supported. Chain mode inserts the
prior ID automatically through `{previous}` and each chain step may also take additional
`input_artifacts`.

The anti-pattern this replaces: re-invoking an agent to "return a report of your
just-completed review." That output already exists as an artifact — read it or
forward it.

## Agent escalation

Agents cannot invoke the questionnaire tool directly. When an agent needs user
clarification it must escalate to you via `needs_clarification: true` with
`clarifying_questions`. You present these questions to the user via the
questionnaire, then pass the answers back to the agent with the required context.
