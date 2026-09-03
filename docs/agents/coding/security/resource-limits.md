# Resource Limits

## Applies when

Requests, uploads, jobs, queues, parsers, recursion, decompression, fan-out, compute, storage, or external calls can consume resources or money.

## Security properties

- Externally triggerable work is finite per operation, identity/source, and service.
- Capacity exhaustion fails predictably without bypassing authority or corrupting state.

## Requirements

- Bound input bytes, parsed complexity, CPU, memory, wall time, concurrency, queue depth, output, storage, retries, fan-out, and downstream cost according to the operation.
- Apply independent budgets at request, identity/account, source, queue/worker, and global levels. Make limits observable and tune them from measured use.
- Use cancellation, backpressure, timeouts, quotas, and admission control before expensive work begins.

## Failure modes

- Using one request-per-minute constant as a universal defense.
- Bounding a request body while leaving decompression, query, queue, fan-out, or output unbounded.
- Charging limits after expensive work already occurred.

## Verification

- Test boundary, concurrency, timeout, cancellation, queue, expansion, output, and degradation behavior.
- Measure operation cost and inspect that limits are enforced at each intended layer.

## Related guidance

- [Anti-automation](anti-automation.md) owns business-flow abuse policy.
- [Untrusted execution](untrusted-execution.md), [file handling](file-handling.md), and [SSRF and egress](ssrf-egress.md) own specialized resource consumers.

## Current external references

- [OWASP Application Security Verification Standard (ASVS) 5.0.0](https://owasp.org/www-project-application-security-verification-standard/) is a coverage spine, not a substitute for task-specific design and evidence.
- Reconfirm version-sensitive protocol, browser, and library guidance from primary sources before choosing concrete settings or APIs.
