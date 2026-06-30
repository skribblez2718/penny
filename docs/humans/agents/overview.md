# Agents

## What It Is

Agents are specialized reasoning subprocesses that Penny can call on when a task benefits from a dedicated perspective. Each agent is a separate Pi process with its own context window, role definition, and tool set. They are not full assistants in their own right; they are narrow experts that investigate, plan, critique, write, validate, or synthesize on Penny's behalf.

Think of Penny as the conductor and agents as the section leads. Penny decides what needs to happen and which specialist should do it. The agent does the focused work, stores its full results in mempalace, and returns only a compact structured summary to Penny.

## Why It Matters

Agents solve two problems at once: **domain focus** and **context conservation**.

Without agents, every investigation, plan, critique, and code draft would happen inside Penny's single context window. Complex tasks would balloon until earlier parts of the conversation were pushed out of memory. Worse, the same context would need to hold contradictory roles simultaneously — the part of Penny drafting code is not the same part that should be critiquing it.

By spinning up a subprocess, Penny offloads the detailed work. The agent gets a fresh context loaded with exactly the role and domain guidance it needs. Its complete output is written to mempalace, but Penny only sees the summary. This keeps Penny's window free for orchestration, user interaction, and the big picture.

## The Agent Roster

| Agent | Specialty | Core Role |
| ----- | --------- | --------- |
| **echo** | Context gathering | Investigates a situation read-only, collecting facts before anyone acts. |
| **piper** | Planning | Builds execution plans from goals and constraints. Domain-agnostic. |
| **carren** | Critique | Reviews work against standards. Read-only; never rewrites. |
| **tabitha** | Task decomposition | Turns plans into atomic, independently completable tasks. |
| **skribble** | Scaffolding | Writes files from detailed specifications. Spec-driven only. |
| **vera** | Validation | Asserts whether output complies with rules and requirements. |
| **synthia** | Synthesis | Reads scattered findings and produces a unified summary. |
| **annie** | Deep analysis | Performs thorough, domain-specific analysis when breadth is needed. |

Each role is deliberately general. There is no `echo-frontend` or `carren-security`. The same agent works across many domains because domain-specific guidance is injected by the skill or task that invokes it, not baked into the agent's identity.

## How Delegation Works

1. **Penny routes.** Based on the current goal, Penny decides which agent (if any) should handle the next step.
2. **The agent executes.** Pi spawns a subprocess with the agent's role definition and any skill-specific guidance.
3. **Results land in mempalace.** The agent writes its complete output there.
4. **Penny receives a summary.** A small structured SUMMARY tells Penny what happened and where to find the details.

This separation means Penny never needs to ingest a full agent report into her own context. She gets just enough information to continue orchestrating.

## Three-Tier Routing

Penny chooses from three levels of delegation depending on the task:

| Tier | When Penny Uses It | What It Looks Like |
| ---- | ------------------- | ------------------ |
| **Direct** | A single tool call is enough and the result is trivial to verify. | Penny calls `read`, `grep`, or `write` herself. |
| **Agent** | The task needs a distinct role or more than one reasoning step, but fits one domain. | Penny calls `subagent({ agent, task })`. |
| **Skill** | The work is a multi-step workflow that coordinates several agents and tools. | Penny calls `skill({ skill_name, goal })`. |

Direct is the lightest path. Agent adds role specialization. Skill adds state-machine orchestration. Penny defaults to the simplest tier that can reliably complete the work.

## Why No Domain-Specific Agent Variants?

You might expect a separate agent for every kind of work — one for code review, one for architecture, one for documentation. We deliberately avoid that. Domain-specific checklists, CREST tables, and output formats live in a skill's `assets/prompts/` files and are injected as Domain Guidance when the skill runs. This keeps the roster small, makes agents reusable across skills, and preserves the context-saving benefit of delegation.

## Learn More

- [Agent Definition Format](definition-format.md): What agent files look like and why.
- [Discovery and Tools](discovery-and-tools.md): How Pi finds agents and what tools they get.
- [Invocation](invocation.md): How agents are spawned and how skill context is injected.
- [System Prompt Security](system-prompt-security.md): How boundary markers keep agent instructions safe.
- Agent-facing reference: [Agent Overview](../../agents/agents/overview.md)
