# Capacity, Queues and Overload

## Applies when

Designing, changing, reviewing or diagnosing request admission, queues/buffers, resource pools, fan-out, expensive work, caches, scheduled/background jobs or capacity behavior.

## Make acceptance meaningful

Describe demand, service rate, concurrency, payload/result sizes, memory and important latency/queue-age targets. Check concentration and saturation, not only average load. A queue absorbs a temporary mismatch; it cannot make sustained arrival above service capacity disappear.

Bound queues, buffers, shared-service admission and scarce resource pools according to their actual operating contract. Choose explicit full behavior: reject early, defer with a credible completion path, backpressure producers or degrade optional work. Do not accept indefinitely while falling behind. Limit wait duration as well as queue length where finite response matters.

Reserve capacity or isolate workloads when necessary to preserve core functions. Shed lower-value work intentionally rather than letting best-effort work crowd out correctness-critical traffic. Governors can cap expensive or explosive behavior at admission, but arbitrary throttles can hide a bottleneck; connect limits to a concrete resource or failure. Read [Resource Limits](../security/resource-limits.md) when hostile input, shared capability or cost is involved, and preserve its distinction from productive operator-local model work.

## Pools, payloads and poison work

Check threads, connections, sockets, descriptors, memory and CPU-intensive worker slots. Size pools using actual downstream capacity and measured contention; a larger pool may worsen overload. Release resources on completion, error and cancellation, and avoid holding locks or expensive connections across unrelated slow remote work. When slow I/O needlessly occupies scarce workers, compare supported nonblocking I/O or another suitable execution model with the simpler blocking approach. Choose from measured contention and implementation cost, preserving cancellation, backpressure and cleanup; asynchronous code alone does not create capacity. Use [Errors and Resources](../construction/errors-and-resources.md) when lifetime code changes.

Stream or paginate large inputs/results when that avoids unbounded intermediate memory, and cap aggregation, fan-out and output costs. Streaming still needs backpressure and cancellation; pagination needs stable continuation and duplicate/missing-item semantics appropriate to the data.

Define poison-work handling: identify repeated permanent failure, quarantine/dead-letter it with useful safe diagnostics, and make any replay an intentional operation. Do not silently discard required work or loop forever at the head of a queue. Observe queue depth, oldest age, throughput, retries and failure rate; a short queue of stuck work can still be unhealthy.

## Caches and scheduled work

A cache normally accelerates an authoritative source; define staleness and miss/outage behavior rather than assuming a permanently high hit rate. Use request coalescing, staggered expiry or bounded background refresh when justified to prevent a miss stampede. Avoid rebuilding the entire cache synchronously on a hot-path miss. Keep any correctness/freshness requirement explicit under [Authority and Models](../data-systems/authority-and-models.md).

Spread scheduled and periodic work when synchronized starts or retries would concentrate demand. Backoff with jitter can avoid recurring retry pulses. Prevent overlapping runs where necessary, with an explicit skip/queue/coalesce policy. Long-running background work needs progress, cancellation and finite dependency waits according to its service contract, not an invented productive-model task quota.

## Verification

Drive demand beyond the modeled service rate in an authorized environment and observe admission, queue age, saturation, latency and core-service survival. Test full queues, poison items, cancellation and recovery after overload. Exercise cold caches, correlated expiry, cache failure and aligned scheduled starts. Check the absence of resource growth after repeated cycles. Report the workload and environment; these checks do not certify arbitrary production capacity.
