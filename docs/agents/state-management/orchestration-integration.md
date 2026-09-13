# Orchestration Integration — TypeScript playbooks

## Model

Every workflow skill is a registered `PlaybookCoreV1` implementation. The skill extension
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

| Layer                    | Responsibility                                                                                                        |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| Skill manifest/resources | Discovery, prompts, durable domain reference                                                                          |
| Playbook                 | State vocabulary, input selection, gap classification, domain bookkeeping, gates, terminal result                     |
| Registration             | Required guidance, state/agent/result contracts, optional fixed phase subsets, repair routes, completion gate         |
| Engine                   | Contract/digest checks, repair budgets/transitions, checkpoints, receipts, recovery, completion admission             |
| Worker                   | Registration binding, exact input reads, YAML/default or strict-subset tools, and complete stage output               |
| ArtifactStore            | Immutable bytes, lineage metadata, versions, and direct exact-ID reads                                                |
| Child state owner        | Concrete project-bound artifact custody plus atomic parent suspension/call/ordinary-child reservation and consumption |
| Child runtime owner      | Active depth-one dispatch, terminal-core revalidation, parent continuation, lease enforcement, and cancellation       |

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
7. A structurally valid gap returns content-only `EvaluationResultV2`; it cannot select a
   state or exhaustion result. Registered routes and engine-owned finite budgets determine both.
8. Repair bookkeeping cannot mutate state ID/history, step count, pending/terminal directives,
   status, or `met`; route events contain digests and counters only.
9. Structural malformed results use the separate bounded P1.2 routing-repair path.
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
17. Lifecycle compare-and-set and store-level retention are implemented. The explicit candidate
    runtime owner alone may use the separate atomic consume method: it validates a durable child
    terminal and writes the parent continuation plus `consumed` marker in one transaction. Every
    child named by a call row is pinned, and a parent is pinned while a linked call is not consumed.
    This does not establish artifact-cohort, receipt, or catalog-session retention.
18. Active depth-one child dispatch drives the existing child engine and runner rather than a
    worker-result seam. A normal service constructs the owner; `enableChildWorkflows: false`
    explicitly disables it. The owner rechecks registration/native request authority, reserves the
    active/project admission, then lets the child use its registered repair/liveness policy and the
    service-wide step backstop without a predicted per-call resource allocation. It captures the
    exact terminal product and forwards runner-signal or concurrent durable parent cancellation.
    Child gates, arbitrary post-capture restart reconciliation, cohort retention,
    qualification/promotion, and live evidence remain outside this path; Gate 2 remains `not_run`.
19. Schema v12 creation occurs only through explicit provisioning. Retained active-project upgrades
    occur only through `penny-state upgrade` after non-mutating inspection, project/artifact/key
    validation, an owner-only administrative lock, and a verified external pre-upgrade SQLite backup.
    All 10/11→12 steps share one exclusive transaction; no call rows are inferred. The v11→v12 step
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

## Verification

- [ ] Playbook is registered; active worker phases, guidance, optional tool subsets, repair
      routes, canonical registration digest, and completion contract validate.
- [ ] Subset-absent phases activate exact YAML; any present subset is one non-empty,
      duplicate-free strict YAML subset copied into invocation metadata and passed exactly to Pi.
- [ ] Empty/duplicate/equality-sized/non-YAML or task/trust/runtime-selected declarations fail
      before session creation; active removal/addition/replacement fails before the model prompt,
      and host-private tools remain separate.
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
- [ ] Store retention keeps unsettled parents and every child that still has a linked call row,
      without claiming integrated artifact/receipt/session cohort retention.
- [ ] Storage checks do not stand in for dispatch, result acceptance, cancellation/gate,
      active-registry authority, or live-qualification evidence.
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
