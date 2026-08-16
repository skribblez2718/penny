# Agent Invocation — Dispatch, exact inputs, and capture

## What

`subagent` invokes one, parallel, or chained workers. Engine-backed skills use
that same runner. Every worker starts with fresh model context and sees only its
assembled prompt, task, allowlisted tools, and any exact owner grants.

## Assembly

1. Read the requested entry from the `.pi/agents` local catalog.
2. Inject optional static Domain Guidance before `<agent_boundary>`.
3. Add Project Index and runtime context.
4. Set the worker runtime role and strip approval/receipt secrets.
5. Expose `artifact_read` only when trusted invocation metadata grants exact refs.
6. Spawn the worker process.

## Task contract

A task contains:

- the current goal and request-specific constraints;
- current-run identifiers needed by the execution owner;
- `input_artifacts` metadata for exact predecessors, when any;
- an `output_artifact` contract when the owner must persist stage output.

Do not put predecessor payload bytes, durable-memory room pointers, or
model-authored persistence claims in the task. If a granted artifact is larger
than one result page, call `artifact_read` with the returned opaque continuation
until `truncated` is false. Verify the canonical ref and digest supplied by the
tool result.

## Completion

The worker returns complete task content. If Domain Guidance defines a
`SUMMARY`, it appears at the end as compact routing data. For owner-managed
workflows, the owner persists and verifies the exact final response before
parsing that SUMMARY; persistence failure prevents the next state from running.

A direct single invocation may return the complete worker result to Penny. A
chain persists every step and grants only the preceding canonical ref to the next
worker. `{previous}` is a bounded instruction identifying that ref, never an
inline payload substitute. Parallel branches receive no sibling grants.

## Recovery and compaction

Selected run/artifact refs remain in durable owner checkpoints. A compaction
summary may include a code-owned `[RESUME-REFS v2]` appendix with exact run and
artifact addresses. Resume control state from the run checkpoint and read only
currently granted artifacts; do not replace absent refs with semantic memory
search. Typed continuation keeps large reads bounded and byte-exact.

## Verification

- [ ] Worker task includes exact refs, not workflow payload bytes.
- [ ] Every granted ref is read with `artifact_read` through complete continuation.
- [ ] Owner persistence and ref verification happen before SUMMARY routing.
- [ ] Workers receive no durable-memory tools or room instructions.
- [ ] Chain handoff is canonical-ref based and restart-safe.
- [ ] Parallel branches remain isolated.

## Files

| File                                 | Purpose                                    |
| ------------------------------------ | ------------------------------------------ |
| `.pi/extensions/subagent/README.md`  | Invocation modes and chain handoff         |
| `.pi/extensions/artifacts/README.md` | Artifact read/grant protocol               |
| `docs/penny/compaction-protocol.md`  | Context-safe continuation after compaction |
