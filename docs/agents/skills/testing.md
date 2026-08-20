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
9. Cover single, parallel, chain, and chain-resume composition.
10. Prove memory absence does not alter correctness.
11. Keep live-model tests separate and use caller model overrides rather than changing agent SSOT.

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
- [ ] Prompt-surface equality
- [ ] Happy paths and honest negative terminals
- [ ] Bounded repair and stall/exhaustion behavior
- [ ] Planned and unplanned human gates
- [ ] Exact artifact revisions and signed receipts
- [ ] Restart and compaction recovery
- [ ] Parallel branch identity and concurrency bounds
- [ ] Chain target-run ingress artifacts
- [ ] Cancellation and dispatch pause
- [ ] Package surface and clean pack
