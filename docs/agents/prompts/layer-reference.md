# Prompt Layer Reference

| Layer              | Owns                                                                    | Must not own                                                    |
| ------------------ | ----------------------------------------------------------------------- | --------------------------------------------------------------- |
| Cognitive Frame    | Stable identity, trust/action boundaries, completion, memory discipline | Domain criteria, paths, detailed handoff mechanics              |
| Role Definition    | Capability role, consequence/evidence contract, exact YAML `tools:`     | Domain checklists, runtime tool narrowing, workflow state       |
| Domain Guidance    | Static task-family criteria and closed SUMMARY shape                    | Agent identity, dynamic values, permission/tool changes         |
| Project Index      | Paths and one-line descriptions                                         | Standards prose                                                 |
| Invocation Context | Current goal, constraints, exact IDs/paths                              | Tool changes, payload transport, semantic predecessor discovery |

## Tool direction

YAML `tools:` is not a maximum or minimum; it is exact. Lower prompt layers may guide which
visible tools are useful but cannot add, remove, suppress, replace, or conditionally expose
them. Profiles statically lint the list only.

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
| Orchestration engine | State, contracts, refs, recovery, terminal truth                                                     |
| Memory extension     | Advisory durable recall; never workflow handoff                                                      |
| Compaction extension | Prose plus exact current-session refs/handoff index                                                  |

## Verification

- [ ] Every production catalog-agent path asserts active tools equal YAML.
- [ ] Required predecessors are exact IDs/paths; absent inputs yield `missing_input:`.
- [ ] Memory and global artifact scans never replace handoff.
- [ ] Output persistence/re-read precedes SUMMARY parsing and success.
