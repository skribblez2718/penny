# Penny

A personal AI assistant built on [Pi](https://github.com/mariozechner/pi-coding-agent) — adaptable to any domain, precise in how she reasons. Penny orchestrates specialized agents through Python state machines, communicates via a persistent memory system ([MemPalace](https://github.com/milla-jovovich/mempalace)), and follows a layered prompt architecture that separates universal reasoning from domain-specific guidance.

<p align="center">
  <img src="img/penny.png" width="55%" style="border-radius: 12px" alt="Penny" />
</p>

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Self-Improvement Loop](#self-improvement-loop)
- [Prompt Efficacy](#prompt-efficacy--does-the-frame-pay-rent)
- [Ambient Watchers](#ambient-watchers)
- [Weekly Digest](#weekly-digest)
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
- **Learns from mistakes** via a self-improvement loop that detects patterns in failed predictions and proposes amendments
- **Surfaces problems proactively** through ambient watchers that run in the background
- **Reports accountability** through weekly digests that aggregate outcomes, signals, and trends

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

## Self-Improvement Loop

Penny learns from her own mistakes. The self-improvement loop runs automatically:

1. **Outcome Ledger** — Before consequential actions, Penny records predictions. Afterward, actual results are compared (MATCH / PARTIAL / MISMATCH) and stored in MemPalace.
2. **Compression Loop** — A daily cron job queries recent outcomes, identifies recurring MISMATCH patterns, classifies targets (domain guidance, preferences, config, or rejected universal), and generates structured amendments.
3. **Amendment Review** — Proposed amendments are stored as PENDING in MemPalace. A human or Penny reviews, approves, or rejects them.
4. **Amendment Application** — Approving the exact diff _is_ the human-in-the-loop, so an approved amendment is applied to its target file — any file, **including SYSTEM.md**. Two guardrails keep this safe: the diff must be concrete (empty diffs are refused at approve and apply), and the immutable security-directives block (`<system_directives>` / `<system_boundary>`) is never machine-editable, even with approval. The conservatism lives in what the loop _proposes_, not in what an approval may _touch_: the auto-generator only emits applicable diffs for Domain Guidance, preferences, and config, and a learning that would touch SYSTEM.md's Cognitive Frame is classified `REJECTED_UNIVERSAL` and logged for a human to author (its auto-generated target is a placeholder, never an applicable file). Once a human writes that SYSTEM.md diff, approving it applies like any other — the blast radius of an *unreviewed* universal edit is what stays off-limits, not universal edits as such.

This creates a feedback loop where prediction errors become actionable improvements to skill prompts and system configuration.

**Running it interactively** — The `/tune` prompt walks through the entire cycle in-conversation: rate recent unrated sessions (MATCH / PARTIAL / MISMATCH, with a failure category on misses), generate amendments from the clustered failures, review/approve/apply them (application is gated by the trajectory ratchet), then run evals and the trust dashboard. The user's judgment is authoritative on every rating and approval — Penny presents faithfully and records, never deciding a rating itself.

## Prompt Efficacy

Penny's core claim is that her universal Cognitive Frame (`.pi/SYSTEM.md`) makes models *measurably* better — not just differently-worded. That claim is A/B tested, never asserted. A curated golden task set (extraction, code reasoning, ambiguity-handling, fabrication-resistance, risk-surfacing, calibration, tradeoff-naming, synthesis) is replayed through headless Pi in **matched arms** — **frame-on** (SYSTEM.md) vs **frame-off** (a *bare model* — a *near-empty* system prompt with no instructions, deliberately *not* Pi's own default) — per model family, from a hermetic sandbox with sessions, tools, skills, and context files disabled so the system prompt is the *only* variable. Measuring against the bare model rather than Pi's pre-baked default means a positive delta shows the frame improved the *model itself*, not merely that it beat the platform's built-in prompt. Graders are **behavior-blind**: they score task **success** (right answer, right structure, right caution), never frame vocabulary — a grader that rewarded the word "assumptions" would measure compliance, not value.

The per-family **frame-on − frame-off** pass-rate delta feeds the regression ratchet (north star: *"the frame pays rent"*): overall gain has a hard floor at −2pp, and any family the frame measurably *hurts* — a deficit beyond a `max(5pp, 2/n)` noise margin — fires a CRITICAL degradation signal into the next session brief. The expensive matrix runs on demand (`make evals-prompt-efficacy`) or automatically via `/tune deep` when the artifact has gone stale **or been invalidated by a frame edit**; `make evals` and the nightly cron only *read* the artifact, so routine runs never make a model call.

Concretely, one task asks what version 3.2.1 of the `penny-sca-toolkit` PyPI package changed — a package that does not exist. Frame-off, the bare model *invents* a plausible changelog; frame-on, the same model answers that it can't verify any such release and refuses to guess. That single flip — confident hallucination → a calibrated "I cannot verify X" — is the whole system in miniature: **truth over helpfulness**, measured on the same model with the frame as the only change. The set exercises the same discipline across the other families too — surfacing a destructive `/dev/sdb` wipe as irreversible, catching *two* bugs where a bare model fixes one, and refusing to answer a nondeterministic program's "exact" output.

## Ambient Watchers

Background watchers that generate signals before you ask:

| Watcher              | What It Monitors                               | Signal Trigger                           |
| -------------------- | ---------------------------------------------- | ---------------------------------------- |
| **Mismatch Rate**    | Outcome ledger MISMATCH count                  | >N mismatches in 7 days                  |
| **Confidence Trend** | Confidence level distribution                  | >50% low-confidence (POSSIBLE/UNCERTAIN) |
| **Mempalace Growth** | Total drawer count in Penny wing               | >500 drawers                             |
| **Task Staleness**   | Decisions stuck in PARTIAL with no newer MATCH | Stale >7 days                            |

Watchers run via cron twice daily and on skill invocation. Signals are stored in MemPalace and surfaced at session start. The tiered memory archiver runs alongside the watchers to age out T2 scratch — per-skill retention is declared once in `scripts/system/tiered_memory/skill_rooms.json` (the single source of truth new skills register into) — while keeping curated T3 knowledge, cold-archiving each expired drawer to JSONL before deletion.

## Weekly Digest

Every Monday, a digest is generated and stored in MemPalace:

- **Outcome tallies** — MATCH / PARTIAL / MISMATCH counts with domain breakdowns
- **Confidence distribution** — CERTAIN / PROBABLE / POSSIBLE / UNCERTAIN
- **Attention flags** — 2+ MISMATCHes in the same domain, critical pending signals
- **Amendment summary** — proposed / approved / rejected / pending counts
- **Recommendations** — actionable items derived from the metrics

The digest is rendered to markdown, stored in MemPalace (`penny/digests`), and printed to stdout for cron capture.

## Progress Heartbeats

Long-running agents are monitored with staleness-based progress tracking instead of fixed kill-timers:

- Progress events (agent start, message end, tool results) reset a staleness window
- If no progress is detected within the window, a warning is logged
- If no progress within double the window, the agent is killed with a fallback result
- This prevents premature kills on agents that are legitimately working slowly

## Confidence & Vocabulary

Penny uses a **global canonical vocabulary** defined in SYSTEM.md — a set of precisely-defined terms that cannot be substituted. "Constraints" always means hard immutable limits, never "limitations" or "restrictions." This eliminates ambiguity across the entire system: agents, skills, documentation, and human communication all use the same language.

**Domain-specific vocabularies** extend this for specialized contexts — coding standards define their own terms, security docs define threat categories, and skill prompts define workflow-specific concepts. The global vocabulary provides the foundation; domain vocabularies build on it without conflicting.

Confidence levels (CERTAIN → PROBABLE → POSSIBLE → UNCERTAIN) are declared on every non-trivial claim, and an instruction hierarchy (Truth > Clarity > User intent > Thoroughness) resolves rule conflicts.

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
- **Compaction Resume Protocol** — activates when a compaction summary with a `[RESUME-REFS v2]` block appears in context. Penny reorients from the prose brief, resumes in-flight orchestration runs from the engine checkpointer refs, and dereferences mempalace/KG/outcome-ledger pointers on demand.
- **Agent Escalation** — agents cannot use the questionnaire tool directly. When they need user clarification, they escalate to Penny with `needs_clarification: true`.

## Observability

A FastAPI + SQLite backend that ingests real-time events and structured logs from all extensions:

- **Events** — session lifecycle, messages, tool results, agent boundaries, model changes (14-day retention)
- **Operational logs** — structured JSON log entries from all extensions via the shared logger
- **Watcher logs** — ambient watcher execution logs, kept logically separate for diagnostics
- **Query API** — REST endpoints for querying logs, session history, and watcher logs

Prefers Docker; falls back to Python if Docker is unavailable. A systemd timer handles daily database cleanup on Linux.

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
- **Docker** (recommended) — for the observability backend. Falls back to Python if unavailable.

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
   - **Observability backend** — Docker build or Python fallback, systemd cleanup timer
   - **External tools** — semgrep, jsluice, and other CLI tools
   - **Cron jobs** — ambient watchers (twice daily), self-improvement compression (daily), weekly digest (Mondays)

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
