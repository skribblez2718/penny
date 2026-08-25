# Compaction Resume Protocol

Execute this protocol once when a compaction summary contains `[RESUME-REFS v2]`.
The prose brief is the primary orientation. The appendix contains code-owned exact
current-session recovery addresses, never semantic search hints.

## 1. Validate the block

```text
[RESUME-REFS v2]
run:<run_id>
artifact:<artifact_id>@sha256:<64-lowercase-hex-digest>
memory:<durable_memory_id>
[/RESUME-REFS]
```

- `artifact_id` is `art_` plus 64 lowercase hex characters.
- Unknown versions, malformed lines, placeholders, duplicates, or an unclosed block make
  the whole appendix invalid; do not partially repair it.
- Never derive a run/artifact from a name, goal similarity, recency, memory, or a global
  manifest scan.

## 2. Reorient from prose

Read Goal, Current Work, In-Flight Runs, Pending, Next Steps, constraints, unresolved
errors, and touched files. A newer user goal supersedes older completed-skill context.
The prose is sufficient for ordinary continuation; dereference only when detail is needed.

## 3. Resume exact runs

For each needed `run:<run_id>`, use the orchestration owner's exact recovery path.
Rehydrate checkpoint state; never reconstruct FSM state from prose, artifact payloads, or
memory. If the row is missing or terminal, treat it as stale and continue from prose.

## 4. Read exact artifacts

For `artifact:<id>@sha256:<digest>`:

1. Call `artifact_read({ artifact: "<id>" })`.
2. Verify the returned ID and digest.
3. Repeat with `next_range` until `truncated` is false.

Reads are direct and non-expiring. Missing, malformed, or digest-mismatched artifacts do
not authorize broad discovery; report the issue if content is required.

A ref may identify a `handoff-index` artifact. Its JSON records are the complete exact
current-session communication set that could not fit inline. Page through it, choose the
needed ID by its producer/branch/step metadata, and pass that exact ID downstream.

## 5. Optional durable memory

A `memory:<id>` line may be read directly when needed. Do not perform semantic memory
search to replace an absent workflow ID. Memory service absence never blocks exact run or
artifact recovery.

## 6. Exact-source invariant

Compaction preserves only IDs proven to come from current-session completed `subagent` or
`skill` result metadata, IDs explicitly passed later through `input_artifacts`, or a prior
code-owned current-session resume block/index. It never scans historical artifacts, grant
state, memory, or task-text names.

When direct lines exceed the shared result budget, compaction persists one immutable
handoff index and emits only its ID. If that index cannot be persisted and re-read, the
custom enhancement yields to Pi's default compaction rather than guessing or silently
omitting communication refs.
