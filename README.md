# Penny

Penny is a personal AI assistant built on [Pi](https://github.com/earendil-works/pi). She can handle a task directly, send focused work to a catalog agent, or run a reusable multi-step skill. [MemPalace](https://github.com/milla-jovovich/mempalace) supports durable recall across sessions, while workflow checkpoints and exact artifacts remain separate. Start with the [human documentation hub](docs/humans/index.md) or the [glossary](docs/humans/glossary.md).

<p align="center">
  <img src="img/penny.png" width="55%" style="border-radius: 12px" alt="Penny" />
</p>

## Table of Contents

- [Overview](#overview)
- [Agents and Skills](#agents-and-skills)
- [Architecture at a Glance](#architecture-at-a-glance)
- [Progress and Limits](#progress-and-limits)
- [Memory and Observability](#memory-and-observability)
- [Documentation](#documentation)

## Overview

Penny has three ways to do work:

- **Direct:** Penny handles the task in the current session.
- **Agent:** Penny gives one clearly defined job to an agent working in a separate session.
- **Skill:** Penny runs a tested sequence of steps that can save progress, retry a failed step, run work in parallel, and resume later.

Penny uses the simplest option that fits the task. Skill results pass directly between steps without relying on memory.

## Agents and Skills

### Agents

Agents are named for the kind of work they do, not for a subject area. The same agent can work on software, finance, travel, security, or another topic.

| Agent      | Use it to                                                                      |
| ---------- | ------------------------------------------------------------------------------ |
| `annie`    | Analyze supplied material and explain its structure, relationships, or causes. |
| `carren`   | Review the quality of a work product and explain how it should improve.        |
| `demetri`  | Choose or rank known options using stated goals, limits, and uncertainties.    |
| `echo`     | Explore an unfamiliar topic, codebase, document set, or external source.       |
| `ida`      | Generate a varied set of ideas, options, or hypotheses.                        |
| `piper`    | Plan how to move from the current state to a goal.                             |
| `rhea`     | Turn a bounded brief and admitted evidence into a complete specification.      |
| `skribble` | Create files or other requested work products from a clear specification.      |
| `synthia`  | Combine several sources or findings into one clear account.                    |
| `tabitha`  | Turn an approved plan or specification into dependency-ordered tasks.          |
| `vera`     | Check whether something meets a stated standard and explain why.               |

See the [Capability Registry](docs/humans/agents/capability-registry.md) for full descriptions and the process for adding an agent.

### Skills

Skills are reusable multi-step jobs that work across subject areas. Most use the agents above. Knowledge Base runs through its own `knowledge_base` tool.

| Package          | Tool             | What it does                                                                        |
| ---------------- | ---------------- | ----------------------------------------------------------------------------------- |
| `research`       | `skill`          | Runs Quick, Standard, or Deep research using external sources.                      |
| `knowledge-base` | `knowledge_base` | Manages a private knowledge base under host-controlled access.                      |
| `assess`         | `skill`          | Assesses submitted work against supplied criteria and evidence.                     |
| `decide`         | `skill`          | Selects or ranks supplied options, or reports that no sound choice can yet be made. |
| `define`         | `skill`          | Creates or fully revises a planning-ready cross-domain specification.               |
| `diagnose`       | `skill`          | Assesses likely causes from supplied symptoms and evidence.                         |
| `plan`           | `skill`          | Produces a strategy, with exact specification traceability when supplied.           |
| `produce`        | `skill`          | Produces one reviewed text or code artifact from a complete brief.                  |
| `sca`            | `skill`          | Runs scanner/graph-led security analysis and independently reviewed reporting.      |

## Architecture at a Glance

Penny chooses the least-complex path expected to succeed:

| Path                    | What happens                                                                                                                    | Best fit                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| **Direct**              | The primary Penny session uses its current context and tools.                                                                   | The task is clear and does not need separate context or durable workflow. |
| **Catalog agent**       | A named capability role runs in a fresh session. An ordinary catalog invocation receives exactly the role's YAML `tools:` list. | Focused analysis, generation, parallel exploration, or separate review.   |
| **Engine-backed skill** | A registered playbook coordinates stages, exact handoffs, checkpoints, retries, gates, and resume behavior.                     | An established workflow needs durable control state or recovery.          |

Tool profiles describe and lint a catalog role's declared tool surface; they are not a sandbox. Penny provides no filesystem, path, or process isolation. Primary and worker processes run within the invoking host's permissions, so an operator must supply an external container or VM when isolation is required. See [agent security](docs/humans/agents/system-prompt-security.md).

### Five conceptual prompt layers

| Layer                  | Practical purpose                                                             |
| ---------------------- | ----------------------------------------------------------------------------- |
| **Cognitive Frame**    | Stable operating policy, trust boundaries, and completion discipline.         |
| **Role Definition**    | A catalog agent's capability role and declared tool surface.                  |
| **Domain Guidance**    | Static task-family criteria and the expected output contract.                 |
| **Project Index**      | Typed `AGENTS.md` routes to the guidance relevant to the task.                |
| **Invocation Context** | The current goal, constraints, exact artifact IDs, and caller-supplied paths. |

`AGENTS.md` files route readers and runtimes to applicable guidance; they do not grant tools or permissions. Prompt markers are parsing aids, not enforcement: `<system_boundary>` ends system-role content before the separate user-role task. Enforcement comes from the actual tool surface, approval and receipt checks, artifact validation, and host OS or container boundaries. See the [prompt architecture overview](docs/humans/prompts/overview.md).

### Three continuity planes

| Plane                    | What it preserves                                                                                                        |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| **Exact artifacts**      | Immutable output bytes addressed by exact ID for handoff, evidence, and later reads.                                     |
| **Workflow checkpoints** | Compact control state and selected artifact references so a playbook can resume without guessing.                        |
| **Durable memory**       | Optional, curated cross-session recall. It is advisory and never substitutes for required artifacts or checkpoint state. |

Agents work in separate sessions, but exact artifacts—not memory or a name-only pointer—carry required work between them. Skills recover from checkpoints that retain artifact references rather than payload copies. See [skills](docs/humans/skills/overview.md), [state management](docs/humans/state-management/state-management.md), and [memory](docs/humans/memory/integration.md).

Special operating protocols for artifact access, clarification, compaction recovery, routing, and tool use are indexed in [`docs/penny/AGENTS.md`](docs/penny/AGENTS.md).

## Progress and Limits

Skills report when a step starts and when a worker finishes or fails. Separate limits on time, model responses, tool use, and external requests prevent a run from continuing forever. Failures and incomplete work are reported rather than presented as successful completion.

## Memory and Observability

Memory gives Penny selective continuity across sessions. MemPalace holds curated reusable knowledge, preferences, diary continuity, and temporal relationships. The primary Penny session controls durable writes, while workers can use bounded read-only recall when it is relevant. Memory remains advisory: it cannot replace an exact workflow artifact, determine checkpoint state, or turn an old claim into a currently verified fact.

Observability explains how the system behaved. Structured health, component, progress, and failure records support diagnosis and operational review without becoming workflow authority. Penny's observability database does not copy conversation transcripts; conversation history remains in Pi's session files and is read through the dedicated history surface when needed.

Together, these capabilities keep long-term context and operational evidence available without mixing them with the exact artifacts and checkpoints that control active work. See [memory integration](docs/humans/memory/integration.md) and the [observability service](docs/humans/observability-server/observability-server.md).

## Documentation

- The [human documentation hub](docs/humans/index.md) provides reading paths and routes to every human-facing domain.
- The [glossary](docs/humans/glossary.md) defines Penny's runtime, workflow, persistence, and evidence terms.
- The [documentation guide](docs/humans/documentation/overview.md) explains the human, agent, and protocol documentation areas.
- [`docs/agents/AGENTS.md`](docs/agents/AGENTS.md) routes maintainers to the technical instructions for changing Penny.
- [`docs/penny/AGENTS.md`](docs/penny/AGENTS.md) indexes Penny's on-demand operating protocols.
