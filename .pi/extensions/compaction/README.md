# Penny Custom Compaction Extension

Turns Pi compaction into a bounded recovery checkpoint with **model-owned prose and code-owned exact references**.

The model-visible summary contains:

1. A concise prose resumption brief over the evicted conversation.
2. An optional strict `[RESUME-REFS v2]` appendix containing only exact addresses:

   ```text
   run:<run_id>
   artifact:<artifact_id>@sha256:<content_digest>
   ```

A durable-memory ID may be carried only when an owner already supplied that exact ID. Compaction never lists or searches memory, session rooms, or active runs.

## Source of Truth

Compaction collects exact run IDs from two places only:

- named, owner-produced fields in persisted `skill` tool-result metadata; and
- a prior valid `[RESUME-REFS v2]` block in this conversation.

It then opens the orchestration SQLite checkpointer with `readOnly: true`, enables `PRAGMA query_only`, and selects only those run IDs. It never scans pending rows or correlates by session name/recency.

For each resumable TypeScript v2 checkpoint, every `selected_artifacts` entry must be a strict artifact-ref v1 value with canonical identity, run binding, store URI, and digest consistency before it can enter the appendix. Invalid refs are omitted while the exact run ref remains recoverable. Artifact bytes are not opened during compaction, so a missing or corrupt artifact object cannot block run recovery.

## Failure Policy

- **Memory unavailable:** irrelevant to recovery; no memory service is called.
- **Checkpointer missing/unavailable:** prose compaction continues without refs.
- **Missing run row or now-terminal run:** the stale ref is omitted.
- **Invalid checkpoint protocol/ref:** reject that protocol/ref, record a bounded issue, preserve valid run recovery.
- **Model unavailable:** use the tagged deterministic fallback; when that LOAN is ablated, yield to Pi's default compaction.
- **Oversized output:** fit the final model-visible envelope with the shared result-budget utility. One estimated token is charged per serialized UTF-8 byte, so the unchanged 8,192 estimated-token cap limits the complete envelope to at most 8,192 bytes. Prose is UTF-8-safe truncated; refs are removed only as complete lines, artifacts before runs, so the block is never malformed.
- **Invalid owner budget attempting to raise hard caps:** enforce the shared hard defaults.

## Strict Versions

| Contract                          | Version |
| --------------------------------- | ------: |
| Compact artifact                  | `3.0.0` |
| Resume appendix                   |    `v2` |
| Orchestration artifact checkpoint |     `2` |
| Immutable artifact ref            |     `1` |

Unsupported versions and unknown schema fields fail closed.

## Architecture

```text
session_before_compact
  ├─ merge evicted + split-turn-prefix messages
  ├─ collect exact run IDs from trusted result metadata + prior v2 refs
  ├─ readExactCheckpoints(run IDs) using read-only SQLite
  │    └─ validate RunContext.selected_artifacts
  ├─ detect conversational pending state (message-only)
  ├─ build + strictly validate compact artifact 3.0.0
  ├─ model prose, or deterministic LOAN fallback
  ├─ append exact run/artifact refs
  ├─ fit final model-visible envelope with shared result budget
  └─ archive structured details asynchronously
```

## Files

- `index.ts` — compaction hook, exact-ID extraction, prose/refs assembly, shared-budget fitting
- `checkpointer.ts` — exact read-only SQLite access and strict selected-ref validation
- `schema.ts` — strict versioned Zod schemas
- `summarizer.ts` — model prose path and exact grounded digest
- `pending.ts` — message-only escalation detection
- `loans.ts` — deterministic fallback LOAN registry
- `pi-messages.ts` — structural Pi message boundary types

The removed raw memory bridge has no replacement: memory is not a recovery prerequisite.

## Environment

| Variable                                        | Purpose                                 | Default                                    |
| ----------------------------------------------- | --------------------------------------- | ------------------------------------------ |
| `PENNY_ORCH_V2_DB`                              | Absolute TypeScript checkpointer path   | `$PROJECT_ROOT/.penny/orchestration-v2.db` |
| `PI_OBSERVABILITY_REST_URL`                     | Optional archive endpoint               | `http://localhost:8765`                    |
| `PI_OBSERVABILITY_API_KEY`                      | Optional archive bearer token           | unset                                      |
| `PI_COMPACTION_SUMMARY_MODEL`                   | Optional `provider/model-id` override   | current session model                      |
| `PI_COMPACTION_SUMMARY_TIMEOUT_MS`              | Model summarization timeout             | `30000`                                    |
| `PENNY_TOOL_RESULT_MAX_BYTES`                   | Shared lower byte cap                   | shared hard default                        |
| `PENNY_TOOL_RESULT_MAX_CHARACTERS`              | Shared lower character cap              | shared hard default                        |
| `PENNY_TOOL_RESULT_MAX_TOKENS`                  | Shared lower estimated-token cap        | shared hard default                        |
| `PENNY_ABLATE_COMPACTION_DETERMINISTIC_SUMMARY` | Disable deterministic fallback when `1` | off                                        |

Exact checkpoint refs require a Node runtime that provides `node:sqlite` (Node 22.5+; current Pi runtime recommended). On an older runtime, prose compaction still succeeds but the unavailable checkpointer read yields no refs.

## Result budget and telemetry

Byte, character, and estimated-token caps are independent. The release minimum context headroom is 16,384 tokens; a conforming result consumes no more than half and leaves at least 8,192 tokens reserved after it. Compaction artifact metadata records the final envelope measurement and reserve assessment.

`metadata.compaction_correlation` contains metadata-only session/run keys and `status: not_evaluated`. It enables a later telemetry join but does not claim a live supported-model trial, establish that one result caused compaction, or mark the release trial passed. Live correlation remains a separately receipted release activity.

## Tests

```bash
bun run test
bun run typecheck
bun run lint
bun run format:check
bun run test:all
```

Focused coverage includes fresh-process prior-ref recovery, exact read-only queries, missing/corrupt artifacts, memory unavailability, giant result budgets, strict schema/version/ref failures, and a production source guard against legacy bridge/discovery paths.
