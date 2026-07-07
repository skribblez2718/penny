# Penny Custom Compaction Extension

Replaces Pi's default compaction summary with a **resumability checkpoint**: when the session compacts, Penny must resume with no work lost.

The summary spliced into context has two parts:

1. **A prose brief** — goal, active skill, in-flight orchestration runs, pending questions, key decisions, unresolved errors, touched files. Penny re-orients by reading, not parsing.
2. **A `[RESUME-REFS v2]` appendix** — real, dereferenceable addresses: `run_id` + engine state with a concrete `resume=skill(...)` call, mempalace room/drawer IDs, outcome-ledger decision IDs, KG entities, and verbatim tool-call examples (successes and error→correction pairs, for weak tool-callers). Anything the token budget couldn't carry is recoverable through these pointers instead of being lost.

Penny's consumer-side instructions live in `docs/penny/compaction-protocol.md` (triggered from `.pi/SYSTEM.md`).

## Sources of Truth

| Data                | Source                                                                                                                                     | Never                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| In-flight run state | The orchestration engine's durable run_id checkpointer (`.penny/orchestration.db`, or `PENNY_ORCH_DB`), read read-only via the venv Python | Reconstructed from mempalace drawer text                                |
| What agents wrote   | Mempalace room/drawer **pointers** via `memory_bridge.py`, scoped to real session IDs (skill results + checkpointer rows)                  | Regex-inferred agent/phase/completion state                             |
| Decisions           | Outcome-ledger drawers (real drawer IDs as `decision_id` when available)                                                                   | —                                                                       |
| Session IDs         | Skill tool results and checkpointer rows only                                                                                              | Fabricated (`skill-${Date.now()}`) — a fake ID silently matches nothing |

## Failure Policy: Degrade, Never Abandon

- **Budget overflow** (> 6k tokens): cardinality caps tighten progressively (halving scale, floor of 1 item per field) and the summary is rebuilt until it fits. Absolute last resort is tail truncation with a visible marker — goal, runs, and pending state at the top always survive.
- **Validation failure**: logged loudly (`COMPACTION_VALIDATION_FAILED`), but the prose summary is still emitted and the artifact still archived. Pi's default prose summary is never the fallback on a path this extension controls.
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
    ├──► detectDominantSkill (messages; session_id from the paired tool result only)
    ├──► queryEngineRuns (checkpointer — pending runs, goal, awaiting-user question)
    ├──► in parallel: detectPendingState · mempalace rooms (scoped to real session ids)
    │                 · KG entities · outcome-ledger decisions
    ├──► buildArtifact (zod-validated PennyCompactArtifact v2)
    ├──► applyEviction (priority + recency + confidence; live-session rooms never evicted)
    ├──► createProseSummary = prose brief + [RESUME-REFS v2]
    ├──► degrade loop until summary ≤ 6k tokens
    ├──► POST full artifact → observability /compactions (fire-and-forget archive)
    └──► return summary (spliced into context by Pi)
```

The full structured artifact (schema 2.0.0, `schema.ts`) goes to the observability archive; the model context gets the prose + refs.

## Files

- `index.ts` — hook handler, extraction, eviction, summary/refs builders (pure helpers are exported for tests)
- `bridge.ts` — memory-bridge client, engine-checkpointer reader (`queryEngineRuns`), mempalace/KG/outcome queries
- `pending.ts` — escalation-state detection (message scan, diary fallback)
- `schema.ts` — zod schemas, single source of truth for types and validation

## Environment

| Variable                    | Purpose                                     | Default                                                 |
| --------------------------- | ------------------------------------------- | ------------------------------------------------------- |
| `PENNY_ORCH_DB`             | Engine checkpointer DB path                 | `<project_root>/.penny/orchestration.db`                |
| `PI_VENV_PYTHON`            | Python used for bridge + checkpointer reads | `<project_root>/.venv/bin/python`                       |
| `PI_MEMORY_BRIDGE`          | memory_bridge.py path                       | `<project_root>/scripts/system/bridge/memory_bridge.py` |
| `PI_OBSERVABILITY_REST_URL` | Archive endpoint base                       | `http://localhost:8765`                                 |
| `PI_OBSERVABILITY_API_KEY`  | Bearer token for archive POSTs              | (unset)                                                 |

Values are read from the shell first, then from `.env` (Pi does not load `.env` itself).

## Subagent Integration

Subagents spawn with `--session-dir <tmpdir> --no-extensions -e .pi/extensions/compaction/index.ts`, so every subagent process gets the same compaction behavior. Session directories are cleaned up after the agent exits.

## Pi Notes

- Pi package: `@earendil-works/pi-coding-agent` (the old `@mariozechner` namespace is aliased by Pi's extension loader — imports need no change).
- Pi's jiti cache may hold stale compiled artifacts after source edits. After any source change: `rm -rf /tmp/jiti/compaction-*`, and ensure `.env` sets `PI_PACKAGE_DIR` to the installed package path.

## Tests

```bash
bun install
bun test              # unit + integration (96 tests)
bun run test:watch    # watch mode
```

Unit tests exercise the real exported functions; `tests/integration/engine-runs.test.ts` reads a real fixture SQLite checkpointer through the venv Python.
