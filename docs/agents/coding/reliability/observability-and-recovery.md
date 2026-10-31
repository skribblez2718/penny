# Runtime Visibility, Diagnosis and Recovery

## Applies when

Designing or changing logs, metrics, health signals, discovery/routing visibility, operational diagnosis, incident recovery or controlled failure/capacity experiments.

## Show the operating contract

Expose enough safe context to distinguish slow, failed, rejected, cancelled, retried, degraded and completed operations. Use stable correlation identifiers and structured fields for operation, dependency and outcome rather than unexplained stack traces or prose alone. Identify build/version, relevant configuration and dependency/runtime state so an observed instance can be distinguished from an assumed one.

Choose signals that answer actual failure questions: rate, success/failure, latency distribution, timeouts, retries, saturation, queue depth/oldest age, breaker state, resource use and propagation lag where applicable. Do not mandate every metric for every component. Bound cardinality, retained volume and retry-storm logging so diagnostics do not become the outage.

Keep secrets and unnecessary sensitive data out of logs, metrics, errors and health output. Read [Security Logging](../security/logging-monitoring.md) when those signals are security-relevant and [Secure Error Handling](../security/error-handling.md) for public diagnostics. Operational visibility is not permission to disclose internals publicly.

## Health and interconnects

A process answering a health request is not necessarily making progress or able to serve. Detect relevant stuck subsystems, deadlocks, saturation and required dependency failure. Distinguish readiness from liveness and optional degraded behavior; expensive probes can amplify a dependency incident. Keep health paths protected and consistent with the ingress/transport contract under [Deployment Conventions](../deployment-conventions.md) when deployed paths are involved.

DNS, discovery, routing and load balancing are dependencies too. Check stale membership, uneven request concentration, fan-out and hidden single points of failure. Routing around a failed instance is useful only if the destination is ready and has capacity. A live count of healthy instances does not prove the request distribution is safe.

## Diagnose and recover deliberately

Reconstruct the failure chain from observations: initiating fault, propagation, resource exhaustion, missing defenses and detection gaps. For capacity problems inspect demand, tail latency, queue age, contention and dependency behavior together. A final exception may not be the originating failure. Use [Diagnosis and Performance](../testing/diagnosis-and-performance.md) for causal and measurement discipline.

Stabilize within authorized scope, preserve necessary evidence and verify recovery against the affected contract. Recovery may require data reconciliation or replay as well as restarting a process. Security-sensitive containment, revocation and restore follow [Incident Response](../security/incident-response.md) when applicable. Record a supported design/test improvement rather than blame or a ritual list of unrelated actions.

## Controlled operational evidence

Use launch, capacity, failure or disaster exercises only when their environment, target and effects are authorized. State a hypothesis, limited blast radius, observation, stop condition and recovery path. Prefer a controlled environment when it can answer the question. This guidance never authorizes disruptive production probes, administrative changes or new costs by itself.

Verify slow dependencies, overload, partial startup, restart and recovery where the change affects them. Capture actual outputs, workload, environment and untested boundaries. Feed findings into the relevant design and regression tests. QA success, a healthy dashboard or a fixture pass alone is not production readiness, live-provider qualification or proof that every failure is contained.
