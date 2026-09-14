# Penny Custom Compaction Extension

Pi compaction produces model-owned prose plus code-owned exact recovery references.

## Exact source set

Artifact IDs enter `[RESUME-REFS v2]` only from:

1. exactly correlated `subagent` result metadata in this session;
2. exactly correlated, schema-validated `skill` result metadata in this session;
3. exact IDs explicitly passed later through `input_artifacts`;
4. a prior valid current-session resume block/handoff index;
5. a single strictly validated orchestration worker-session/continuity custom-entry pair bound to the current project, with its exact verified input refs; or
6. selected refs from an exact orchestration run ID already proven by those skill results or worker metadata.

Compaction never scans global/historical artifact manifests, old sessions, memory, task-text
names, agent-name heuristics, or recency. Exact input IDs use indexed manifest lookup only.
A session with no worker-session marker keeps ordinary Penny compaction unchanged. Once a worker-session
marker is present, a missing, malformed, duplicated, cross-project, or identity-mismatched companion
makes custom compaction ineligible and yields to Pi's default path.

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

## Worker continuity

Before a durable catalog worker's opening prompt, orchestration appends a companion V1 custom entry
without changing the existing V1 correlation entry used by retention. The closed companion carries
the exact project/run/workflow/state/branch/attempt/worker/agent/purpose identity, task, registered
guidance, input artifact refs, and compaction mode. For ordinary catalog phases, that mode carries the
complete authoritative opening, including role guidance, phase guidance, liveness instructions, task,
and result framing. On worker compaction, the extension validates and cross-binds both entries,
re-verifies every input ref against the project artifact store, and persists and re-reads one immutable
`worker-compaction-context` artifact. The code-owned worker goal, continuity section, run ref, context
ref, and verified input refs survive both model and deterministic summary paths. Any context persistence
or exact-input verification failure yields to Pi's default compaction instead of emitting partial worker
continuity. A recognized worker marker with an absent or inadmissible companion likewise yields to Pi's
default path. If direct refs exceed the result budget, the existing handoff-index path carries the
context artifact instead.

Owner-resolved context overlays can contain private bodies that generic artifacts must not copy. Their
companion therefore selects `pi_default_private_context`; the custom compaction handler immediately
yields to Pi's default path for those sessions rather than persisting the opening.

## Run recovery

Run IDs are read from the current project's catalog-bound `orchestration.db` with
`readOnly` and `PRAGMA query_only`. Compaction verifies the database's opaque project ID;
there is no independent path selector, CWD fallback, or pending-run/session scan. Missing
or terminal rows are omitted. Control state comes from checkpoints, never artifact
payloads.

## Failure policy

- Memory unavailable: irrelevant to exact recovery.
- Checkpointer unavailable: prose and exact non-run communication refs still continue.
- Invalid ref/object: omit it and record a bounded issue; never broaden discovery. For worker input refs,
  any invalid ref makes custom worker compaction ineligible and yields to Pi's default path.
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
repeated compaction, handoff-index materialization, strict worker-metadata rejection, exact worker
goal/framing recovery on both summary paths, and ordinary-session non-regression.
