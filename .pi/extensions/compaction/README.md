# Penny Custom Compaction Extension

Pi compaction produces model-owned prose plus code-owned exact recovery references.

## Always-enabled native compaction

Every Penny-owned skill worker, child workflow worker, direct agent (single, parallel or
chain), and anonymous private-KB session uses native Pi automatic compaction. The shared
session-local policy keeps it enabled even when global, project or injected settings say
`false`, including after reload, settings changes, model selection and direct-session
replacement. The resource loader and session receive the same enforced settings manager.
Worker policy never writes operator settings; reserve/recent-token preferences and
model-specific overrides remain unchanged. Private-KB ambient-resource isolation is unchanged.

Pi still owns threshold and context-overflow recovery, cancellation, summary persistence
and retry. This extension augments eligible summaries with exact recovery references; when
it yields, Pi's native summary remains available. Native summary streams retain the host's existing model/disclosure guard. Guarded hosts
must exclude ambient custom summarizers that do not use their admitted session stream.

Real streamed summary text/thinking deltas renew the existing worker/direct-agent inactivity
lease through content-free activity records: class and positive byte count only. Both native
and custom summaries report progress; silent summaries still expire. There is no extra model
call, timer heartbeat or total-work deadline. Custom deltas use an owner-private
callback injected only into the exact existing Penny producer; public event-bus messages
have no liveness authority. Reload, completion and invocation cancellation retire stale
observers. This closes accidental progress provenance, not hostile in-process JavaScript
access to host objects.

Optional artifact telemetry has a separate one-second network deadline, an unreferenced
timer, cancellation propagation and response-body cleanup. A failed or stalled telemetry
POST does not delay the summary or make another model request.

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

Current `skill` results use the shared, closed `SkillResultSchema` and
`parseCurrentSkillResult` producer/consumer boundary. The parser validates the entire aggregate,
including diagnostics, input assurance and canonical clarification continuations. Invalid or
over-capacity results fail closed; there is no historical-result or obsolete pause adapter.
Clarification run identity comes from the engine continuation, never a session ID or question field.
Independent saved-artifact readers retain their existing schema-v1/v2 support; immutable saved
artifacts are not rewritten.

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

Tests cover current skill-result fixtures, malformed and obsolete result rejection, bounded
aggregate validation, canonical clarification continuations, honest terminal statuses,
exact unique-ID call/result correlation (including out-of-order results), short goal pivots,
current-session selection, prior exact refs, no global leakage, read-only checkpoint access,
repeated compaction, handoff-index materialization, strict worker-metadata rejection, exact worker
goal/framing recovery on both summary paths, and ordinary-session non-regression.
