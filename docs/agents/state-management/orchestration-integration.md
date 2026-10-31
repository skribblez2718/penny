# Orchestration Integration — TypeScript playbooks

## Model

Every workflow skill is a registered `PlaybookCore` implementation. The skill extension
constructs `OrchestrationService` in-process; skill directories contain no runtime.

```text
skill tool
  → OrchestrationService
    → closed request
    → playbook directive
    → Pi SDK worker / host gate
    → immutable artifact + signed receipt
    → checkpointed transition
```

## Responsibilities

| Layer                    | Responsibility                                                                                                         |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| Skill manifest/resources | Discovery, prompts, durable domain reference                                                                           |
| Playbook                 | State vocabulary, input selection, gap classification, domain bookkeeping, gates, terminal candidates                  |
| Registration             | Required guidance, state/agent/result contracts, optional fixed phase subsets, repair routes, completion gate          |
| Engine                   | Contract/digest checks, repair budgets/transitions, checkpoints, receipts, recovery, completion admission              |
| Worker                   | Registration binding, exact input reads, YAML/default or strict-subset tools, and complete stage output                |
| ArtifactStore            | Immutable bytes, lineage metadata, versions, and direct exact-ID reads                                                 |
| Child state owner        | Concrete project-bound artifact custody plus atomic parent suspension/call/ordinary-child reservation and consumption  |
| Child runtime owner      | Active depth-one dispatch, terminal-core revalidation, parent continuation, lease enforcement, and cancellation        |
| Host state owner         | Project-bound artifact custody, canonical host-operation journal CAS, and atomic parent/result consumption             |
| Host runtime owner       | Registered async adapter dispatch, bounded output persistence, cancellation/recovery, and global fenced backend leases |

## Requests

- `start`: create one exact-run checkpoint and emit the first directive.
- `step`: accept one signed phase result and route.
- `respond`: answer the exact pending gate challenge.
- `recover`: reissue pending work from the checkpoint.
- `status`: return a safe state projection.
- `cancel`: terminate without pretending completion.

## Rules

1. Run identity is immutable and TypeScript-owned.
2. Control state lives only in the Node SQLite checkpoint.
3. Every worker assignment has closed input and output artifact contracts.
4. Owner capture and receipt validation precede routing.
5. Playbook data is bounded JSON; product bytes remain in artifacts.
6. Gates and escalation emit `await_user`; only `respond` can continue them.
7. A structurally valid gap returns content-only `EvaluationResult`; it cannot select a
   state or exhaustion result. Registered routes and engine-enforced actual operator policy determine both; absent limits do not imply a finite default.
8. Repair bookkeeping cannot mutate state ID/history, step count, pending/terminal directives,
   status, or `met`; route events contain digests and counters only.
9. Structural malformed results use the separate separate P1.2 routing-repair path.
10. Recovery is exact-run, idempotent, and memory-independent.
11. Composition verifies and forwards exact predecessor IDs directly across runs.
12. Every new `complete/status=complete/met:true` candidate passes the one engine-owned
    admission helper, including start, step, generic/host continuation, direct-host
    checkpoint, and replay verification paths.
13. Admission uses append-only visits and existing receipt/evidence indexes. It does not
    use `previousState`, observability, memory, a new state path, or a schema migration.
14. The child-call owner mints custody only from one concrete `ArtifactStore`. The checkpointer
    matches its project binding to the control store and verifies the canonical
    request and every input manifest ref/object byte before mutation.
15. One `BEGIN IMMEDIATE` transaction binds the exact parent visit and pending child directive,
    creates the ordinary unstarted child run and initial event, inserts the canonical call row,
    and records the reservation event. Failure rolls back the parent suspension, child, call, and
    events together.
16. Child logical identity is adopt-or-conflict. Exact immutable operands adopt the existing
    record and current lifecycle; changed operands, artifact-only state, an unpaired child run, or
    missing/mismatched run, registration, project, trust, or visit linkage fails closed. Recovery
    never synthesizes linkage, registration digests, artifact refs, or visit coordinates.
17. Lifecycle compare-and-set belongs to storage; the active runtime validates a captured durable
    terminal and atomically commits parent continuation plus `consumed`. The transaction rechecks
    the pending parent and source snapshot; cancellation or changed selections cannot be overwritten.
