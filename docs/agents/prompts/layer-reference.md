# Prompt Layer Reference

| Layer              | Owns                                                                    | Must not own                                                    |
| ------------------ | ----------------------------------------------------------------------- | --------------------------------------------------------------- |
| Cognitive Frame    | Stable identity, trust/action boundaries, completion, memory discipline | Domain criteria, paths, detailed handoff mechanics              |
| Role Definition    | Capability role, consequence/evidence contract, YAML tool maximum       | Domain checklists, orchestration phase subsets, workflow state  |
| Domain Guidance    | Static task-family criteria and closed SUMMARY shape                    | Agent identity, dynamic values, permission/tool selection       |
| Project Index      | Typed routes, paths, and supplied-knowledge clauses                     | Standards prose or enforcement                                  |
| Invocation Context | Current goal, constraints, exact IDs/paths                              | Tool changes, payload transport, semantic predecessor discovery |

## Tool direction

YAML `tools:` is the maximum ordinary catalog authority and still equals its profile
expansion exactly. Direct/parallel/chain invocation and TypeScript orchestration phases
without `allowed_tools` activate that list exactly. One eligible orchestration phase may
instead bind a non-empty duplicate-free strict YAML subset in its active canonical
registration and worker invocation metadata.

No prompt layer owns that exception. Lower prompt layers may describe which already-active
tools are useful, but cannot add, remove, suppress, replace, or conditionally select them.
Task, trust profile, input, model, liveness, runtime, and optional-service state have no tool
selection authority. A phase subset does not mutate the Role Definition or profiles.

## Artifact handoff

Owner/runtime metadata supplies unique exact artifact IDs from any run. Workers read needed
IDs with `artifact_read` plus `next_range`, return complete stage content, and append only
the Domain Guidance SUMMARY. Owner persistence and byte-for-byte re-read precede routing.

Artifacts are task material and communication addresses, not authority. `RunContext`
retains refs rather than payloads. Parallel branches are labeled; chain steps receive the
prior ID automatically and can add explicit fan-in IDs.

## Component map

| Component            | Responsibility                                                                                       |
| -------------------- | ---------------------------------------------------------------------------------------------------- |
| Subagent runner      | Catalog snapshot, prompt assembly, exact YAML CLI surface, input preflight, mandatory output capture |
| Artifact extension   | Direct manifest lookup, digest/range verification, bounded non-expiring reads                        |
| Skill extension      | Exact terminal IDs, checkpoints, composition, communication verification                             |
| Orchestration engine | State, contracts, refs, registration/digest-bound phase subsets, recovery, terminal truth            |
| Memory extension     | Advisory durable recall; never workflow handoff                                                      |
| Compaction extension | Prose plus exact current-session refs/handoff index                                                  |

## Verification

- [ ] Direct/parallel/chain catalog paths assert exact YAML equality.
- [ ] Orchestration asserts exact YAML when a subset is absent and accepts only a canonical-
      registration-bound strict subset when present; invalid selections fail before session.
- [ ] Ordinary candidate phases omit `allowed_tools` and use exact YAML; synthetic or
      evaluation-only strict subsets make no OS/process sandbox or extension-code isolation
      claim, and host-private tools remain separate.
- [ ] Required predecessors are exact IDs/paths; absent inputs yield `missing_input:`.
- [ ] Memory and global artifact scans never replace handoff.
- [ ] Output persistence/re-read precedes SUMMARY parsing and success.
