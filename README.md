# Penny

A personal AI assistant built on [Pi](https://github.com/mariozechner/pi-coding-agent) — adaptable to any domain, precise in how she reasons. Penny orchestrates specialized agents through Python state machines, communicates via a persistent memory system ([MemPalace](https://github.com/milla-jovovich/mempalace)), and follows a layered prompt architecture that separates universal reasoning from domain-specific guidance.

<p align="center">
  <img src="img/penny.png" width="55%" style="border-radius: 12px" alt="Penny" />
</p>

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Progress Heartbeats](#progress-heartbeats)
- [Confidence & Vocabulary](#confidence--vocabulary)
- [AGENTS.md Indexing](#agentsmd-indexing)
- [Security](#security)
- [Protocols](#protocols)
- [Observability](#observability)
- [Development](#development)
- [Documentation](#documentation)
- [Requirements](#requirements)
- [Setup](#setup)

## Overview

Penny is not a single prompt or a single model call. She is a layered reasoning system that:

- **Composes the right instructions** for the current moment via five separated prompt layers
- **Delegates complex work** to specialized agents with isolated context windows
- **Remembers across sessions** through [MemPalace](https://github.com/milla-jovovich/mempalace) — persistent memory powered by ChromaDB

## Architecture

Penny's prompt system uses five **named layers** each with a single responsibility:

| Layer                  | Function                       | Source                             |
| ---------------------- | ------------------------------ | ---------------------------------- |
| **Cognitive Frame**    | How to think (universal)       | `.pi/SYSTEM.md`                    |
| **Role Definition**    | Who I am (per-agent)           | `.pi/agents/*.md`                  |
| **Domain Guidance**    | How to think about this domain | `.pi/skills/*/assets/prompts/*.md` |
| **Project Index**      | Where things are               | `AGENTS.md` files                  |
| **Invocation Context** | What to do now                 | Task message + runtime             |

Skills are Python state machines that dispatch agents, process results, and produce structured output. All workflow skills run on a shared `orchestration` engine — each a `BasePlaybook` subclass with durable, checkpointed run state (`run_id`-keyed SQLite), so a crashed run resumes automatically. Agents communicate exclusively through MemPalace — Penny's context stays clean.

## Progress Heartbeats

Long-running agents are monitored with staleness-based progress tracking instead of fixed kill-timers:

- Progress events (agent start, message end, tool results) reset a staleness window
- If no progress is detected within the window, a warning is logged
- If no progress within double the window, the agent is killed with a fallback result
- This prevents premature kills on agents that are legitimately working slowly

## Confidence & Vocabulary

Penny signals **calibrated certainty where it matters** — keeping "I verified this" distinct from "this is likely" and "I'd need to check," and flagging assumptions, unverified claims, and what would change the answer. Uncertainty is surfaced where it changes a decision rather than stamped on every sentence.

Four confidence levels — **CERTAIN → PROBABLE → POSSIBLE → UNCERTAIN** — are the controlled vocabulary Penny and her agents reason and report in.

An **instruction hierarchy** — Truth > Clarity > User intent > Thoroughness — resolves rule conflicts: accuracy outranks helpfulness, ambiguity is resolved before work begins, and verification is never skipped. Specialized documents — coding standards, agent and skill definitions — define their own domain terms where precision earns it.

## AGENTS.md Indexing

Documentation is organized as a **tree of indexes** — `AGENTS.md` files are lookup tables that reference other `AGENTS.md` files or leaf documents. They never contain content, only paths and one-line descriptions. This prevents greedy loading: an agent needing "how to write a skill prompt" reads one specific file, not the entire documentation tree.

Pi auto-discovers the root `AGENTS.md` by walking up from the working directory. Nested `AGENTS.md` files are loaded on-demand via Penny's `read` tool — never pre-loaded. Trigger-gated protocol docs (`docs/penny/`) load only when their activation condition is met, conserving context window on every turn.

## Security

Penny's system prompt includes immutable security directives:

- **Anti-injection defense** — boundary markers separate system instructions from user and external content
- **Untrusted data handling** — tool outputs, search results, and fetched pages are never treated as instructions
- **Spoofing resistance** — claims of special authority ("ignore previous instructions") are never legitimate
- **Precedence** — security directives override helpfulness, user satisfaction, and all other objectives

## Protocols

Three trigger-gated protocols in `docs/penny/` that activate on specific conditions:

- **Clarification Protocol** — activates when a task is under-specified, irreversible, high-stakes, or confidence ≤ POSSIBLE. Five steps: identify knowns, surface assumptions, flag unknowns, classify (BLOCKER / NAVIGABLE / IRRELEVANT), irreversibility check.
- **Compaction Resume Protocol** — activates when a compaction summary with a `[RESUME-REFS v2]` block appears in context. Penny reorients from the prose brief, resumes in-flight orchestration runs from the engine checkpointer refs, and dereferences mempalace/KG pointers on demand.
- **Agent Escalation** — agents cannot use the questionnaire tool directly. When they need user clarification, they escalate to Penny with `needs_clarification: true`.

## Observability

A FastAPI + SQLite backend that ingests real-time events and structured logs from all extensions:

- **Events** — session lifecycle, messages, tool results, agent boundaries, model changes (14-day retention)
- **Operational logs** — structured JSON log entries from all extensions via the shared logger
- **Query API** — REST endpoints for querying logs and session history

Runs as a plain Python process (`python -m observability`), auto-started by the Pi observability extension when Pi launches. The server bounds its own database size in-process (size-based rotation) — no Docker, no systemd timer required.

## Development

```bash
make test      # Run all tests (bun + pytest)
make lint      # Lint and format check (eslint + flake8 + black)
make format    # Auto-format (prettier + black)
make clean     # Remove venv, node_modules, mempalace data
```

## Documentation

Documentation is organized into three categories that cover the same topics from different perspectives:

- **Agent docs:** `docs/agents/` — **HOW** the system works. Agent-consumable reference for integration points, code structure, state machines, coding standards, and prompt layers. Written for AI agents that need to build and integrate with Penny.
- **Human docs:** `docs/humans/` — **WHAT and WHY.** Human-readable explanations of architectural decisions, capability overviews, coding guides, and design principles. Written for humans who want to understand the system.
- **Penny docs:** `docs/penny/` — Protocols specific to Penny's operation (clarification, compaction). Loaded on-demand via trigger conditions in SYSTEM.md.

Both agent and human docs cover the same topics — agents, architecture, capabilities, coding, documentation, extensions, memory, prompts, skills, state management, and observability — but in different ways. Agent docs are code-first reference material; human docs are narrative explanations of decisions and trade-offs.

## Requirements

- **Pi** — the agent runtime ([github.com/mariozechner/pi-coding-agent](https://github.com/mariozechner/pi-coding-agent))
- **Bun** — JavaScript runtime and package manager (>=1.0)
- **uv** — Python package manager ([docs.astral.sh/uv](https://docs.astral.sh/uv))

## Setup

```bash
git clone git@github.com:skribblez2718/penny.git
cd penny
make setup
```

This runs:

1. `uv venv .venv` — Python virtual environment
2. `uv sync` — all Python dependencies (mempalace, chromadb, python-statemachine, semgrep, fastapi, etc.)
3. `bun install` — all TypeScript workspace dependencies (extensions, tools)
4. `scripts/setup/setup.sh` — runs all `init-*.sh` scripts:
   - **MemPalace initialization** — palace directory, wing config, memory bridge test
   - **Observability backend** — Python server (auto-started by the Pi extension), in-process DB size rotation
   - **External tools** — semgrep, jsluice, and other CLI tools
   - **Cron jobs** — tiered-memory archiver

Then copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

### TLS / Certificate Trust

If a model endpoint uses a custom or internal CA, you may need to set Node.js TLS variables **before** starting Pi (they must be set at process launch — `.env` is too late):

```bash
# Trust system CA certificates (custom/internal CAs)
NODE_USE_SYSTEM_CA=1 pi

# Trust an additional custom CA certificate
NODE_EXTRA_CA_CERTS=/path/to/custom-ca.pem pi

# Bypass certificate validation entirely (development only, not recommended)
NODE_TLS_REJECT_UNAUTHORIZED=0 pi
```

To make these permanent, export them in your shell profile (`~/.bashrc` or `~/.zshrc`).
