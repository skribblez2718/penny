# Dependency Failures and Isolation

## Applies when

Designing, adding, changing, reviewing or diagnosing outbound calls, dependency APIs, remote waits, retries, resource checkout, circuit breakers, bulkheads or degraded behavior.

## Budget waits where response time matters

Assume a dependency can be slow, unavailable, malformed or wrong, not merely return an error. Give finite-response service calls and waits intentional time budgets. Account for connection establishment, checkout, response/body consumption, cancellation and the caller's remaining deadline. A request timer that leaves a socket or worker occupied does not fully bound the cost.

Choose budgets from the operation's latency needs and measured dependency behavior, not unexplained library defaults or a universal number. Propagate deadlines where appropriate and prevent a child call from outliving a caller that can no longer use it. A timeout does not prove the remote operation failed or that a write was rolled back.

These are protections for dependency waits and shared services. They do not impose invented finite step, call, phase-cycle or repair limits on productive operator-local model work. Honor the actual operator policy, cancellation and progress/inactivity controls; finite untrusted-input, resource and containment boundaries remain independent. [Resource Limits](../security/resource-limits.md) owns those controls when affected.

## Retry only a defensible operation

Identify the failure, whether another attempt can help and whether the effect is safe to repeat for both caller and provider. Do not retry validation rejection, missing authority or a permanent failure as though it were transient. For uncertain writes, use operation identity, deduplication, outcome lookup or reconciliation; see [Consistency and Coordination](../data-systems/consistency-and-coordination.md) when state effects are involved.

Give service retry policies finite attempt and elapsed-time budgets suited to their contract, with backoff and jitter where synchronized callers would amplify demand. Choose one responsible retry layer or an end-to-end retry budget: nested independent retries multiply load. Make timeout, retryability, cancellation, version compatibility and uncertain outcome visible in API contracts. Choose interaction granularity to avoid unnecessary remote round trips and their accumulated latency and failure exposure. Combining work is useful only when it preserves operation semantics, bounded payloads, partial-failure handling and any required independent progress; do not batch indiscriminately.

## Isolate the failure

A circuit breaker can stop flooding an unhealthy dependency and allow controlled recovery probes. Define what failures count, its open/degraded behavior and recovery evidence. A breaker does not replace a timeout or capacity bound, and a simple explicit failure path may be sufficient for a low-risk dependency.

Use bulkheads or separate pools where one workload or integration could exhaust capacity needed by unrelated critical work. Account for threads, connections, sockets and worker slots. Isolation adds tuning and idle-capacity cost; separate pools should match a credible failure boundary, not every API by default. Decoupling middleware may reduce immediate coupling but introduces its own capacity, lag and availability dependencies.

Fail fast when continuing would hide an unrecoverable failure or hold scarce resources pointlessly. Degrade only when the fallback preserves required correctness, freshness and authority. Make reduced capability visible; a fabricated success, unsafe cached authorization or silently dropped required work is not graceful degradation.

## Validate remote results

Check relevant status, content type, shape, size and business meaning before a response affects state, caches or downstream work. Keep parsing failures distinct from domain rejection. Read the applicable [Input Validation](../security/input-validation.md), [SSRF and Egress](../security/ssrf-egress.md) and [Secure Error Handling](../security/error-handling.md) guides when those boundaries are involved; do not duplicate their controls here.

## Verification

Exercise slow connection/response/body, timeout, cancellation, malformed results, permanent rejection and uncertain post-effect response loss. Observe whether resources are released and unrelated work survives. Test retry budgets, backoff/jitter, breaker transitions and recovery under representative load. An immediate mocked exception alone cannot establish that a genuinely stuck dependency is contained.
