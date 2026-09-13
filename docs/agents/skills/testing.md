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
17. For the storage-only child-call boundary, use one project-bound concrete `ArtifactStore` and
    checkpointer. Prove canonical codec/readback, exact artifact custody before mutation, one atomic
    parent-suspension/reservation/ordinary-child creation, transaction rollback, exact duplicate
    adoption, changed-operand conflict, fresh-process readback, no synthetic linkage, lifecycle
    compare-and-set, schema-version refusal/migration, and store-level parent/child run pins.
18. Keep runtime child claims out of storage-only tests. Active dispatch, native terminal
    acceptance/consumption, capacity/refusal, inactivity expiry, and runner-signal or durable-parent
    cancellation require their own real engine/runner tests. Active contract tests also prove that
    predicted per-child resource allocations and aggregate/reserve fields are absent. Child-gate
    projection, arbitrary post-capture restart reconciliation, integrated artifact/receipt/session
    retention, promotion, and
    functional/live qualification remain separate unimplemented evidence areas.
19. Test the active runtime authority projection separately: exact all-six parent/provider coverage,
    default-deny absence/unknowns, native request/output binding, fixed tool and existing browser-
    network carriers, YAML-maximum snapshot drift refusal, registration-digest sensitivity,
    dedicated/private knowledge-base exclusion, worker refusal, and explicit Gate 2 `not_run`
    status. These tests make no provider call.

## Commands

```bash
bun run --cwd apps/orchestration typecheck
bun run --cwd apps/orchestration test
bun run --cwd apps/orchestration test:parity
bun run --cwd .pi/extensions/skill test:unit
bun run --cwd .pi/extensions/skill test:integration
bun run --cwd .pi/extensions/compaction test:unit
```

## Current child-workflow evidence boundary

`apps/orchestration/tests/child-workflows-storage.test.ts` is the focused child-call store suite. It
uses temporary local project partitions and no provider invocation. Its assertions cover the v12
V1/V2 call row/codec, atomic reservation and rollback, adopt-or-conflict identity, artifact-only and
corrupt state refusal, fresh-process durable readback, lifecycle compare-and-set without consumption,
store-level run retention, exact v11 V1-row migration, and old/current/unknown schema handling.

`apps/orchestration/tests/child-workflows-authority.test.ts` is the focused runtime-authority suite.
It verifies the exact active all-six policy/provider projection, native provider validation, fixed
phase tool/network carriers, digest sensitivity, knowledge-base exclusion, and direct worker
refusal. `apps/orchestration/tests/child-workflows-runtime.test.ts` separately proves the active owner
runs a real registered child through the existing engine/runner, consumes one exact core once,
resumes the parent without granting parent success, enforces project-wide admission, expires a silent
child, and records both signal and durable parent cancellation without a late resume. Neither suite
runs a live provider or supplies Gate 2 evidence.

`apps/orchestration/smoke/child-workflow-model-smoke.test.ts` is a separate, opt-in local-model
smoke. `PENNY_CHILD_WORKFLOW_MODEL_SMOKE=1` runs one disposable active parent/child fixture and
pins every child worker session to the Ollama model selected by
`PENNY_CHILD_WORKFLOW_MODEL_SMOKE_MODEL` (default `qwen3.8:latest`); it asserts dispatch, exact
resolved model identity, terminal-core acceptance, one consumption event, and an incomplete parent
that does not claim success. The smoke is fail-closed and does not promote a provider, grant
discovery, or by itself constitute Gate 2 qualification evidence.

## Required coverage

- [ ] State vocabulary and state/agent bindings
- [ ] Closed skill and request contracts
- [ ] Direct/default YAML equality plus registration-bound strict-subset authority
- [ ] Happy paths and honest negative terminals
- [ ] Bounded repair and stall/exhaustion behavior
- [ ] Every declared planned gate and unplanned escalation route
- [ ] Exact artifact revisions and signed receipts
- [ ] Restart and compaction recovery
- [ ] Parallel branch identity and concurrency bounds
- [ ] Direct cross-run terminal-ID handoff plus additional explicit fan-in IDs
- [ ] Cancellation and dispatch pause
- [ ] Active all-six generic-child authority is digest-bound and default-deny; Gate 2 stays unrun
- [ ] Storage-only child reservation/adoption/rollback/schema/retention boundaries stay distinct
      from active dispatch/acceptance/cancellation and from unimplemented gates, restart
      reconciliation, measured settlement, cohort retention, promotion, and live qualification
- [ ] Package surface and clean pack
