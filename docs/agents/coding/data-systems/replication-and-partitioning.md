# Replication, Partitioning and Locality

## Applies when

Choosing or changing replication, replica reads, failover, partition keys, distributed routing, hot-key handling, rebalancing or cross-partition access.

## Replication is a contract, not a replica count

Choose leader/follower, multi-leader or leaderless behavior from actual write topology, latency, failure tolerance and conflict needs. Synchronous acknowledgment may strengthen durability under stated failures but can reduce availability or increase latency. Asynchronous propagation permits lag and can lose acknowledged updates during an inadequately protected failover. State the real acknowledgment and promotion rules.

Replica reads need explicit freshness expectations. **Read-your-writes** prevents a caller from missing its own completed update; **monotonic reads** prevent moving backward in observed history; **consistent-prefix reads** avoid observing a later dependent fact before its prerequisite. Provide only the guarantees required by the workflow, and choose routing or version mechanisms that actually enforce them.

A formula such as overlapping read/write quorum sizes is not proof of linearizability. Check which replicas participate, concurrent writes, stale responses, reconfiguration, sloppy quorums and hinted handoff. Define conflict detection and resolution; last-write-wins can discard meaningful updates and needs defensible clock assumptions. Read repair, anti-entropy or another convergence mechanism must match the failure model.

Describe outage, follower bootstrap/catch-up, failover and membership-change behavior. A lagging replica should not serve a promised-fresh result merely because its process is healthy. A former leader may resume after a pause; promotion alone does not stop its writes. Read [Consistency and Coordination](consistency-and-coordination.md) when leadership, quorums, leases or stale authority affect correctness.

## Partition around ordinary work

Choose a key that keeps common reads, updates and required invariants local where possible. Hash, range and explicit placement schemes distribute different workloads differently; a key that balances item count may still concentrate requests on one hot tenant, entity or time range.

Check normal query fan-out, cross-partition joins/transactions, secondary-index behavior, routing metadata and skew. A partition key is not merely an implementation convenience when every common query now needs all partitions. A global ordering requirement may defeat the intended parallelism; require no stronger ordering than the contract needs.

Plan rebalancing and migration: routing versions, state transfer, in-flight work, duplicate ownership, catch-up and cutover need defined behavior. Do not let two locations become independently authoritative by accident. A fixed partition scheme may simplify routing but constrain growth; dynamic movement can improve balance while adding coordination and operating cost. Avoid introducing a distributed scheme until the workload justifies it.

## Verification

Exercise skew and hot keys, ordinary query locality, stale replica reads, follower bootstrap, outage/failover and reconfiguration. For movement, test reads and writes during transfer, old routing metadata and interruption/restart. Check that acknowledged data and promised read guarantees survive the modeled failure, and that stale authority cannot overwrite current state. Report untested cluster behavior explicitly; a mocked replica response cannot prove the real topology's guarantees.
