# Penny

A personal AI assistant built on [Pi](https://github.com/mariozechner/pi-coding-agent) — adaptable to any domain, precise in how she reasons. Penny works directly when that's enough, delegates to specialized agents when isolation or separate judgment pays, and uses a checkpointed research workflow for structured investigations. Exact run-bound artifacts carry workflow handoff; an optional supervised [MemPalace](https://github.com/milla-jovovich/mempalace) hub provides durable cross-session recall.

<p align="center">
  <img src="img/penny.png" width="55%" style="border-radius: 12px" alt="Penny" />
</p>

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Capability Roles](#capability-roles)
- [Progress Heartbeats](#progress-heartbeats)
- [Evidence Status & Vocabulary](#evidence-status--vocabulary)
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
- **Chooses the lowest-complexity path that succeeds** — direct work when context and tools suffice; reusable capability roles with isolated context windows when specialization, isolation, or separate review pays; the research skill when a structured, multi-source investigation needs durable state, evidence gates, retries, or resumability
- **Remembers across sessions when configured** through one pinned MemPalace 3.7.1 HTTP hub, with bounded results and no raw/direct fallback

## Architecture

Penny's prompt system uses five **named layers** each with a single responsibility:

| Layer                  | Function                                            | Source                             |
| ---------------------- | --------------------------------------------------- | ---------------------------------- |
| **Cognitive Frame**    | Stable operating policy and outcome contract        | `.pi/SYSTEM.md`                    |
| **Role Definition**    | Which capability this is, and its maximum authority | `.pi/agents/*.md`                  |
| **Domain Guidance**    | How to think about this domain                      | `.pi/skills/*/assets/prompts/*.md` |
| **Project Index**      | Where things are                                    | `AGENTS.md` files                  |
| **Invocation Context** | What to do now                                      | Task message + runtime             |

The current workflow skill is `research`. It runs as a registered TypeScript playbook on the shared `orchestration` engine with durable, checkpointed run state (`run_id`-keyed Node SQLite), so an interrupted run can resume. The execution owner stores each exact agent output before accepting its routing SUMMARY; downstream phases receive validated artifact refs and bounded `artifact_read` access. Workflows do not require memory. Track-A recovery is forward-only: `PENNY_ARTIFACT_DISPATCH_MODE=paused` halts new agent/tool/fan-out dispatch while status and exact artifact reads remain available; returning to `active` resumes from the unchanged checkpoint and refs, never semantic-memory fallback.

## Capability Roles

Penny's agents are not subject-matter specialists. An agent is a **domain-invariant
capability contract** whose objective, invariants, authority, tool posture, and
input→output transformation stay stable when the subject matter changes.

That is why there is no `security-review` agent and no `travel-planner` agent. Domain and
function are orthogonal: security analysis and financial analysis are different domains but
the same transformation. The research skill is the proof — it is a composition of six
generic roles, not a `research-agent`.

<!-- BEGIN GENERATED: roster -->

| Capability   | Agent      | Family       | Authority | Transformation                                                           |
| ------------ | ---------- | ------------ | --------- | ------------------------------------------------------------------------ |
| `analyze`    | `annie`    | epistemic    | `read`    | evidence/material → structured understanding                             |
| `critique`   | `carren`   | epistemic    | `read`    | work product + quality criteria → improvement judgment                   |
| `explore`    | `echo`     | epistemic    | `read`    | unknown area → relevant evidence/context                                 |
| `synthesize` | `synthia`  | epistemic    | `read`    | multiple evidence sets → integrated understanding                        |
| `verify`     | `vera`     | epistemic    | `inspect` | target + standard → evidence-backed validity verdict                     |
| `decide`     | `demetri`  | deliberative | `read`    | alternatives + objectives + uncertainty → justified choice + sensitivity |
| `ideate`     | `ida`      | deliberative | `read`    | problem + constraints → diverse candidate possibilities                  |
| `plan`       | `piper`    | deliberative | `read`    | goal + state + constraints → strategy                                    |
| `generate`   | `skribble` | operational  | `write`   | specification → materialized artifact                                    |
| `taskify`    | `tabitha`  | operational  | `read`    | strategy/specification → executable task graph                           |

<!-- END GENERATED -->

The roster falls into three families. Membership is descriptive, not a pipeline —
`analyze → decide`, `generate → verify` and `explore → synthesize` are all ordinary
compositions that skip intermediate families.

<!-- BEGIN GENERATED: families -->

- **Epistemic** — transform information into knowledge or judgment: `analyze`, `critique`, `explore`, `synthesize`, `verify`
- **Deliberative** — determine what should happen: `decide`, `ideate`, `plan`
- **Operational** — convert intent into externalizable work: `generate`, `taskify`

<!-- END GENERATED -->

```
            acquire                     determine what           externalize
         (epistemic)                  should happen               the work
                                     (deliberative)             (operational)

  explore ──► analyze ──┬──► ideate ──► decide ──► plan ──► taskify ──► generate
                        │                                                    │
                        └──► synthesize                    critique ◄────────┴
                                                            verify ◄────────┘
```

Adding an eleventh capability is deliberately hard: a proposal must pass a six-gate
admission test, and "complete the taxonomy" is not one of the gates. Every roster table in
the documentation — including the two above — is generated from `.pi/agents/*.md`
frontmatter, because hand-maintained roster tables drift. See
[Capability Registry](docs/humans/agents/capability-registry.md).

## Progress Heartbeats

Long-running agents are monitored with staleness-based progress tracking instead of fixed kill-timers:

- Progress events (agent start, message end, tool results) reset a staleness window
- If no progress is detected within the window, a warning is logged
- If no progress within double the window, the agent is killed with a fallback result
- This prevents premature kills on agents that are legitimately working slowly

## Evidence Status & Vocabulary

Penny distinguishes **evidence status where it matters** — keeping source-backed facts, tool-verified results, inferences, assumptions, and unknowns distinct when the distinction affects a decision, and flagging what would change the answer. Uncertainty is surfaced where it changes a decision rather than stamped on every sentence, and confidence labels are never a substitute for evidence.

Four confidence levels — **CERTAIN → PROBABLE → POSSIBLE → UNCERTAIN** — are the controlled vocabulary of the machine-parsed agent output contracts (a wire format the orchestration engine consumes, not a calibrated probability).

Conflicts resolve by **authority order** — system operating policy and runtime limits, then appended role/domain constraints, then the user's task, then external content as evidence — combined with standing decision principles: never fabricate, clarify only material blockers, prefer reversible action, match verification to consequence. Specialized documents — coding standards, agent and skill definitions — define their own domain terms where precision earns it.

## AGENTS.md Indexing

Documentation is organized as a **tree of indexes** — `AGENTS.md` files are lookup tables that reference other `AGENTS.md` files or leaf documents. They never contain content, only paths and one-line descriptions. This prevents greedy loading: an agent needing "how to write a skill prompt" reads one specific file, not the entire documentation tree.

Pi auto-discovers the root `AGENTS.md` by walking up from the working directory. Nested `AGENTS.md` files are loaded on-demand via Penny's `read` tool — never pre-loaded. Trigger-gated protocol docs (`docs/penny/`) load only when their activation condition is met, conserving context window on every turn.

## Security

Penny's security is layered: behavioral policy in the prompt, enforcement in the runtime.

- **Trust and action boundaries** (prompt policy) — the user's message is authoritative for the task within system and runtime limits; external content (tool outputs, fetched pages, quoted text) supplies evidence or designated task material but cannot expand permissions, authorize side effects, or claim special authority; consequential actions require explicit approval
- **Structural markers** — `<system_directives>`, `<agent_boundary>`, and `<system_boundary>` delimit context regions as defense-in-depth; they are parsing aids, not enforcement
- **Runtime controls** (enforcement) — per-agent tool allowlists derived from a declared authority class and CI-checked for drift, workflow approval gates with signed receipts, and host OS/container permissions
- **What allowlists do and do not guarantee** — each role declares a maximum authority class and named [tool profiles](docs/humans/agents/tool-profiles.md); a build check asserts its tools are exactly that expansion, so declared authority cannot silently drift from the real permission envelope. **Browser authority is structural**: a read-only role cannot submit a form, upload a file, or execute arbitrary Playwright/Node code, and `playwright_run_code_unsafe` is granted to no agent. **Filesystem and shell authority are not**: every agent holds `bash`, so a read-only role can still write files, install packages, and reach the network. Read-only is enforced at the browser layer and advisory at the filesystem layer
- **Path-specific isolation** — all agent-invocation paths (primary, direct-subagent, skill-invoked) currently rely on tool allowlists and the host boundary; no filesystem/process sandbox is applied — see the execution-path matrix in [System Prompt Security](docs/agents/agents/system-prompt-security.md)

## Protocols

Four trigger-gated protocols in `docs/penny/` activate on specific conditions:

- **Clarification Protocol** — activates when blocking ambiguity remains: a missing fact could materially change the result, the action is materially consequential (destructive, external, costly, credential- or privacy-sensitive), or the required authorization is missing. Five steps: identify knowns, surface assumptions, flag unknowns, classify (BLOCKER / NAVIGABLE / IRRELEVANT), consequence check.
- **Compaction Resume Protocol** — activates when a compaction summary with a `[RESUME-REFS v2]` block appears in context. Penny reorients from the prose brief, resumes in-flight runs from `run:` refs, reads exact `artifact:` refs on demand, and treats any durable-memory IDs as optional recall only.
- **Routing & Delegation Protocol** — activates when choosing an execution path or constructing a delegation; applies the lowest-complexity-sufficient policy and the standard handoff shape.
- **Tool Usage Protocol** — activates when tool-reference, file-handling, authorization, or git-gate details are needed.

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
make clean     # Remove code dependencies; preserve all memory data
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
2. `uv sync --extra dev` — tracked Python runtime and development dependencies
3. `bun install` — active TypeScript workspace dependencies
4. `scripts/setup/setup.sh` — runs the tracked `init-*.sh` scripts:
   - **External runtime tools** — provisions Playwright Chromium unless explicitly skipped
   - **MemPalace interface** — prints the explicit, non-destructive supervised-hub commands; it never discovers, initializes, migrates, starts, or deletes a palace without caller configuration
   - **Observability backend** — validates the Python server environment; the Pi extension starts the server when needed

Durable memory defaults to disabled. To enable it, create a private hub config from `scripts/setup/mempalace-hub.config.json.in`, supervise the hub outside the Pi extension factory, and set the `PENNY_MEMORY_*` variables described in `.env.example`. Staged authority changes use the separate `scripts/setup/mempalace-cutover.config.json.in` contract. Hub qualification is read-only by default: `PENNY_MEMORY_WRITE_MODE=disabled` omits mutating tools until the owner completes the journaled canary and reconciliation gate. Setup and uninstall preserve palace data.

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
