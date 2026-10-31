# Consistency, Transactions and Coordination

## Applies when

Designing, changing, reviewing or diagnosing multi-step state updates, isolation, invariants, optimistic concurrency, locks, leases, leadership, clock-dependent correctness, consensus or distributed commit.

## Protect a named invariant

State what must remain true, which data/actions participate and where authority enforces it. Use a local transaction, constraint or atomic operation when it solves the actual problem cleanly. Do not weaken isolation because a schedule looks unlikely; provide another design that preserves the invariant if the isolation changes.

Transaction atomicity determines whether a transaction's changes commit together; isolation determines how concurrent transactions can interfere. Read committed does not by itself protect a multi-statement decision from concurrent changes. Snapshot isolation can give a consistent view while still allowing write skew. Lost updates, write skew and phantoms matter only in relation to the invariant they can break. Serializable execution, two-phase locking, serializable snapshot isolation, compare-and-set, version checks and deliberate locks have different contention and retry costs. Choose according to the actual engine and access path rather than the name of an isolation level alone.

Keep a read-modify operation atomic when that is its contract. Splitting `debit_if_funded()` into `balance()` followed by `debit()` can allow two concurrent callers to spend the same funds. A shorter critical section is not safer if it moves a necessary check outside the protected state transition.

## Acknowledge uncertainty and partial effects

Describe when the write commits, becomes durable under the selected failure model and becomes visible. A timeout or lost response leaves the outcome uncertain; it does not prove abort. Use stable operation identity, outcome lookup, deduplication or a reconciliation path when a caller may retry.

A database commit does not atomically send mail or update another service. Couple downstream intent to durable state through an appropriate transaction/outbox or capture path, or define compensation/reconciliation and repair. Test the windows between those actions. Avoid distributed transactions as the default, but do not pretend an asynchronous workflow provides their guarantee. If atomic commit across participants is necessary, define participant/coordinator failure, blocking and recovery behavior.

## Clocks and authority

Network loss, partitions, duplicate/reordered messages, long pauses and delayed responses are normal fault assumptions. A timeout is a suspicion of remote failure, not proof. Use a monotonic clock for elapsed durations; wall clocks can jump and are not a safe total order for concurrent writes without explicit uncertainty assumptions.

A lease expiring does not stop a paused holder from resuming. Use **fencing** when stale work could corrupt current state: issue an increasing authority token and have the protected resource reject older tokens. Merely generating a token, checking it only at the worker or releasing a lock on timeout does not fence a later write. Define token scope, persistence, validation and behavior after restart.

Linearizability requires each operation to appear to take effect at one point between its invocation and response, respecting real-time order: if one operation finishes before another begins, that order must hold. It differs from serializable multi-operation transactions. Maintaining this guarantee during a partition can require refusing operations rather than serving an inconsistent result. Evaluate the coordination latency and availability costs against the guarantee the callers actually need. Total-order broadcast, consensus, majority decisions, locks and leadership solve particular agreement problems. State membership, session, quorum and coordination-service dependencies and the fault model they tolerate. Do not hand-roll consensus or add it when a local authoritative operation is sufficient.

## Verification

Construct competing schedules for each affected invariant: lost update, simultaneous checks, predicate changes, stale versions and retries after unknown success. Test transaction abort/retry, cleanup and partial external effects. For leases/leadership, pause an old holder through expiry and verify the resource rejects its stale write after a new holder proceeds. Check restart and membership changes where affected. A quorum formula or a happy-path unit test is not evidence that these cases are safe.
