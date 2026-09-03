# Penny

Penny is a personal AI assistant built on [Pi](https://github.com/mariozechner/pi-coding-agent). She can handle a task herself, ask one of ten general-purpose agents for focused help, or run a saved multi-step skill. An optional [MemPalace](https://github.com/milla-jovovich/mempalace) service provides memory across sessions.

<p align="center">
  <img src="img/penny.png" width="55%" style="border-radius: 12px" alt="Penny" />
</p>

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Universal Agents](#universal-agents)
- [Universal Skills](#universal-skills)
- [Progress and Limits](#progress-and-limits)
- [AGENTS.md Routing](#agentsmd-routing)
- [Security](#security)
- [Protocols](#protocols)
- [Observability](#observability)
- [Development](#development)
- [Documentation](#documentation)
- [Requirements](#requirements)
- [Setup](#setup)

## Overview

Penny has three ways to do work:

- **Direct:** Penny handles the task in the current session.
- **Agent:** Penny gives one clearly defined job to another agent working in a separate session.
- **Skill:** Penny runs a tested sequence of steps that can save progress, retry a failed step, run work in parallel, and resume later.

Penny uses the simplest option that fits the task. Memory is optional; a skill passes each saved result directly to the next step.

## Architecture

Instructions come from up to five places:

| Part               | What it contains                                           | Source                             |
| ------------------ | ---------------------------------------------------------- | ---------------------------------- |
| System rules       | Penny's standing rules and safety limits                   | `.pi/SYSTEM.md`                    |
| Agent role         | One agent's job and maximum tool access                    | `.pi/agents/*.md`                  |
| Skill instructions | The rules and output format for one skill step             | `.pi/skills/*/assets/prompts/*.md` |
| Project map        | Directions to the documents needed for the task            | `AGENTS.md` files                  |
| Task details       | The current goal, limits, file paths, and saved output IDs | Task message and runtime           |

All seven skills are fully implemented and available. Research and Knowledge Base are registered as production releases. The other five are registered as release candidates. A release candidate is not experimental or unfinished; it simply has not been moved into the production registry.

The skill system saves progress in SQLite. It stores each agent result under a unique ID and passes that saved result to the next step. An interrupted run can continue from its saved results.

## Universal Agents

Penny's ten agents are named for the kind of work they do, not for a subject area. The same agent can work on software, finance, travel, security, or any other topic.

| Agent      | Use it to                                                                              |
| ---------- | -------------------------------------------------------------------------------------- |
| `annie`    | Analyze material already provided and explain its structure, relationships, or causes. |
| `carren`   | Review the quality of a work product and explain how it should improve.                |
| `demetri`  | Choose or rank known options using the stated goals, limits, and uncertainties.        |
| `echo`     | Explore an unfamiliar topic, codebase, document set, or external source.               |
| `ida`      | Generate a varied set of ideas, options, or hypotheses.                                |
| `piper`    | Plan how to move from the current state to a goal.                                     |
| `skribble` | Create files or other requested work products from a clear specification.              |
| `synthia`  | Combine several sources or findings into one clear account.                            |
| `tabitha`  | Turn an approved plan or specification into tasks ordered by what must happen first.   |
| `vera`     | Check whether something meets a stated standard and explain why.                       |

There are no separate `security-review` or `travel-planner` agents. Those are subjects, not kinds of work. For example, Annie can analyze either a security design or a travel plan.

See [Capability Registry](docs/humans/agents/capability-registry.md) for the full descriptions and the rules for adding another agent.

## Universal Skills

Skills are reusable multi-step jobs that work in any subject area. Most use the agents above. Knowledge Base runs through its own `knowledge_base` tool.

The repository contains seven fully implemented skill packages:

| Package          | Release status and tool           | What it does                                                                        |
| ---------------- | --------------------------------- | ----------------------------------------------------------------------------------- |
| `research`       | **Production** — `skill`          | Runs Quick, Standard, or Deep research using external sources.                      |
| `knowledge-base` | **Production** — `knowledge_base` | Manages a private knowledge base. The host system controls access.                  |
| `assess`         | **Release candidate** — `skill`   | Grades submitted work using the provided rules and supporting information.          |
| `decide`         | **Release candidate** — `skill`   | Selects or ranks supplied options, or reports that no sound choice can yet be made. |
| `diagnose`       | **Release candidate** — `skill`   | Suggests likely causes from the information provided.                               |
| `plan`           | **Release candidate** — `skill`   | Produces a strategy for reaching a stated goal.                                     |
| `produce`        | **Release candidate** — `skill`   | Produces one reviewed piece of text from a complete set of instructions.            |

All seven appear in Pi's skill list and are available for use. Research and Knowledge Base are the two production releases. The other five are release candidates, which is a release label rather than a statement about completeness. Before a candidate run, a local configuration file must name the package and match its current checksum. Evaluations use a separate route. Running or testing a candidate does not change its release status.

## Progress and Limits

Skills report when a step starts and when a worker finishes or fails. Separate limits on time, model responses, tool use, and outside requests prevent a run from continuing forever.

## AGENTS.md Routing

`AGENTS.md` files are maps to documentation, not documentation dumps.

The root `AGENTS.md` is the only exception. It may contain short repository-wide rules plus links to the next set of indexes. Every nested `AGENTS.md` has one entry for each Markdown file or child index directly below it.

Each entry starts with one of three instructions:

- **`MUST READ FOR <scope>`** — always read this before work in that area.
- **`READ WHEN <trigger>`** — read this when the task includes the named feature or action.
- **`CONSULT WHEN <question>`** — use this only when that question still needs an answer.

After the dash, the entry says what the linked document provides. It is not a general description of the folder or file.

The checker verifies the index structure and these three prefixes. Pi loads the root index automatically. Penny follows nested links only when they apply to the current task, so it does not load unrelated documentation.

## Security

Penny combines written rules with runtime checks:

- The user chooses the task, but system rules and actual tool permissions still apply.
- Text from a file, webpage, or tool result cannot grant new permissions or approve an outside action.
- Each agent has a fixed set of tools. A skill step may use fewer tools, but text in the task cannot add more.
- Browser tool lists limit which commands an agent can use, but that does not make every click or key press harmless.
- Filesystem and shell labels are not an operating-system sandbox. An agent with `bash` may still write files or reach the network.
- Sensitive actions require approval and must pass checks enforced by the computer running Penny.

See [System Prompt Security](docs/agents/agents/system-prompt-security.md) for technical details and limitations.

## Protocols

Penny loads five operating guides only when they are needed:

- **Artifact Access** — reading a saved agent result by its exact artifact ID.
- **Clarification** — asking the user when missing information would materially change the work.
- **Compaction Resume** — continuing work after conversation history has been compacted.
- **Routing and Delegation** — choosing between direct work, an agent, and a skill.
- **Tool Usage** — handling files, approvals, and Git safely.

## Observability

Penny stores local diagnostic logs but does not copy conversation transcripts into its log database. Conversation history remains in Pi's local session files and is available even when logging is turned off.

## Development

```bash
make test          # Run all Bun and Python tests
make lint          # Run ESLint, Flake8, and formatting checks
make format        # Format supported files
make clean         # Remove code dependencies but preserve memory data
bun run pi:update  # Check and update Pi safely
```

### Updating Pi

Use `bun run pi:update` instead of running `pi update` directly from this repository. The command finds the latest Pi release, tests it against Penny, and updates the global Pi installation only if those checks pass. It does not commit files.

At normal startup, Penny only compares the running Pi version with the version pinned in this repository. Startup does not install packages or contact a registry.

## Documentation

Documentation has three audiences:

- **`docs/agents/`** — technical instructions used while changing Penny.
- **`docs/humans/`** — explanations of what Penny does and why it was designed that way.
- **`docs/penny/`** — Penny's five operating protocols.

The agent and human documentation cover many of the same topics, but one is a working reference and the other is an explanation.

## Requirements

- **Pi 0.84.4** — the currently supported agent runtime ([github.com/mariozechner/pi-coding-agent](https://github.com/mariozechner/pi-coding-agent)); it must match the Pi SDK version pinned in this repository
- **Bun** — JavaScript runtime and package manager (1.0 or newer)
- **uv** — Python package manager ([docs.astral.sh/uv](https://docs.astral.sh/uv))

## Setup

```bash
git clone git@github.com:skribblez2718/penny.git
cd penny
make setup
```

Setup creates the Python environment, installs the Python and TypeScript dependencies, attempts to install Playwright Chromium, and builds the orchestration and logging services. Penny's saved state is not initialized unless `PENNY_SETUP_INITIALIZE_STATE=1` is set. Existing state must use the separate migration process.

Setup also prints instructions for connecting an optional MemPalace service but does not manage that service. Memory is off by default. To enable it, create a private hub configuration from `scripts/setup/mempalace-hub.config.json.in`, start the hub with your preferred service manager, and set the `PENNY_MEMORY_*` variables listed in `.env.example`. Memory writes remain off until you complete the checks listed there.

Copy the environment template and fill in the values you need:

```bash
cp .env.example .env
```

### TLS and Certificate Trust

If Penny connects to a service that uses a custom or internal certificate authority, set the required Node.js environment variable before starting Pi. Loading it later from `.env` will not work.

```bash
# Trust system certificate authorities
NODE_USE_SYSTEM_CA=1 pi

# Trust one additional certificate authority
NODE_EXTRA_CA_CERTS=/path/to/custom-ca.pem pi

# Disable certificate checks (development only; not recommended)
NODE_TLS_REJECT_UNAUTHORIZED=0 pi
```

To keep one of these settings, export it from your shell profile such as `~/.bashrc` or `~/.zshrc`.
