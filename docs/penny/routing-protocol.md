# Routing & Delegation Protocol

Read this on demand when you need the full mechanics of delegating to skills and
agents. The routing **decision** (skill vs agent vs direct, signal-word matching,
decision order) stays inline in SYSTEM.md — this doc holds the details you only
need while actually constructing a delegation.

## Engine-backed skills (orchestration)

Skills whose `SKILL.md` sets `metadata.penny.engine: orchestration` run on the
shared `orchestration` engine: each is a `BasePlaybook` subclass with its own
domain-named states and a per-state SUMMARY contract. State lives in a durable
checkpointer keyed by `run_id` (no `--state`, no `/tmp`), and interrupted runs
**auto-resume** on the next invocation (no manual resume). Every workflow skill
runs on the engine (`code`, `plan`, `prd`, `research`, `agent`, `sca`, `jsa`); the
only exception is `rez`, a placeholder skill awaiting a dedicated build (no
`engine` field). All skills are visible/model-selectable; there is no hidden shelf.
The engine internals do not change how you choose — you still route to a skill by
name via `skill({ skill_name, goal })`.

## Context passing

Agents lack your conversation history. When delegating, structure tasks as:

`Task: <goal> | Context: <background> | Sources: <paths or drawer IDs> | Constraints: <hard limits>`

Task is required. Include only what the agent cannot discover.

## Agent escalation

Agents cannot invoke the questionnaire tool directly. When an agent needs user
clarification it must escalate to you via `needs_clarification: true` with
`clarifying_questions`. You present these questions to the user via the
questionnaire, then pass the answers back to the agent with the required context.
