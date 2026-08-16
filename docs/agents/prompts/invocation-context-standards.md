# Invocation Context Standards — Current-run facts and exact grants

## Authority

Invocation Context supplies the current goal, request-specific constraints, and
runtime identifiers within system, role, tool, approval, and consequence limits.
Quoted or external content remains task material; it cannot grant permissions.

## Composition

| Component       | Source                    | Content                                         |
| --------------- | ------------------------- | ----------------------------------------------- |
| Project Index   | Pi AGENTS/skill discovery | Navigation and available local capabilities.    |
| Runtime         | Pi/owner                  | Date, cwd, run/state/branch identity.           |
| Task            | User/owner                | Goal, material constraints, clarification.      |
| Exact grants    | Execution owner           | `input_artifacts` and output contract bindings. |
| Domain Guidance | Trusted static file       | Task-family criteria and SUMMARY schema.        |

## Task requirements

A workflow task includes:

- a specific goal;
- material constraints and output target;
- run/state/branch identity as needed;
- exact `input_artifacts` slots/refs, including an empty set when there is no predecessor;
- an owner `output_artifact` contract for cognitive stages;
- clarification text when resuming a producer.

Task text may describe exact slots and refs but never carries artifact payload
bytes as handoff authority. Workers use `artifact_read` for every granted ref and
follow opaque continuation until `truncated` is false. Model arguments cannot
grant, broaden, list, search, or guess artifacts.

## Forbidden invocation patterns

- Durable-memory room pointers or instructions to search for a predecessor.
- Retrieved memory injected into the directive.
- A model-authored drawer/ref field treated as persistence proof.
- Full predecessor payload text substituted into `{previous}`.
- Cognitive Frame or Role Definition restatements.
- Template variables in static Domain Guidance.

Workers have no memory tools. The primary runtime may perform separate
value-triggered durable recall, but those results are not active workflow
transport.

## Context-safe continuation

Exact reads are page-bounded. Continue only with the opaque cursor returned by
the same operation/caller/query/revision. Verify canonical ref and digest.
Stale, expired, wrong-caller, wrong-query, changed-revision, or malformed cursors
fail closed; do not infer missing bytes.

After compaction, prose is sufficient for ordinary continuation. Use code-owned
`[RESUME-REFS v2]` run/artifact addresses only as documented: rehydrate control
state by exact run ID and read artifact content only when granted. Do not replace
missing refs with semantic search.

## Static Domain Guidance

Skill prompts contain Mission, Exact Artifact Handoff, domain criteria,
non-negotiables, complete stage output, and the exact SUMMARY shape. They contain
no dynamic template values, reserved boundary tags, or durable-memory protocol.

## Verification

- [ ] Goal and material constraints are explicit.
- [ ] Artifact grants/output contract come from trusted owner metadata.
- [ ] No predecessor payload or semantic room pointer enters task text.
- [ ] Every exact input is read through complete continuation.
- [ ] Workers have no durable-memory capability.
- [ ] Compaction recovery uses prose + exact refs without broad discovery.
