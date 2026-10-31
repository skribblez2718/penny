# Prompt Layer Reference

| Layer              | Owns                                                                    | Must not own                                                    |
| ------------------ | ----------------------------------------------------------------------- | --------------------------------------------------------------- |
| Cognitive Frame    | Stable identity, trust/action boundaries, completion, memory discipline | Domain criteria, navigation paths, detailed handoff mechanics   |
| Role Definition    | Capability role, consequence/evidence contract, YAML tool maximum       | Domain checklists, orchestration phase subsets, workflow state  |
| Canonical Docs     | Bound reusable standards with verified paths and content digests        | Dynamic task values or permission/tool selection                |
| Domain Guidance    | Static task-family criteria and closed SUMMARY shape                    | Agent identity, dynamic values, permission/tool selection       |
| Project Index      | Typed routes, paths, and supplied-knowledge clauses                     | Standards prose or enforcement                                  |
| Invocation Context | Current goal, constraints, exact IDs/paths                              | Tool changes, payload transport, semantic predecessor discovery |

## Tool direction

[Discovery and Tools](../agents/discovery-and-tools.md#binding-runtime-rule) owns runtime
selection, including the guarded zero-tool exception. [Profiles](../agents/tool-profiles.md#rules)
owns static YAML expansion. No prompt layer selects tools; lower layers may only describe
uses of already-active tools, never add, remove, suppress, replace, or conditionally select them.

## Artifact handoff

[Invocation](../agents/invocation.md#task-contract) owns exact-ID handoff and capture/readback;
[Invocation Context](invocation-context-standards.md#required-workflow-context) owns task
fields. Artifacts are communication addresses and task material, not authority. Memory
remains advisory recall, never workflow transport.

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

- [ ] Resolve rule questions through the linked owners, not a second copy of their contracts.
- [ ] Runtime selection, output capture, and prompt assembly retain separate owners.
- [ ] The selected surface is not described as OS/process sandboxing or extension-code isolation;
      anonymous host-private tool matrices remain separate.
