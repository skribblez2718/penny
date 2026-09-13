# Penny

Penny is a personal AI assistant built on [Pi](https://github.com/earendil-works/pi). She can handle a task directly, ask one of ten general-purpose agents for focused help, or run a reusable multi-step skill. A core [MemPalace](https://github.com/milla-jovovich/mempalace) service provides memory across sessions while workflow checkpoints and exact artifacts remain independently durable.

<p align="center">
  <img src="img/penny.png" width="55%" style="border-radius: 12px" alt="Penny" />
</p>

## Table of Contents

- [Overview](#overview)
- [Requirements](#requirements)
- [Quick Start](#quick-start)
- [Agents and Skills](#agents-and-skills)
- [How Penny Works](#how-penny-works)
- [Progress and Limits](#progress-and-limits)
- [Memory and Observability](#memory-and-observability)
- [Development](#development)
- [TLS and Certificate Trust](#tls-and-certificate-trust)
- [Documentation](#documentation)

## Overview

Penny has three ways to do work:

- **Direct:** Penny handles the task in the current session.
- **Agent:** Penny gives one clearly defined job to an agent working in a separate session.
- **Skill:** Penny runs a tested sequence of steps that can save progress, retry a failed step, run work in parallel, and resume later.

Penny uses the simplest option that fits the task. Skill results pass directly between steps without relying on memory.

## Requirements

- **Pi 0.85.1:** the supported agent runtime. It must match the Pi SDK version pinned in this repository. See [Pi on GitHub](https://github.com/earendil-works/pi).
- **Node.js 22.19.0 or newer**
- **Python 3.12 or newer**
- **Bun 1.0 or newer:** JavaScript runtime and package manager
- **uv:** Python package manager. See [docs.astral.sh/uv](https://docs.astral.sh/uv).

## Quick Start

```bash
git clone https://github.com/skribblez2718/penny.git
cd penny
cp .env.example .env
# Edit .env and create a private hub config from
# scripts/setup/mempalace-hub.config.json.in, then start that supervised hub.
make setup STATE_MODE=fresh MEMORY_HUB_CONFIG=/absolute/private/hub.json
pi
```

MemPalace hub memory is enabled by default. The hub configuration, token, roots, and service remain caller-owned and outside the repository; setup validates them but never discovers, creates, migrates, repairs, or deletes a palace. Memory writes remain disabled until the separate canary and accepted-write reconciliation gates pass.

`STATE_MODE=fresh` is explicit authorization to initialize only a genuinely fresh canonical Penny state target. Existing installations use `STATE_MODE=existing` (the default). Missing, incomplete, incompatible, or retained state never falls through as successful setup; retained state uses the documented migration or recovery flow.

`make setup` performs frozen, offline dependency installs from local caches, builds orchestration and observability once, and exits zero only after state, artifacts, checkpoints, receipt authority, observability, authenticated memory, and provider-free extension loading pass the setup doctor. A missing cache entry is an error rather than permission to resolve or download a package. Setup does not install or update Pi, Node, Bun, Python, or uv.

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
| `diagnose`       | `skill`          | Assesses likely causes from supplied symptoms and evidence.                         |
| `plan`           | `skill`          | Produces a strategy for reaching a stated goal.                                     |
| `produce`        | `skill`          | Produces one reviewed text or code artifact from a complete brief.                  |

## How Penny Works

System rules define Penny's standing behavior and safety limits. Agent definitions set each agent's role and maximum tool access. Skills add step-specific instructions, while [`AGENTS.md`](AGENTS.md) files direct Penny to the project guidance relevant to the current task. The user's request supplies the goal and task-specific constraints.

Agents work in separate sessions. Their results receive exact artifact IDs so another agent or skill step can read the same saved bytes. Skills keep checkpoints in SQLite, which lets an interrupted run resume without reconstructing earlier work from memory.

Five on-demand protocols cover artifact access, clarification, compaction recovery, routing and delegation, and tool use. They are indexed in [`docs/penny/AGENTS.md`](docs/penny/AGENTS.md).

## Progress and Limits

Skills report when a step starts and when a worker finishes or fails. Separate limits on time, model responses, tool use, and external requests prevent a run from continuing forever. Failures and incomplete work are reported rather than presented as successful completion.

## Memory and Observability

MemPalace is a core, default-enabled service. Create a private hub configuration from `scripts/setup/mempalace-hub.config.json.in`, start it with your preferred service manager, and set the matching `PENNY_MEMORY_*` values described in `.env.example`. `make setup` requires `MEMORY_HUB_CONFIG=/absolute/private/hub.json` and verifies supervisor identity, liveness, and authenticated status. It never opens palace bytes directly. Memory writes remain disabled until the checks listed in `.env.example` pass.

An explicit `make setup MEMORY_MODE=disabled` remains available for degraded recovery or testing, but `.env` must also explicitly set `PENNY_MEMORY_MODE=disabled` and the result is labeled as a no-memory profile. Memory remains separate from workflow artifacts and checkpoints, so disabling it does not grant setup permission to alter either persistence plane.

Observability is enabled by default. Setup validates the canonical database and exercises the built service against disposable owner-only state on an ephemeral loopback port, including health and authentication behavior; it does not leave a background process running. Penny stores local diagnostic logs but does not copy conversation transcripts into its log database. Conversation history remains in Pi's local session files.

## Development

```bash
make doctor            # Read-only core readiness check (never initializes state)
make state-status      # Read-only canonical state and persistence check
make verify-runtime    # Rebuild, then check retained invocation state (no model calls)
make memory-status     # Read-only supervised/authenticated hub check
make setup-browser     # Explicitly provision optional Playwright Chromium
make setup-dev         # Install development/check dependency extras
make test              # Run default fast tests and repository guards
make test-integration  # Include heavier integration, network, slow, and end-to-end tests
make lint              # Run lint and formatting checks
make format            # Format supported files
make clean             # Remove code dependencies but preserve memory data
bun run pi:update      # Validate and update Pi safely
```

After orchestration changes, run `make verify-runtime` before declaring the installation ready for agent or skill calls. Run it when workflow workers and tests using the compiled runtime are stopped: the build replaces `dist`, and separate build processes are not serialized. It uses the shared frozen/offline build path, then checks the actual retained checkpoint, artifact, and receipt state against that build. It fails on missing or incompatible state without initializing, upgrading, or repairing it. A successful build or isolated test suite is not evidence that an existing installation's state is compatible. This check makes no model calls; provider execution and complete workflow behavior still need separately authorized live smoke tests.

For `STATE_SCHEMA_INCOMPATIBLE`, stop active workflow writers and follow the reported explicit `penny-state upgrade --project-root=PATH --backup-dir=PATH` recovery action with a caller-selected private backup directory outside both the project and state roots. Then rerun `make verify-runtime`. Do not reset retained state or change its version marker by hand to bypass the error.

Use `bun run pi:update` instead of running `pi update` directly from this repository. The updater checks the published Pi package in a clean temporary project, tests the candidate against Penny, and changes the global installation only when those checks pass. It does not add missing upstream dependencies or commit files.

Normal startup only compares the running Pi version with the version pinned in this repository. It does not install packages or contact a package registry. See the [environment extension guide](.pi/extensions/environment/README.md) for details.

## TLS and Certificate Trust

Most users can launch Penny with plain `pi`, as shown in Quick Start. If Penny connects to a service that uses a custom or internal certificate authority, set the required Node.js environment variable before starting Pi. Loading it later from `.env` will not work.

```bash
# Trust system certificate authorities
NODE_USE_SYSTEM_CA=1 pi

# Trust one additional certificate authority
NODE_EXTRA_CA_CERTS=/path/to/custom-ca.pem pi

# Disable certificate checks for development only; not recommended
NODE_TLS_REJECT_UNAUTHORIZED=0 pi
```

To keep one of these settings, export it from your shell profile such as `~/.bashrc` or `~/.zshrc`.

## Documentation

- The [documentation guide](docs/humans/documentation/overview.md) explains the human, agent, and protocol documentation areas.
- [`docs/agents/AGENTS.md`](docs/agents/AGENTS.md) routes maintainers to the technical instructions for changing Penny.
- [`docs/penny/AGENTS.md`](docs/penny/AGENTS.md) indexes Penny's on-demand operating protocols.
