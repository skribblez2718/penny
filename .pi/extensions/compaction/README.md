# Penny Custom Compaction Extension

Pi compaction produces model-owned prose plus code-owned exact recovery references.

## Exact source set

Artifact IDs enter `[RESUME-REFS v2]` only from:

1. exactly correlated `subagent` result metadata in this session;
2. exactly correlated, schema-validated `skill` result metadata in this session;
3. exact IDs explicitly passed later through `input_artifacts`;
4. a prior valid current-session resume block/handoff index; or
5. selected refs from an exact orchestration run ID already proven by those skill results.

Compaction never scans global/historical artifact manifests, old sessions, memory, task-text
names, agent-name heuristics, or recency. Exact input IDs use indexed manifest lookup only.

## Skill-result compatibility

The only historical result admitted is the exact pre-engine `SkillResult` declared at commit
`12e8c32922bae2db0da7cc706322d10b2eccb81d`. Its required boolean
`requires_approval`, required and optional fields, nested result/question shapes, and mode enum are
validated strictly. A current-era marker selects only the current parser; malformed current-like
data is never retried as historical data.

## Output

```text
[RESUME-REFS v2]
run:<run_id>
artifact:<artifact_id>@sha256:<digest>
memory:<exact optional durable-memory id>
[/RESUME-REFS]
```

Schema-v1 refs from old checkpoints are normalized to schema v2. New refs contain lineage
but no consumer/access field.

When all exact artifact lines cannot fit the shared result budget, compaction persists one
immutable `handoff-index` artifact containing the complete ordered routing records and
emits only its ID. If that index cannot be persisted and re-read, the custom enhancement
yields to Pi's default compaction rather than guessing or silently losing refs.

## Run recovery

Run IDs are read from the current project's catalog-bound `orchestration.db` with
`readOnly` and `PRAGMA query_only`. Compaction verifies the database's opaque project ID;
there is no independent path selector, CWD fallback, or pending-run/session scan. Missing
or terminal rows are omitted. Control state comes from checkpoints, never artifact
payloads.

## Failure policy

- Memory unavailable: irrelevant to exact recovery.
- Checkpointer unavailable: prose and exact non-run communication refs still continue.
- Invalid ref/object: omit it and record a bounded issue; never broaden discovery.
- Model unavailable: deterministic fallback LOAN, or Pi default when ablated.
- Oversized refs: one verified handoff-index ID.
- Invalid owner budget: shared hard defaults.

## Versions

| Contract                       | Version |
| ------------------------------ | ------: |
| Compact artifact               | `3.1.0` |
| Resume appendix                |    `v2` |
| Current immutable artifact ref |     `2` |
| Legacy readable artifact ref   |     `1` |

## Verification

```bash
bun run --cwd .pi/extensions/compaction typecheck
bun run --cwd .pi/extensions/compaction test:unit
bun run --cwd .pi/extensions/compaction lint
bun run --cwd .pi/extensions/compaction format:check
```

Tests cover authentic current/pre-engine skill-result fixtures, mandatory historical
`requires_approval`, malformed historical/current fail-closed behavior, honest terminal statuses,
exact unique-ID call/result correlation (including out-of-order results), short goal pivots,
current-session selection, prior exact refs, no global leakage, read-only checkpoint access,
repeated compaction, and handoff-index materialization.
