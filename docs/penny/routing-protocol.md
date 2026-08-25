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

## Engine-backed skills (orchestration)

Skills whose `SKILL.md` sets `metadata.penny.engine: orchestration` run on the
shared `orchestration` engine: each is a `BasePlaybook` subclass with its own
domain-named states and a per-state SUMMARY contract. State lives in a durable
checkpointer keyed by `run_id` (no `--state`, no `/tmp`), and interrupted runs
resume from durable state. The current user-facing workflow catalog contains
only `research`. Invoke it for structured, multi-source investigations when its
evidence gathering, citation validation, retries, or resume behavior earn the
overhead. The engine internals do not change how you choose: route by capability,
then invoke by name with `skill({ skill_name: "research", goal })`.

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
