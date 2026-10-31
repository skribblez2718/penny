# Events, Batch Processing and Replay

## Applies when

Designing, adding, changing, reviewing or diagnosing commands, jobs, event/log consumers, CDC, event sourcing, replay, batch/dataflow work, stream processors, checkpoints or source-to-sink guarantees.

## Meaning, identity and order

A command requests an action; an event records a fact that occurred; a projection is a derived representation. A durable log preserves history under a stated retention and recovery contract, unlike an ephemeral transport buffer. Give events stable identity, relevant correlation/version metadata and payload meaning independent of one object's internal layout.

Delivery may be at-most-once, at-least-once or a stronger guarantee within a defined boundary. A broker's guarantee does not automatically cover the database write or external side effect after receipt. Define the whole source-to-sink path, including acknowledgment and checkpoint commits. Do not call a consumer exactly once without evidence for that entire stated boundary.

Acknowledge uncertainty with naturally idempotent state transitions, stable deduplication keys, atomic dedup/effect commits or an explicit recovery/reconciliation contract. A dedup marker committed before a non-atomic effect can lose work; committed after it can allow duplicate effects. Key scope and retention must cover the possible retry/replay horizon, including intentional replay. Keep external side effects out of recomputation unless their repetition is safe or guarded.

Require only meaningful order: per key, entity history, stream, partition or another explicit scope. A global order is expensive and often unnecessary. Use versions, sequence checks, commutative updates or another deliberate conflict policy when out-of-order processing is possible. Parallel consumers must not silently corrupt one key's ordered history.

## Batch and stream state

Make batch inputs, outputs and intermediate state recomputable or recoverable. Choose a join strategy, dataflow/MapReduce API, intermediate materialization and partitioning according to data volume, locality and operating cost. Prefer deterministic transformations and explicit side effects so rerunning work has a meaningful result.

Distinguish event time, ingestion time and processing time. A stream window needs an explicit lateness/watermark policy, state retention and behavior for late corrections or dropped data. Joins require compatible time and retention assumptions on both inputs; an unmatched event may be late rather than nonexistent.

Specify how state, offsets/checkpoints, output commits and in-flight work align after failure. A checkpoint is useful only if recovery reconstructs the promised state/effects boundary. Consumers can lag longer than retention; define alerting, backfill/bootstrap and recovery when historical input has expired. Event sourcing and CDC aid derivation but do not remove ordering, compatibility or consistency work.

Read [Evolution and Repair](evolution-and-repair.md) when history, schema, retention, bootstrap or derived-state reconstruction changes. Use [Capacity and Overload](../reliability/capacity-and-overload.md) for queue limits and producer/consumer imbalance, and [Consistency and Coordination](consistency-and-coordination.md) when atomic effects or concurrent invariants are involved.

## Verification

Replay duplicate, reordered and delayed inputs; crash before/after effect, acknowledgment and checkpoint boundaries; restart with the actual persisted state. Check key ordering, conflict handling and idempotency across the full retry horizon. For streams, test late data, window closure/correction and state expiry. For batch and projections, compare recomputation with the authoritative expected result. Keep adapter, broker and end-to-end guarantee evidence distinct.
