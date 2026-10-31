# Registered Asynchronous Host Operations

Penny has a generic owner for bounded host work that may wait, poll, or outlive one synchronous engine call. Examples include a registered local service or an atomic publication step. The platform mechanism is intentionally domain-neutral: registrations supply every operation kind, adapter, artifact contract, backend binding, limit, and lease policy.

This owner is not a model tool, worker phase, child workflow, or synchronous host continuation. Models cannot select URLs, commands, filesystem roots, adapters, or lease policy. A playbook can emit only a closed `invoke_host_operation` directive derived from its active registration.

## Responsibility boundary

```text
checkpointed invoke_host_operation
  → OrchestrationRunner
  → HostOperationRuntimeOwner
      ├─ project journal and artifact custody
      ├─ state-root-global queue, fenced lease, and quarantine
      ├─ one registration-bound adapter
      └─ bounded artifact persistence and exact readback
  → engine prepares ordinary playbook dispatch
  → one transaction consumes the operation and checkpoints the parent
```

The engine remains synchronous and performs no external submit, polling, waiting, export, or cancellation call. `WorkerExecutor` accepts only agent directives. The runner is the sole dispatch path to the host-operation owner.

A service constructs this owner when the active host supplies an adapter map or explicitly opts into capacity enforcement. Capacity opt-in without adapters constructs an empty adapter map, not permission to execute. If no owner is installed, dispatch ends with `HOST_OPERATION_OWNER_UNAVAILABLE`. If the owner exists but the declared adapter is absent or its request binding disagrees, the owner records a stable no-effect failure rather than broadening authority.

## Registered authority

A playbook registration may carry `host_operations`. Each declaration freezes:

- the operation kind and adapter ID;
- exact request, operation-specific result, and adapter-output artifact contracts;
- a backend-binding ID and allowed capability classes;
- a fenced-lease profile, queue-inactivity interval, and renewable operation-inactivity interval;
- request, exact-input, output, progress, and retry bounds;
- an optional result-selection policy (`selected` by default) that persists each operation result, platform result, and receipt as the current revision of its coordinate, or, when `unselected`, persists them durably without selecting them so several per-item results of one kind can coexist under one state; and
- recovery and cancellation semantics.

The canonical declarations participate in the runtime registration digest only when `host_operations` is present. Existing registrations therefore retain their historical digests.

At dispatch, the owner verifies the exact pending directive, active registration digest, declaration digest, request ref and bytes, input refs, result and output contracts, policy projection, and adapter-derived backend-key digest. It reads only the directive-bound inputs, enforces their registered count and total bytes, and gives the adapter exact slot access. The adapter receives bounded callbacks, not general host or artifact-discovery authority.

## Two durable ownership scopes

The project orchestration database owns one canonical call journal. Its lifecycle is:

```text
prepared → lease_acquired → submitting → submitted → fetched
         → persisting → persisted → verified → terminal → settled → consumed
```

Transitions compare the record ID, current lifecycle, and full canonical record digest. Immutable request, registration, run, state, attempt, and operation operands cannot change on adoption. One non-consumed operation is allowed per run. Parent routing and `settled → consumed` commit together.

The state-root catalog owns backend-global coordination across projects and processes:

```text
queue: FIFO by queued time and operation ID
lease: free | active | quarantined
phase: pre_submission | submission_guarded | remote_accepted
```

Lease identity includes an epoch and fencing-token digest. A stale token cannot submit, renew, release, quarantine, or reconcile acceptance. Waiting never holds an open SQLite transaction.

## Submission and recovery safety

The adapter must obtain a submission guard before an external submit. Known remote acceptance is journaled with the full correlation ID in the owner-only project database; the global catalog, receipts, events, progress, and observability receive only its digest.

A stale pre-submission lease may be replaced because non-acceptance is proven. Once submission is guarded, ambiguous expiry quarantines the backend. A submitted operation may be adopted only by the same operation with the exact durable correlation proof. Quarantine has no automatic expiry or takeover.

An owner-only reset must compare the exact quarantine ID and record one inspected disposition: empty queue, explicitly drained queue, or specific remote terminal proof. Reset records retain evidence and queue-snapshot digests, not response bodies or full correlation IDs.

Artifact persistence is also journaled. Before writing, the owner records deterministic artifact coordinates and content digests. Recovery uses exact `ArtifactStore.refFor()` lookups and byte readback; it never scans broadly or treats an artifact alone as proof that the operation was accepted.

## Cancellation, timeout, and progress

Cancellation and timeout reflect what is known about the remote effect:

| Durable point      | Safe result                                                                                   |
| ------------------ | --------------------------------------------------------------------------------------------- |
| Queued or prepared | Remove the queue row; no remote effect                                                        |
| Lease acquired     | Release with proven non-acceptance                                                            |
| Submitting         | Remote outcome is unknown; quarantine                                                         |
| Submitted          | Invoke registered remote cancellation; release only with terminal proof, otherwise quarantine |
| Fetched or later   | Preserve durable evidence and settle without claiming success                                 |

