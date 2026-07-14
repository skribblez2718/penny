# Penny Custom Compaction Extension

Enhances Pi's default compaction into a **resumability checkpoint**: when the session compacts, Penny must resume with no work lost. The design is **model-owned prose, code-owned pointers**.

The summary spliced into context has two parts:

1. **A model-written prose brief** — the session model reads the ACTUAL evicted conversation (the same leverage mechanism Pi's default uses, so it improves as models improve) and writes the brief under a fixed section contract: goal, active skill, current work, in-flight orchestration runs, pending, next steps, key decisions, unresolved errors, critical context. It is given the previous brief (iterative context) and a **session-scoped grounded-state digest** (real run/room/decision ids it may cite but never invent). Penny re-orients by reading.
2. **A `[RESUME-REFS v2]` appendix** — built **deterministically by code**, never the model: real, dereferenceable addresses — `run_id` + engine state with a concrete `resume=skill(...)` call, mempalace room/drawer IDs, outcome-ledger decision IDs, KG entities, verbatim tool-call examples. Anything the token budget couldn't carry is recoverable through these pointers instead of being lost.

When no summarization model is reachable, a **tagged LOAN fallback** (`compaction_deterministic_summary`) assembles the prose deterministically instead; when that loan is ablated too, the extension yields to Pi's default. It never abandons the summary silently.

Penny's consumer-side instructions live in `docs/penny/compaction-protocol.md` (triggered from `.pi/SYSTEM.md`). The section names and the `[RESUME-REFS v2]` block are unchanged, so the consumer needs no changes.

## Session Scoping (why old context stopped leaking)

Grounded state is scoped to THIS conversation's work: the session ids named by `skill` tool results in the window **plus** ids carried in prior compaction refs. Pending engine runs, mempalace rooms, outcome-ledger decisions, and KG entities are all filtered to that scope. A wedged run or a decision from a **different, older session** (checkpointer rows persist indefinitely) is therefore never treated as the current goal/work — it surfaces only under an explicit `other pending runs (other sessions — verify before resuming)` label in the refs. This is what fixed the "compaction produced context from a previous session" symptom.

## Goal Recency (schema 2.3.0)

On the **model path**, `## Goal` is the model's judgment over the real conversation, constrained to the user's LATEST substantive intent — a stale run/skill goal cannot override a fresh pivot. `artifact.goal` is kept in sync by parsing the model's own `## Goal`.

The **deterministic LOAN fallback** picks the goal by a precedence that puts recency ahead of stale durable state — no reason-keyed code forks, no keyword denylists:

1. **Incomplete active skill** goal (genuinely current work).
2. **Newest substantive user message** in the merged `[messagesToSummarize, …turnPrefixMessages]` window (recency beats stale durable state).
3. **Scoped engine-run** goal (checkpointer).
4. **previousSummary carry-forward** — the prior `## Goal`, used only when the window has nothing fresher. It never overrides a fresh user pivot.
5. **System** message, then a default.

Supersession: a **completed** skill whose goal is displaced by a later ad-hoc user message is flagged `dominant_skill.superseded = true` — it stays under `## Active Skill` but no longer sets `## Goal`.

- **Goal-stagnation canary (observational)** — logs (never mutates) when the goal is byte-identical across ≥3 consecutive compactions, tracked via an invisible marker carried in the summary. A long single-task session that legitimately keeps one goal is unaffected.

## Sources of Truth

| Data                | Source                                                                                                                                     | Never                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| In-flight run state | The orchestration engine's durable run_id checkpointer (`.penny/orchestration.db`, or `PENNY_ORCH_DB`), read read-only via the venv Python | Reconstructed from mempalace drawer text                                |
| What agents wrote   | Mempalace room/drawer **pointers** via `memory_bridge.py`, scoped to real session IDs (skill results + checkpointer rows)                  | Regex-inferred agent/phase/completion state                             |
| Decisions           | Outcome-ledger drawers (real drawer IDs as `decision_id` when available)                                                                   | —                                                                       |
| Session IDs         | Skill tool results and checkpointer rows only                                                                                              | Fabricated (`skill-${Date.now()}`) — a fake ID silently matches nothing |

## Failure Policy: Degrade, Never Abandon

- **Summarization path**: model prose first; on any model failure (no model/auth, timeout, abort, empty output) → the deterministic LOAN fallback; when that loan is ablated too → yield to Pi's default (`COMPACTION_YIELDED_TO_DEFAULT`). The summary is never silently dropped.
- **Budget overflow** (> 6k tokens): cardinality caps tighten progressively (halving scale, floor of 1 item per field) and the summary is rebuilt until it fits (this trims the code-owned refs; on the model path the prose is truncated only as a last resort). Absolute last resort is tail truncation with a visible marker.
- **Validation failure**: logged loudly (`COMPACTION_VALIDATION_FAILED`), but the summary is still emitted and the artifact still archived.
- **Bridge/checkpointer failures**: each query degrades to empty independently; the artifact builds from whatever succeeded.

## Architecture

```
Pi detects threshold
    │
    ▼
session_before_compact event
    │
    ▼
compactionExtension handler
    ├──► computeScopedSessionIds (skill-result ids ∪ prior-refs ids) — the scope
    ├──► queryEngineRuns (all pending) → partitionRunsByScope (scoped vs other-session)
    ├──► in parallel, ALL scoped: detectPendingState · mempalace rooms · KG entities
    │                 · outcome-ledger decisions
    ├──► buildArtifact (zod-validated PennyCompactArtifact 2.3.0) + grounded digest
    ├──► generateModelSummary (model reads the evicted conversation + prev brief + digest)
    │        └─ null → deterministic LOAN fallback → (ablated) yield to Pi default
    ├──► assemble = prose brief + code-built [RESUME-REFS v2]
    ├──► applyEviction + degrade loop until summary ≤ 6k tokens
    ├──► POST full artifact (incl. prose_summary, summary_source) → observability archive
    └──► return summary (spliced into context by Pi)
```

The full structured artifact (schema 2.1.0, `schema.ts`) goes to the observability archive; the model context gets the prose + refs.

**2.1.0 is additive over 2.0.0** — every new field is optional, so a 2.0.0-shaped artifact still validates unchanged. New fields: `dominant_skill.superseded`, top-level `current_work` / `next_steps`, `metadata.pi_boundary.boundary_shift` (now populated on every compaction after a session's first, sourced from `branchEntries`' prior `firstKeptEntryId`), `metadata.compaction_reason` / `metadata.custom_instructions` (the named sink for `event.reason` / `event.customInstructions`), and `metadata.goal_streak` (canary).

## Files

- `index.ts` — hook handler, session scoping, extraction, eviction, refs builder + deterministic fallback prose (pure helpers exported for tests)
- `summarizer.ts` — the model path: grounded-state digest, prompt assembly, and the `complete()` call behind a mockable dynamic-import seam
- `loans.ts` — TypeScript LOAN registry + Ablate hooks (mirrors the engine's `loans.py`)
- `bridge.ts` — memory-bridge client, engine-checkpointer reader (`queryEngineRuns`), session-scoped mempalace/KG/outcome queries
- `pending.ts` — escalation-state detection (message scan, diary fallback)
- `schema.ts` — zod schemas, single source of truth for types and validation

## Environment

| Variable                                        | Purpose                                                          | Default                                                 |
| ----------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------- |
| `PENNY_ORCH_DB`                                 | Engine checkpointer DB path                                      | `<project_root>/.penny/orchestration.db`                |
| `PI_VENV_PYTHON`                                | Python used for bridge + checkpointer reads                      | `<project_root>/.venv/bin/python`                       |
| `PI_MEMORY_BRIDGE`                              | memory_bridge.py path                                            | `<project_root>/scripts/system/bridge/memory_bridge.py` |
| `PI_OBSERVABILITY_REST_URL`                     | Archive endpoint base                                            | `http://localhost:8765`                                 |
| `PI_OBSERVABILITY_API_KEY`                      | Bearer token for archive POSTs                                   | (unset)                                                 |
| `PI_COMPACTION_SUMMARY_MODEL`                   | Override summarization model `provider/model-id`                 | (unset → the session's current model)                   |
| `PI_COMPACTION_SUMMARY_TIMEOUT_MS`              | Soft timeout for the summarization call                          | `30000`                                                 |
| `PENNY_ABLATE_COMPACTION_DETERMINISTIC_SUMMARY` | `1` ablates the deterministic fallback (model-fail → Pi default) | (off)                                                   |

Values are read from the shell first, then from `.env` (Pi does not load `.env` itself).

## Subagent Integration

Subagents spawn with `--session-dir <tmpdir> --no-extensions -e .pi/extensions/compaction/index.ts`, so every subagent process gets the same compaction behavior. Session directories are cleaned up after the agent exits.

## Pi Notes

- Pi package: `@earendil-works/pi-coding-agent` (the old `@mariozechner` namespace is aliased by Pi's extension loader — imports need no change).
- Pi's jiti cache may hold stale compiled artifacts after source edits. After any source change: `rm -rf /tmp/jiti/compaction-*`, and ensure `.env` sets `PI_PACKAGE_DIR` to the installed package path.

## Tests

```bash
bun install
bun run test          # unit + integration via vitest (177 tests)
bun run test:all      # lint + format:check + unit
bun run test:watch    # watch mode
```

> Use `bun run test` (the configured vitest runner), not `bun test` — Bun's
> native runner hoists `vi.mock` globally and leaks module mocks across files,
> producing false failures. Vitest isolates per-file.

Unit tests exercise the real exported functions; `tests/integration/engine-runs.test.ts` reads a real fixture SQLite checkpointer through the venv Python.
