# Storage, Indexes and Workload

## Applies when

Choosing or changing storage layout, indexes, query strategy, analytical access, in-memory assumptions or data-system performance/scaling behavior.

## Start with the workload

Describe concrete data size, growth, read/write rate, key distribution, access patterns, contention and important latency percentiles. Identify whether the problem is point lookup, ordered scan, write throughput, joins, aggregation, recovery or another measured constraint. Scalability does not follow from node count or a storage-engine label.

Keep operability, simplicity and evolution in the comparison. A single datastore or a simpler query may meet the need with fewer failure boundaries than distribution or several specialized stores. Adding heterogeneity needs an actual workload benefit and a sustainable propagation/recovery contract. Preserve the configured platform unless a migration is separately authorized.

## Match physical design to access

Inspect how the selected engine writes, locates and recovers data. Log-structured storage may trade cheaper sequential writes for compaction, extra reads and delayed removal; page-oriented tree indexes make different update, locality and range-access tradeoffs. Determine which costs affect this workload from the actual version, configuration, plans and measurements. A storage structure's name does not establish its transaction or durability guarantees.

Treat secondary indexes as separate structures: they add write amplification, storage, maintenance, partitioning and consistency costs. Check selectivity, key ordering and actual plans rather than assuming an index will help. A local secondary index and a globally partitioned index produce different query fan-out and update coordination. Remove an index only after checking real readers and compatibility obligations.

Check whether analytical scans and aggregation interfere with transactional updates. A different layout or precomputed result can reduce repeated query work, but may add refresh lag, update amplification and another rebuild obligation. Compare those costs with the measured workload before separating stores or adding representations. Evaluate analytical layout, compression and sort order against the columns and ranges actually scanned, selectivity, storage use, decoding work and update or maintenance cost. Inspect the actual engine's capabilities and measure those tradeoffs rather than assuming every analytical optimization requires a new system.

An in-memory working set can reduce latency. It does not establish durable success: identify logging, persistence, replication, restart and recovery assumptions. Also account for memory growth, intermediate result size and what happens when the set no longer fits.

## Verify before and after

Inspect the important query plans and run representative workloads with realistic distributions, including skew, concurrency and recovery/compaction effects where relevant. Compare throughput, tail latency, I/O, memory and write cost under comparable conditions, while preserving correctness and consistency.

Use [Diagnosis and Performance](../testing/diagnosis-and-performance.md) for measurement discipline. Read [Replication and Partitioning](replication-and-partitioning.md) when access becomes distributed and [Authority and Models](authority-and-models.md) when introducing or changing a derived representation. A local benchmark does not establish general scale or production qualification.
