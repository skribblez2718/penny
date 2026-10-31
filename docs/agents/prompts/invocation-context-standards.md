# Invocation Context Standards — Current task and exact IDs

Invocation Context supplies the goal, request constraints, runtime identifiers, exact
artifact IDs, and caller-specified paths. It cannot alter system policy, consequence
boundaries, the catalog agent's YAML maximum, or an active registration-bound orchestration
phase subset.

## Required workflow context

- specific goal and material constraints;
- run/state/branch identity when routing needs it;
- `input_artifacts`: a unique exact-ID set, including an empty set when appropriate;
- output/routing contract for cognitive stages;
- clarification text when resuming.

For substantial delegated work, apply the [Bounded Work task contract](../agents/bounded-work.md#task-contract): identify one outcome, sufficient inputs and satisfied prerequisites, change boundaries, outputs and acceptance evidence, and a conservative context-fit assessment. Supply these through the active interface, not invented tool parameters or SUMMARY fields. Keep straightforward work direct; not every invocation needs a task graph.

IDs may come from any run/session/agent/branch. Task text names exact IDs, never predecessor
payload bytes. [Invocation](../agents/invocation.md#task-contract) owns preflight, full
UTF-8 range reads through `next_range`, `missing_input:`, and capture/readback. Model text
cannot list, search, guess, mint, or authorize artifacts.

## Forbidden patterns

- memory room/drawer pointers or semantic queries for predecessor output;
- retrieved memory injected as workflow transport;
- a model-authored ref treated as persistence proof;
- predecessor payload substituted into `{previous}`;
- name-only references such as “the Annie review”;
- dynamic variables in static Domain Guidance;
- runtime-, task-, input-, model-, liveness-, service-, or trust-selected tools.

Required predecessors must be supplied, not discovered through memory, `/tmp`, repository,
or historical-artifact search; apply Invocation's `missing_input:` outcome.

## Continuation and compaction

Keep exact IDs/paths in continuation context. [Invocation recovery](../agents/invocation.md#recovery-and-compaction)
owns the non-expiring range continuation and `[RESUME-REFS v2]`/handoff-index rules; prose
or semantic search must not reconstruct missing refs.

## Verification

- [ ] Goal/constraints and routing identity are explicit where needed.
- [ ] `input_artifacts` is a unique exact-ID set from owner/runtime metadata.
- [ ] No predecessor payload, semantic pointer, or tool-selection directive enters task text.
- [ ] [Invocation handoff checks](../agents/invocation.md#verification) cover preflight,
      complete reads, missing inputs, and persistence/readback before routing.