18. Active depth-one dispatch drives the child engine/runner, not a worker-result seam. A normal
    service constructs the owner; `enableChildWorkflows: false` disables it. Fixed call/active/project
    admission, registered repair/liveness and any operator-supplied service step limit apply without predicted
    child allocations. Exact projected gates/replies, waiting/captured-terminal recovery and linked
    control/gate/receipt/session retention are implemented separately from storage-only checks; see
    the [engine status owner](../orchestration/overview.md#child-workflow-feature-status).
    Unconsumed work/custody/quarantined effects hold cohorts; safe cleanup preserves immutable
    artifacts. Provider promotion/live qualification remain separate; Gate 2 stays `not_run`.
19. Schema v13 creation occurs only through explicit provisioning. Retained active-project upgrades
    occur only through `penny-state upgrade` after non-mutating inspection, project/artifact/key
    validation, an owner-only administrative lock, and a verified external pre-upgrade SQLite backup.
    All 10/11/12→13 orchestration steps share one exclusive transaction; no call or operation rows are inferred. The v11→v12 step
    preserves exact canonical V1 rows while admitting V2 rows. Retained-call migration requires
    artifact manifest/object units and verifies their exact refs. Unsupported, unversioned, newer,
    malformed, or ambiguously bound stores refuse. Ordinary runtime and repeated `init` never mutate
    incompatible retained state.
20. New child execution uses the active schema-v3 directive and durable V2 call contract with no
    predicted turn/tool/external/output/step/time allocation, aggregate capacity, or parent reserve.
    It binds an exact content-free inactivity-lease/calibration profile and fenced
    owner/attempt/session coordinates. Monotonic host-observed worker activity and workflow
    convergence renew one interval; stale/empty signals refuse and lease expiry aborts the child.
    Schema-v2 directives and V1 rows remain exact legacy replay inputs and are not minted.
21. `invoke_host_operation` remains an internal closed directive. Only the runner delegates it to
    `HostOperationRuntimeOwner`; `WorkerExecutor` has no host-operation branch. Registration fixes
    the adapter, request/result contracts, backend binding, capabilities, lease/inactivity policy, and
    all byte/event limits. Directive or adapter projections that diverge fail closed.
22. The project operation journal uses immutable logical operands and canonical-record lifecycle CAS.
    The catalog-global FIFO/lease authority serializes one backend key across projects with lease
    epochs and fencing-token digests. Pre-submission stale takeover is allowed; guarded or accepted
    ambiguity quarantines and has no automatic expiry or takeover.
23. Full remote correlation IDs remain only in the owner-only project journal. Global state, events,
    progress, observability, standard results, and receipts receive correlation digests. Output
    bodies remain artifacts and are exact-read before `persisted → verified`.
24. Host-operation recovery adopts only the exact journal, fence, correlation proof, and pre-journaled
    deterministic artifact coordinates. Global lease disposition precedes project settlement. The
    engine verifies settled artifacts, then one project transaction writes the ordinary playbook
    continuation and `settled → consumed` marker.
25. Caller cancellation and inactivity expiry never imply remote cancellation. Queued/pre-submit
    work can release; submitting ambiguity quarantines; accepted work releases only after registered
    terminal proof. Queue wait has a finite admission expiry. After acquisition, substantive adapter
    activity and durable work/output milestones renew the operation-inactivity lease; periodic
    backend-lease renewal alone does not. Transport stalls and post-cancellation cleanup have
    separate bounds. Productive execution has no total-duration cutoff.

Shared transport/capture follows [Invocation](../agents/invocation.md); this guide owns only
state integration deltas. [Testing](../skills/testing.md#required-coverage) owns the evidence matrix.

## Verification

- [ ] Playbook is registered; active worker phases, guidance, optional tool subsets, repair
      routes, canonical registration digest, and completion contract validate.
- [ ] Apply the [binding runtime rule](../agents/discovery-and-tools.md#binding-runtime-rule):
      subset-absent YAML equality, real registered strict subsets (including SCA), exact Pi handoff,
      and invalid/dynamic pre-session refusal. The guarded zero-tool exception must retain its
      exact model/payload/disclosure/final-opening checks. Profiles own static maxima; tool
      subsets do not provide OS/process or extension-code isolation; host-private matrices stay separate.
- [ ] Start/step/respond/recover/cancel all fail closed on wrong identity.
- [ ] Missing/corrupt input IDs are rejected before worker use; cross-run fan-in succeeds.
- [ ] Crash and partial-fan recovery preserve exact refs.
- [ ] Gate payload/challenge binds the response.
- [ ] Positive terminals satisfy closed `CompletionGate` v2 origin, visit, product,
      receipt-predicate, and unresolved-policy checks.
- [ ] A failed positive is durable `incomplete/met:false`, preserving its artifacts and
      refusal codes; negative terminals remain reachable from arbitrary states.
- [ ] `status`/`recover` verify post-v2 envelopes and exact legacy positives remain replayable.
- [ ] Exact duplicate child reservation adopts the current lifecycle; changed immutable operands,
      noncanonical/digest-divergent rows, and ref/byte mismatch fail before control-state mutation.
- [ ] Reservation failure leaves no parent suspension, child run, call row, or event.
- [ ] Linked control/gate/receipt cohorts and correlated catalog sessions remain together while
      held; eligible eviction and safe session cleanup preserve immutable artifact objects.
- [ ] Storage checks do not stand in for dispatch, result acceptance, cancellation/gate,
      active-registry authority, or live-qualification evidence.
- [ ] Registered host-operation authority rejects drift; owner/adapter absence is stable and closed;
      direct engine recovery performs no effect; and workers refuse the directive.
- [ ] Happy path, restart adoption, deterministic output recovery, cancellation/timeout phases,
      cross-project FIFO contention, stale fencing, quarantine blocking, and inspected reset are tested.
- [ ] Host-operation events, progress, receipts, global state, and observability remain bounded and
      body-free; only the project journal may retain a full remote correlation ID.
- [ ] Active-project schema upgrade is backup-first, project-bound, exclusive, atomic across all
      schema steps, rollback-tested after intermediate DDL, and a no-op on the current version.
- [ ] Stale-state diagnostics preserve the root schema version and recovery action across skill,
      subagent, artifact, compaction, and knowledge-base entrypoints without exposing private paths.

## Files

- `apps/orchestration/src/service.ts`
- `apps/orchestration/src/engine.ts`
- `apps/orchestration/src/playbooks/playbook.ts`
- `apps/orchestration/src/playbooks/registry.ts`
- `apps/orchestration/src/checkpointer.ts`
- `apps/orchestration/src/state/upgrade.ts`
- `apps/orchestration/src/artifact-store.ts`
- `apps/orchestration/src/child-workflows/storage.ts`
- `apps/orchestration/src/child-workflows/owner.ts`
- `apps/orchestration/src/host-operations/contracts.ts`
- `apps/orchestration/src/host-operations/storage.ts`
- `apps/orchestration/src/host-operations/lease-authority.ts`
- `apps/orchestration/src/host-operations/owner.ts`