Queue wait, active work, transport, and cleanup use different bounds. Queue ownership wait ends when its finite queue-inactivity interval expires. Once the owner acquires or exactly adopts the fence, trusted adapter activity and durable work/output milestones renew the ordinary operation-inactivity lease; that lease alone imposes no total elapsed cutoff. Backend lease renewal only preserves fencing; it does not prove operation progress. Each adapter transport separately bounds connect/read silence, and cancellation uses a bounded cleanup grace after cancellation starts rather than an execution deadline. Progress metadata remains bounded and append-only.

## Optional shared-capacity enforcement

A host may explicitly configure capacity enforcement for every operation driven by its owner. Construction reads an already installed immutable policy; it never installs policy or upgrades retained state. Without this opt-in, ordinary operation behavior and existing backend keys remain unchanged.

The owner verifies exact current demand on execution, restart and result replay, checks the reservation at adapter entry and immediately before submission, and requires final trusted measurements plus exact lease-disposition proof before consuming an admitted result. Missing measurements preserve the hold and block consumption. Ambiguous remote work remains quarantined; a backend reset cannot refund its capacity.

Queued work can now park without holding its backend or blocking that backend's FIFO. Parking atomically records exact never-submitted proof and frees the fence; it is not terminal release. The original capacity demand, order and deadlines remain unchanged. When capacity may fit, the owner rechecks current use authority, obtains a fresh fence and atomically checks all resources again before adapter entry. Epoch numbers may restart after a backend is freed; identity and token must match, not merely a larger number. Parked cancellation, timeout and crash recovery cannot release another owner's lease. Missing or conflicting proof refuses safely.

If current authority or demand changes just after reacquisition, proof-bound compensation
frees only that operation's still-live, never-admitted pre-submission fence. It preserves
the original parking record and uses an exact catalog event to repair the project journal
after a crash between stores. It cannot erase an admitted hold, undo guarded submission,
or free another owner's work.

An optional trusted host source can also report productive work before output retrieval. Its callback takes no counters or evidence from the adapter: the owner reads an exact immutable project artifact and checks its source, operation, request, fence, remote target and increasing actual work. Duplicate observations, polls, heartbeats, spend readings, empty input and late callbacks cannot renew activity through this path. Capacity inactivity, explicit elapsed/cost caps and bounded cleanup remain independent. Final trusted measurements and exact disposition proof still govern settlement.

New runtime records use a closed V2 wrapper in the existing schema-4 catalog. Existing V1 bytes replay unchanged and cannot acquire the new semantics implicitly; older binaries must refuse V2 rather than reinterpret it. No runtime schema upgrade or policy installation is added. These controls and provider-free tests do not qualify production collectors, physical GPU topology or exclusion of external jobs.

## Result acceptance

Every settled operation has three evidence classes:

1. an optional operation-specific result and bounded output artifacts;
2. a standard `HostOperationResultV1` platform envelope; and
3. a body-free `HostOperationReceiptV1` linked to the global lease-disposition receipt.

The engine re-reads and hashes those exact artifacts, checks the registered result contract and output bounds, adds their refs to parent evidence, clears the pending operation, and invokes ordinary playbook `dispatch()`. The checkpointer then commits that parent context and the consumed marker atomically. Operation completion is evidence for playbook routing; it does not by itself prove the parent workflow complete.

## Optional prepared effects and later result wrappers

A registration can opt into a request-before-intent protocol. The host derives one operation
identity from already selected inputs, writes the exact request, then writes the intent that
references it. Both exact refs must match the journal before dispatch. A crash leaving only one
link refuses safely instead of inventing the other.

A second opt-in records a result wrapper only after the raw output and existing owner receipt
are durable. The wrapper cites them; the earlier receipt never depends on that later wrapper.
Restart finishes or adopts the same wrapper without another remote submission. These are custody
checks, not approval, rights, media-quality or deployment proof; existing receipts gain no new
signature format.

Parent consumption also checks that current selections have not changed since preparation.
A concurrent cancellation or rights revocation cannot be overwritten by stale state. Retained
cross-run handoffs keep their producer's control and receipt evidence until the dependency can
safely be pruned. No new artifact garbage collector or automatic state upgrade is introduced.

## Operational note

The feature advances the project orchestration schema and uses state-root catalog schema 4. Retained v2/v3 catalogs require an explicit external SQLite backup, verified before catalog DDL under the global write lock. With writers stopped, `penny-state upgrade` performs that backup-first catalog step before the project-database upgrade. Fresh setup creates empty capacity tables, not policy; ordinary runtime/setup refuses incompatible retained schemas rather than migrating them or inferring operation records. Run readiness after an authorized upgrade before resuming writers. See [Skill State Management](../state-management/state-management.md#readiness-and-schema-upgrade-runbook).
