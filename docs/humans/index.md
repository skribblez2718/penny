# Penny Documentation

This is the starting point for Penny's human-facing documentation. Use the reading paths below for an introduction, or go directly to a subject area.

## Start here

- **Understand the system:** read the [architecture overview](architecture/overview.md), then [agents](agents/overview.md) and [skills](skills/overview.md).
- **Operate or extend Penny:** read the [documentation system](documentation/overview.md), [project standards](architecture/project-standards.md), and the relevant coding or extension guide.
- **Understand trust and continuity:** read [agent security](agents/system-prompt-security.md), [memory integration](memory/integration.md), and [state management](state-management/state-management.md).
- **Look up terminology:** use the [glossary](glossary.md).

## Subject areas

| Area                                                          | What it explains                                                                      |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| [Architecture](architecture/index.md)                         | Components, boundaries, host operations, artifacts, and design principles.            |
| [Agents](agents/overview.md)                                  | Capability roles, discovery, invocation, tools, models, and prompt security.          |
| [Capabilities](capabilities/index.md)                         | User-visible capabilities and their current status.                                   |
| [Skills](skills/index.md)                                     | Reusable workflows, orchestration, gates, testing, and design.                        |
| [Prompts](prompts/overview.md)                                | Prompt layers, assembly, evidence handling, and security.                             |
| [State management](state-management/state-management.md)      | Checkpoints, state machines, recovery, and resumability.                              |
| [Memory](memory/integration.md)                               | Durable recall, knowledge graphs, and the boundary between memory and workflow state. |
| [Extensions](extensions/quick-reference.md)                   | Extension structure, dependencies, testing, and quality controls.                     |
| [Coding](coding/conventions.md)                               | Project conventions for TypeScript, Python, security, accessibility, and deployment.  |
| [Documentation](documentation/overview.md)                    | The human, agent, and trigger-gated documentation areas.                              |
| [Writing](writing/overview.md)                                | Human-centered writing and genre guidance.                                            |
| [Observability](observability-server/observability-server.md) | Operational logs, health information, and conversation-history boundaries.            |

## Maintainer references

Human-facing pages explain what Penny is and why it works this way. Exact implementation rules live in the agent-facing index at [`docs/agents/AGENTS.md`](../agents/AGENTS.md). Trigger-gated operating protocols live at [`docs/penny/AGENTS.md`](../penny/AGENTS.md).
