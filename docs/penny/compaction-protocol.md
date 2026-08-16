# Compaction Resume Protocol

Execute this protocol once when a compaction summary containing a `[RESUME-REFS v2]` block appears in context. The prose brief is the primary orientation. The appendix contains exact recovery addresses selected from read-only orchestration checkpoints; it is not a search hint.

Once processed, do not re-execute it in the same session.

## 1. Validate the Appendix

The only supported format is:

```text
[RESUME-REFS v2]
run:<run_id>
artifact:<artifact_id>@sha256:<64-lowercase-hex-digest>
memory:<durable_memory_id>
[/RESUME-REFS]
```

Rules:

- `run:` and `artifact:` are exact addresses, not names or search terms.
- `memory:` is optional and appears only when an owner had already supplied that exact durable ID.
- Every artifact ID is `art_` followed by 64 lowercase hexadecimal characters.
- Every artifact digest is exactly 64 lowercase hexadecimal characters.
- Unknown versions, malformed lines, duplicate refs, placeholders, and unclosed blocks are invalid. Do not partially reinterpret or repair them.
- Never derive a run from a session name, room name, recency, goal similarity, or memory search.

If the block is invalid, continue from the prose and report the invalid appendix only when it affects the requested work.

## 2. Reorient from the Prose

Read the brief top to bottom: latest goal, current work, exact in-flight runs, pending user questions, next steps, constraints, unresolved errors, and touched files.

- `## Goal` is the latest substantive intent, not the first-seen intent.
- `## Active Skill` may be marked `superseded by a newer request`; in that case the newer `## Goal` controls.
- `## Current Work` and `## Next Steps` describe the immediate continuation.
- `## Pending` preserves conversational escalation state. An exact awaiting-user checkpoint remains authoritative when present.

The prose is sufficient for ordinary continuation. Dereference only when missing detail is needed.

## 3. Resume Exact Runs

For each `run:<run_id>` needed by the current goal:

1. Use the orchestration owner's exact run-ID recovery path.
2. Rehydrate the persisted checkpoint; do not reconstruct FSM state from prose, artifact text, durable memory, or session metadata.
3. If the checkpoint is `awaiting_user`, present its still-open question and submit the answer through the owner's resume path.
4. If it is running, continue from the persisted state.
5. If the exact row is absent or terminal, treat the ref as stale and continue from the prose; never search for a “similar” active run.

## 4. Read Exact Artifacts on Demand

For `artifact:<artifact_id>@sha256:<digest>`:

- Use `artifact_read` only when the execution owner has granted that exact artifact to the current consumer.
- Verify that the returned artifact ID and `content_digest` exactly match the appendix before relying on content.
- Follow typed continuation cursors for paged content; do not list, search, guess, or broaden grants.
- Missing, ungranted, stale, malformed, or digest-mismatched artifacts do **not** block run recovery. Continue with the exact run checkpoint and prose, and report the artifact issue if its content is required.

The run checkpoint owns control state. Artifacts own immutable bytes and evidence. Neither is reconstructed from the other.

## 5. Optional Durable Memory

A `memory:<durable_memory_id>` line may be dereferenced directly when its detail is needed. Do not perform broad or semantic memory searches to replace an absent ID.

Memory service absence, an unavailable memory ID, or no memory refs at all never blocks recovery. Continue from prose, run checkpoints, and exact artifacts.

## 6. Budget Awareness

The final summary is fitted with the shared model-visible result budget. The
estimator charges one token per serialized UTF-8 byte, so the unchanged 8,192
estimated-token cap limits the complete envelope to at most 8,192 bytes. Byte
and character caps remain independent. Release minimum context headroom is
16,384 tokens, leaving at least 8,192 tokens reserved after one conforming
result.

- `[prose truncated to fit the shared result budget]` means lower-priority prose was shortened at a UTF-8 boundary.
- `[N resume refs omitted by the shared result budget]` means complete ref lines were omitted, artifacts before runs. Never infer the omitted addresses.
- A rendered v2 block is always structurally complete; raw byte truncation is not valid.

Compaction metadata carries `not_evaluated` session/run correlation keys for a
later telemetry join. Their presence does not claim a live supported-model
trial, causation, or a no-compaction result.
