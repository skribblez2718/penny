# Skill Testing — TypeScript playbook requirements

## What

Every registered playbook is driven against temporary Node SQLite checkpoints and immutable
artifact roots. Tests assert directives, state transitions, gates, receipts, exact refs,
recovery, and terminal truth without invoking production models.

## Rules

1. Use an isolated temporary checkpointer and artifact root.
2. Drive closed `start`/`step`/`respond`/`recover` requests through the real engine.
3. Use deterministic `ModelClient` fixtures or pre-built signed `PhaseResult` values.
4. Assert the returned directive, state, exact input selection, and output metadata.
5. Cover every happy edge, repair, gate decision, negative terminal, and exhaustion route.
6. Prove owner persistence and receipt validation happen before routing.
7. Prove wrong-run/state/branch/producer/consumer refs fail closed.
8. Cover crash recovery and partial parallel fan recovery.
9. Cover generic single, parallel, chain, chain-resume, cancellation, and recovery composition.
10. Prove typed imports fail before run/model creation on stale refs, wrong kind/version/schema,
    ambiguity, missing ports, missing validators, envelopes-for-cores, or corrupt bytes.
11. Prove unified-root packages are discovered once. Every model-invocable orchestration package
    requires a matching executable registration; a model-disabled development package may remain
    unregistered and generic invocation must fail safely. Model-visible manifests omit
    `disable-model-invocation`; hidden manifests declare it exactly as `true`, never redundant
    `false`. Pi native and Penny listings include every visible package, and `.ignore` exactly mirrors
    explicit model disablement. Reject a top-level `license` in every Penny skill manifest.
12. Prove memory absence does not alter correctness.
13. Prove direct catalog paths and subset-absent orchestration phases use exact YAML equality.
14. Prove a phase subset exists only in an active `PlaybookRegistrationV1`, changes its
    canonical runtime-registration digest, reaches worker invocation metadata unchanged, and is
    passed exactly to Pi. Reject empty, duplicate, additive, replacement, equality-sized,
    unavailable, and task/trust/runtime-selected lists before session creation.
15. Pin every ordinary registered phase with absent `allowed_tools` and exact agent YAML. Keep
    synthetic registration-bound strict-subset coverage without OS/process sandbox or
    extension-code-isolation claims, and keep anonymous host-private tools separate.
16. Keep live-model tests separate and use caller model overrides rather than changing agent SSOT.

## Commands

```bash
bun run --cwd apps/orchestration typecheck
bun run --cwd apps/orchestration test
bun run --cwd apps/orchestration test:parity
bun run --cwd .pi/extensions/skill test:unit
bun run --cwd .pi/extensions/skill test:integration
bun run --cwd .pi/extensions/compaction test:unit
```

## Required coverage

- [ ] State vocabulary and state/agent bindings
- [ ] Closed skill and request contracts
- [ ] Direct/default YAML equality plus registration-bound strict-subset authority
- [ ] Happy paths and honest negative terminals
- [ ] Bounded repair and stall/exhaustion behavior
- [ ] Planned and unplanned human gates
- [ ] Exact artifact revisions and signed receipts
- [ ] Restart and compaction recovery
- [ ] Parallel branch identity and concurrency bounds
- [ ] Direct cross-run terminal-ID handoff plus additional explicit fan-in IDs
- [ ] Cancellation and dispatch pause
- [ ] Package surface and clean pack
