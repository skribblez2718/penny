# Data Authority and Models

## Applies when

Designing or changing data models, authoritative write paths, caches, indexes, projections, search copies, read models or service data boundaries.

## Identify truth and its copies

For each changed fact, identify its authoritative representation, permitted update path and the representations derived from it. Authority is a technical state contract, not a new human role. A cache, index or search copy is derived unless the design explicitly makes it authoritative and supplies the required durability and consistency semantics.

Describe propagation, visible lag, allowed staleness and repair/rebuild behavior. Do not let a convenient cache quietly become the only usable source or let several stores accept independent writes to one fact without a conflict model. Deleting derived state is safe only when its source and reconstruction capability really exist.

Distinguish **accepted**, **persisted**, **durably committed**, **applied** and **visible to a reader**. Name the acknowledgment point and the failure assumptions it survives. A request accepted by a queue does not prove a projection was updated. A timed-out write may have committed; a successful write response does not establish every downstream side effect succeeded.

Tie freshness to the actual user or workflow contract. Some reads require read-your-writes or current authority, while a recommendation or analytics view may tolerate lag. Make that decision explicit rather than describing every stale read as either an infrastructure bug or harmless eventual consistency.

## Choose the model from the access pattern

Start from the relationships, queries and updates the system must support. Determine which data is read or written together, which invariants cross records, how volume is expected to grow and what must evolve independently. Evaluate candidate representations against those needs rather than choosing from a fixed model-to-problem lookup. For example, duplicating a changing relationship in many documents may shift substantial consistency work into the application; a self-contained document may avoid unnecessary joins for another workload.

Express queries so their intent and execution costs can be inspected. Compare the datastore's supported query capabilities with any proposed application-side traversal or dataflow. Use current engine documentation and actual plans for consequential assumptions; a query-language or model label is not evidence of workload fit. Preserve the caller's actual datastore and Penny's [canonical platform](../../architecture/project-standards.md); this guide does not authorize a migration.

Place boundaries where their update semantics remain manageable. A split that turns an ordinary read into many dependent remote requests must justify the added latency, failure modes and consistency work. Keep a tightly consistent concept together unless separation supplies enough value to support coordination and repair. A remote contract needs explicit identifiers, versions and partial-outcome semantics rather than the appearance of local atomic access.

## Derived-state obligations

A new derived representation needs a source, derivation/version, propagation mechanism, staleness contract and a practical repair, rebuild or re-sync path. Make lag and failed derivation observable. If reconstruction is impossible, explain that limitation instead of calling the representation disposable.

Do not perform unrelated multi-writes as though they were one transaction. An outbox, change-data capture or reconciliation process can connect a durable fact to downstream work, but each has a failure and retention contract. Read [Evolution and Repair](evolution-and-repair.md) when those mechanisms or old/new formats change and [Processing and Replay](processing-and-replay.md) when events or recomputation are involved.

## Verification

Trace a representative write through acknowledgment, propagation and each important read. Inject a crash or timeout before and after the durability point and check whether the caller can discover the outcome safely. Test stale reads, cache misses/outages and a repair/rebuild from the real authoritative input where supported. Verify the result against the named consistency and visibility contract, not merely the presence of a record in one store.
