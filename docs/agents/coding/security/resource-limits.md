# Resource Limits

## Applies when

Requests, uploads, jobs, queues, parsers, recursion, decompression, fan-out, compute, storage, or external calls can consume resources or money.

## Security properties

- Hostile/external or shared-service work has independently enforced finite resource limits per operation, identity/source, and service where those boundaries exist.
- Capacity exhaustion fails predictably without bypassing authority or corrupting state.

## Requirements

- Start with efficient algorithms, streaming or bounded batches, sensible worker/thread concurrency, cancellation, and retries controlled by actual policy and measured errors. Avoid busy-waiting, uncontrolled fan-out, and needless repeated work.
- Bound hostile/external input and shared-service consumption in bytes, parsed complexity, memory, duration, output, storage, concurrency and downstream cost according to the trust boundary. Keep independently enforced containment and useful worker safeguards. Derive values from actual operator policy, not test constants or model guesses. Use measured workload/failure evidence to assess whether those controls are effective, not to invent operator consent.
- Productive operator-local model work is not hostile/shared-service traffic merely because it loops. Do not mandate finite steps, agent calls, phase cycles, semantic repairs or correction attempts when operator policy supplies none. Cancellation, trusted progress/inactivity leases, measured errors, authorization/disclosure and honest exhaustion remain required. This does not relax input/output/schema/complexity limits or authorize hostile execution without containment.
- Do not infer a separate host-wide CPU quota, cgroup setup, or CPU-controller delegation
  from a generic checklist. Require stronger aggregate controls when per-operation/worker
  safeguards cannot meet a concrete security, shared-capacity, availability, or cost need,
  or a binding standard requires them. Locality does not exempt a workload from those needs;
  their absence is a blocker only where the corresponding requirement applies.
- For externally triggerable, shared, or multi-tenant services, apply admission control and independent request, identity/source, worker/queue, and service-wide budgets where those boundaries exist.
- Classify caller data versus caller-controlled executable behavior under
  [Untrusted Execution](untrusted-execution.md#classify-the-execution-surface).
  Untrusted code/capabilities still require independent containment; efficient application
  code is not a substitute for that boundary.

## Failure modes

- Using one request-per-minute constant as a universal defense.
- Bounding a request body while leaving decompression, query, queue, fan-out, or output unbounded.
- Charging limits after expensive work already occurred.
- Turning generic resource guidance into a host-reconfiguration prerequisite without a demonstrated need.

## Verification

- Test boundary, concurrency, timeout, cancellation, queue, expansion, output, and degradation behavior.
- Measure operation cost and inspect the controls actually required by the workload. Do not demand unrelated host-controller probes or claim unenforced quotas exist.

## Related guidance

- [Anti-automation](anti-automation.md) owns business-flow abuse policy.
- [Untrusted execution](untrusted-execution.md), [file handling](file-handling.md), and [SSRF and egress](ssrf-egress.md) own specialized resource consumers.
