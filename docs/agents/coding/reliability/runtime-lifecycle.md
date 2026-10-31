# Runtime Lifecycle and Recoverable Operations

## Applies when

Designing, changing, reviewing or diagnosing startup, shutdown, restart, resource growth/cleanup, runtime configuration, readiness handshakes, migrations, operational scripts, administration or release/recovery behavior.

## Keep routine operation in steady state

Identify state and resources that grow across requests or jobs: logs, caches, temporary files, connections, subscriptions, queued work and retained histories. Define safe expiration, compaction or cleanup consistent with correctness and replay needs. A process that routinely requires manual rescue is not in steady state. Retention chosen only to reduce disk use may destroy a required repair path.

Establish ownership and deterministic release for each resource. Shutdown should stop admission, handle in-flight work according to its contract, persist necessary progress and release resources. Cancellation and partial initialization need cleanup too. Test repeated startup/shutdown cycles rather than assuming a successful first launch proves lifecycle safety.

## Startup, readiness and restart

Validate required configuration and dependencies at the point needed to serve safely. Fail startup on missing critical controls rather than silently running an unsafe variant. Keep expensive/destructive migrations and one-time work out of ordinary request startup where practical; when unavoidable, make concurrency, completion and recovery explicit.

Handshake with load balancers, peers and dependencies so traffic reaches instances able to perform their promised work. Distinguish process liveness, readiness for traffic and optional dependency degradation. Do not use a broad readiness failure that unnecessarily turns one optional outage into total service collapse; do not report ready when a required capability is unavailable.

A supervised crash/restart can be safer than continuing in corrupt state only when isolation, persisted state, replay, idempotency and supervision make recovery credible. Restart loops can amplify load or hide the same fault. Do not apply a let-it-crash slogan to an effect whose completion is unknown or unrecoverable.

## Operations and releases have real effects

Make rerunnable automation idempotent or restartable where partial execution is possible. Track meaningful durable progress, validate preconditions and expose what changed. Define rollback or roll-forward for partial migration/release state, including old/new version coexistence and stored data; rollback of a binary does not automatically undo a schema or external effect. Where release risk warrants it, limit initial exposure and observe the affected behavior before expanding it. Choose exposure steps and stop or recovery conditions from the actual compatibility and failure risks; no particular rollout mechanism or deployment action is authorized here.

Keep administrative controls authorized, auditable, safe by default and stoppable. Control planes, scripts and delivery tooling deserve production-grade handling when they can affect production. Read the applicable security guides when administrative authority, secrets, configuration or recovery changes; source availability is not authorization to perform those actions.

[Deployment Conventions](../deployment-conventions.md) owns deployed environment, ingress, release and recovery requirements. Read it for that work. [Configuration Security](../security/configuration.md) applies to local runtime settings. Use [Evolution and Repair](../data-systems/evolution-and-repair.md) for schema/data transitions. This guide adds technical lifecycle considerations, not deployment permission or new organizational roles.

## Verification

Exercise missing/unsafe configuration, failed partial acquisition, required/optional dependency failure, startup interruption, stop with in-flight work, cancellation and restart. Test rerun after each meaningful automation checkpoint and inspect actual state, not only exit status. Check no traffic reaches an unready instance and no stale worker can resume invalid work. Deployment qualification needs the actual authorized deployed path; a document, template or local fixture cannot establish it.
