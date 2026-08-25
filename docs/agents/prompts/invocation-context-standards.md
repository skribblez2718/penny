# Invocation Context Standards — Current task and exact IDs

Invocation Context supplies the goal, request constraints, runtime identifiers, exact
artifact IDs, and caller-specified paths. It cannot alter system policy, consequence
boundaries, or the catalog agent's exact YAML tools.

## Required workflow context

- specific goal and material constraints;
- run/state/branch identity when routing needs it;
- `input_artifacts`: a unique exact-ID set, including an empty set when appropriate;
- output/routing contract for cognitive stages;
- clarification text when resuming.

IDs may come from any run/session/agent/branch. Owner code performs exact manifest lookup
and digest/length verification before model use. Task text may name IDs but never carries
predecessor payload bytes as transport.

Workers call `artifact_read` for each needed ID and repeat with `next_range` until
complete. Model text cannot list, search, guess, mint, or authorize artifacts.

## Forbidden patterns

- memory room/drawer pointers or semantic queries for predecessor output;
- retrieved memory injected as workflow transport;
- a model-authored ref treated as persistence proof;
- predecessor payload substituted into `{previous}`;
- name-only references such as “the Annie review”;
- dynamic variables in static Domain Guidance;
- runtime-added/removed tools.

If a required predecessor ID/path is absent, return `missing_input:` rather than searching
memory, `/tmp`, the repository, or historical artifacts.

## Continuation and compaction

Reads use explicit UTF-8 byte ranges. `next_range` is non-expiring. After compaction,
prose is the primary orientation; `[RESUME-REFS v2]` carries only exact code-proven
current-session refs or one handoff-index ID. Never replace missing refs with semantic
search.

## Verification

- [ ] Goal/constraints are explicit.
- [ ] Inputs are unique exact IDs from owner/runtime metadata.
- [ ] All inputs preflight before model usage.
- [ ] No predecessor payload or semantic pointer enters task text.
- [ ] Complete output is persisted/re-read before routing.
