# Prompt Layer Architecture — Exact tools and artifact communication

## Layers

| Layer              | Function                                         | Source              |
| ------------------ | ------------------------------------------------ | ------------------- |
| Cognitive Frame    | Stable operating policy                          | `.pi/SYSTEM.md`     |
| Role Definition    | Catalog role and YAML maximum authority          | `.pi/agents/*.md`   |
| Canonical Docs     | Bound reusable standards                         | `docs/agents/**`    |
| Domain Guidance    | Static task-family criteria and SUMMARY contract | skill prompt assets |
| Project Index      | Typed advisory routing                           | `AGENTS.md`         |
| Invocation Context | Current goal, constraints, IDs, paths            | runtime task        |

## Worker assembly

1. Transform the Cognitive Frame for a worker and strip parent-only protocols.
2. Read the catalog Role Definition, or select the anonymous private-worker posture.
3. Resolve contract-declared Canonical Docs to exact paths and content digests.
4. Inject bound Canonical Docs and registered Domain Guidance before literal `<agent_boundary>` for catalog workers; private workers receive the same bound docs followed by private phase guidance without a catalog role.
5. Append the canonical Project Index, finalize one system boundary, and keep the current task plus caller-selected context below it.
6. Load every provider extension and preflight declared names. Direct/parallel/chain
   invocation activates YAML exactly. A TypeScript orchestration phase activates YAML when
   its active registration omits a subset, or its one canonical-registration-bound strict
   YAML subset when present.

The CLI runner, SDK skill workers, and anonymous private KB workers share one prompt
composer. The transformed frame, role body (without YAML), digest-bound canonical docs,
registered domain guidance, and canonical Penny root `AGENTS.md` are system-role content.
Missing, empty, malformed, symlink-escaping, or digest-drifted baseline sources fail before
model execution; no path falls back to Pi's default prompt. Domain guidance remains before
`<agent_boundary>` and one `<system_boundary>` is last. Ambient ancestor/global context and
append-system files are excluded. An explicitly selected different task cwd may contribute
its `AGENTS.md` only as subordinate task material. Direct `skillContext`, task text, exact
IDs, and dynamic invocation data stay in the task message. Anonymous host-private KB
sessions use the same baseline composer without claiming a catalog role and retain their
separate closed tool policy.

Prompt markers are parsing aids. Runtime tool equality, approvals/receipts, and OS/container
permissions are the control plane.

## Exact communication

Invocation Context may supply `input_artifacts`: unique exact IDs from any run. Owner code
verifies manifest existence and bytes before model use. Workers read needed IDs with
`artifact_read` and `next_range`, return complete stage content, and append the Domain
Guidance's routing-only `SUMMARY`.

Owner code persists and re-reads exact assistant bytes before parsing SUMMARY or returning
success. No runtime result tool or conditional artifact tool is injected. Payload bytes,
memory room pointers, name-only predecessors, and model-authored persistence claims are
forbidden.

Workers may hold YAML-declared read-only memory tools for advisory recall. Recall is never
transport: a required predecessor without an exact ID/path produces `missing_input:`.

## Recovery

Checkpoints retain compact refs. Compaction carries only code-proven current-session
subagent/skill refs, explicitly reused IDs, and a prior exact index. Large sets become one
immutable handoff-index ID. It never scans global manifests or semantic memory.

## Compliance

- [ ] YAML `tools:` is a non-empty, duplicate-free, provider-known maximum and equals its
      static profile expansion.
- [ ] Direct/parallel/chain invocation and subset-absent orchestration activate exact YAML.
- [ ] Only an active TypeScript orchestration registration may bind one non-empty,
      duplicate-free strict YAML subset into its canonical digest and worker metadata; task,
      trust, input, runtime, liveness, model, and service state cannot select it.
- [ ] Subset claims do not imply OS/process sandboxing or extension-code isolation;
      host-private tools remain separate.
- [ ] Contract-declared Canonical Docs resolve under approved roots, preserve order, and bind content digests into active registration metadata.
- [ ] Domain Guidance defines complete output and one closed final SUMMARY line.
- [ ] Caller-selected context remains below the final system boundary.
- [ ] Inputs are exact IDs/paths, not payloads or semantic pointers.
- [ ] Persistence/re-read precedes routing and success.
- [ ] Missing predecessors produce `missing_input:` rather than discovery.
