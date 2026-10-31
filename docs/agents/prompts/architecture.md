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
6. Preflight providers and activate tools under the
   [binding runtime rule](../agents/discovery-and-tools.md#binding-runtime-rule), including
   its guarded zero-tool exception. Prompt assembly cannot select or broaden authority.

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

[Invocation](../agents/invocation.md#task-contract) owns exact-ID transport, full range reads,
`missing_input:`, and capture/readback before routing. [Invocation Context Standards](invocation-context-standards.md#required-workflow-context)
owns task fields; [Role and Domain Standards](role-and-domain-standards.md#domain-guidance)
owns complete-output and conditional routing-SUMMARY obligations. Prompt assembly must not
substitute payload bytes, semantic memory pointers, or model-authored persistence claims.

## Recovery

Use [Invocation recovery and compaction](../agents/invocation.md#recovery-and-compaction).
The engine/checkpointer owns retained refs and admission; no prompt layer discovers missing
predecessors through memory or global artifact scans.

## Compliance

- [ ] [Runtime selection](../agents/discovery-and-tools.md#verification) and
      [capture/handoff](../agents/invocation.md#verification) satisfy their owners.
- [ ] Contract-declared Canonical Docs resolve under approved roots, preserve order, and bind
      content digests into active registration metadata.
- [ ] Domain Guidance defines complete output and, for a registered cognitive phase, one
      closed final SUMMARY line or the explicit versioned registration-owned host-projection
      exception in [Role and Domain Standards](role-and-domain-standards.md#domain-guidance).
      Ordinary role output adds SUMMARY only when defined.
- [ ] Caller-selected context remains below the final system boundary.
- [ ] No claim of OS/process sandboxing or extension-code isolation follows from tool selection;
      anonymous host-private tool matrices remain separate.
