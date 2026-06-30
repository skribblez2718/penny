# Penny Custom Compaction Extension

Replaces Pi's default prose summary with a structured **Penny Compact Artifact** — a JSON checkpoint that references mempalace rooms, knowledge graph entities, and outcome ledger entries.

## Phase 3 Features

| Feature                | Implementation                                          | Tests |
| ---------------------- | ------------------------------------------------------- | ----- |
| Goal extraction        | `extractSessionState()` — scans system prompts          | ✅    |
| Constraints extraction | Keyword detection in user messages                      | ✅    |
| tiktoken counting      | Exact token count via `tiktoken` library                | ✅    |
| 10-level eviction      | Priority sort: errors > pending > CERTAIN > ... > debug | ✅    |
| Stale entity cleanup   | Drop stale KG refs after N=3 cycles                     | ✅    |
| Budget enforcement     | Cancel + fallback if artifact > 10k tokens              | ✅    |

---

## Phase 3+ Features (Pending State + Bridge)

| Feature                 | Implementation                                                                                                                                 | Tests |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| Pending state detection | `pending.ts` `detectPendingState()` — scans messages for questionnaire/verification/UNKNOWN_STATE signals; falls back to mempalace diary query | ✅    |
| Bridge client           | `bridge.ts` `callBridge()` — typed wrapper around `penny_memory_bridge.py` with 30s timeout                                                    | ✅    |
| Mempalace query         | `queryActiveSkillSessions()`, `queryPendingDecisions()`, `queryDiaryEscalation()`                                                              | ✅    |
| Health check            | `bridgeHealthCheck()` — verifies bridge is reachable                                                                                           | ✅    |

---

## Phase 3++ Features (Bridge Integration)

| Feature                  | Implementation                                                    | Tests |
| ------------------------ | ----------------------------------------------------------------- | ----- |
| Mempalace skill rooms    | `queryMempalaceSkillRooms()` — lists `skills/*` rooms + drawers   | ✅    |
| KG entity verification   | `queryKGEntitiesForSession()` — kg_query with `last_verified`     | ✅    |
| Outcome ledger decisions | `queryOutcomeLedgerDecisions()` — search `penny/outcomes`         | ✅    |
| Agents inferred          | `buildArtifact()` derives `agents_invoked` from room names        | ✅    |
| Resilient queries        | All bridge calls wrapped in try/catch; artifact builds regardless | ✅    |

---

## Phase 4 Features (Tool Usage Patterns — for weak tool-callers like Kimi/GLM)

| Feature                  | Implementation                                                                                                    | Tests |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------- | ----- |
| Tool call examples       | `extractToolCalls()` — scans assistant messages for recent `toolCall` blocks + pairs with `toolResult` outcomes   | ✅    |
| Error → correction pairs | `extractToolErrorRecovery()` — captures failed tool calls + successful retries (teaches the model what NOT to do) | ✅    |
| Robust error detection   | `isToolResultError()` — checks `isError` field, then content for error/validation/failed/ENOENT/EISDIR/timeout    | ✅    |
| Config budget shift      | `maxArtifactTokens` lowered 10k → 6k to counterbalance new fields; `files.read` cap lowered 50 → 30               | ✅    |
| Silent POST on success   | `postCompactionArtifact()` logs only on failure/warning; no success noise in TUI                                  | ✅    |
| Fetch timeout            | `AbortController` 10s timeout on observability POST                                                               | ✅    |

---

## Subagent Integration

Subagents now spawn with `--session-dir <tmpdir> --no-extensions -e .pi/extensions/compaction/index.ts`. This enables the Penny custom compaction extension in every subagent process, replacing Pi's default prose summary with a structured compact artifact when context limits are reached. Session directories are cleaned up after the agent exits.

## Architecture

```
Pi detects threshold
    │
    ▼
session_before_compact event
    │
    ▼
compactionExtension handler
    ├──► Extract session state (messages → goal/constraints/preferences)
    ├──► Detect pending state (escalation scan + mempalace diary query via bridge)
    ├──► Build PennyCompactArtifact (JSON)
    ├──► Validate with zod
    ├──► If valid → cancel default, emit artifact
    └──► If invalid → let Pi fall back to default
```

## Pi v0.74.0 Migration Note

Pi was migrated from `@mariozechner/pi-coding-agent` → `@earendil-works/pi-coding-agent`. The old package namespace is still aliased by Pi's extension loader, so **no import changes are required** in this extension. However, Pi's jiti cache may hold stale compiled artifacts after source edits.

**After any source change, clear jiti cache before restarting Pi:**

```bash
rm -rf /tmp/jiti/compaction-*
```

Also ensure `.env` sets `PI_PACKAGE_DIR` to the new path:

```bash
PI_PACKAGE_DIR=/home/skribblez/.bun/install/global/node_modules/@earendil-works/pi-coding-agent
```

## Installation

```bash
cd .pi/extensions/compaction
bun install
```

## Schema

Defines `PennyCompactArtifact` and sub-schemas in `schema.ts`.

## Tests

```bash
bun test              # unit + integration
bun test tests/unit/tool-extraction.test.ts   # new Phase 4 tests
bun run test:watch    # watch mode
```

## Phase Status

| Phase     | Status      | Notes                                                                           |
| --------- | ----------- | ------------------------------------------------------------------------------- |
| Phase 1   | ✅ Complete | Design doc + TypeScript interfaces in `plans/compaction/`                       |
| Phase 2   | ✅ Complete | Extension hook + zod schemas + tests                                            |
| Phase 3   | ✅ Complete | Message extraction, tiktoken counting, eviction algorithm, stale cleanup        |
| Phase 3+  | ✅ Complete | Pending state detection + bridge utility                                        |
| Phase 3++ | ✅ Complete | Mempalace skill rooms + KG entity verification + outcome ledger decisions       |
| Phase 4   | ✅ Complete | Tool call extraction + error recovery + robust error detection + v0.74.0 compat |
