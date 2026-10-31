# P02 production composition

P02 has two deliberately separate service factories in `src/p02-production-runtime.ts`.

- `createScaP02CandidateServiceV1` exists only to produce qualification and baseline evidence from an accepted P01 lineage. It does **not** activate P02 and must not be exposed as ordinary skill ingress.
- `createScaP02ActivatedProductionServiceV1` is the campaign-facing path. It requires the durable P02 phase-activation registry, a current activation host, and the exact proposed start. Activation is replayed before and after host composition and before every host-operation journal, cache, or adapter path. Use validation receives owner-linked cancellation and a bounded inactivity-renewal capability; cancelled or expired authority replay cannot reach journal reservation or an adapter effect.

Both factories are zero-model and fail closed if routing ever attempts model dispatch.

## Required host bindings

The caller supplies every runtime authority explicitly:

- the host-owned P02 component-validation authority;
- a `host_qualified` isolation runtime with `live_qualified` scope, exact six-operation profiles, and host attestation;
- a factory-issued controlled inventory runner;
- distinct factory-issued Semgrep PHP, Semgrep JS/TS, and Gitleaks runners;
- distinct Composer and npm OSV transport capabilities, each bound to its own request/profile; and
- an optional local-recovery authority when the deployment supports proved local recovery.

The factory rejects reuse of one OSV transport object across both ecosystems.

Host and OSV bwrap configurations must include the required scratch capacity and fixed launcher/mount/setpriv pins described in [the scratch tmpfs boundary](P02-SCRATCH-TMPFS.md). Supply the measured library closure for all three executables, ship the adjacent byte-identical launcher and workers, and renew operation/deployment qualification; missing limits or pins cannot use the old runtime as a fallback.

## Durable result cache

`result_cache_root` must be an existing absolute canonical directory owned by the service UID with exact mode `0700`. Production composition opens it without creating or repairing it. The returned cache is injected into `OrchestrationService` together with the exact six adapters.

Orchestration state and artifact roots remain owned by the normal orchestration configuration. They must already exist before service construction. Restart, cancellation, journal recovery, and no-repeat cache behavior are handled by the canonical orchestration owner; the P02 host-sequence and result-cache tests exercise those paths.

## Activation sequence

1. Issue and independently review the accepted P01 qualification and campaign gate.
2. Run the candidate factory against that exact P01 lineage and collect all six P02 operation results.
3. Produce the formal P02 qualification record and activate `sca-p02` through the durable phase-activation owner.
4. Construct the activated factory with the current activation host and exact proposed start.
5. Only then expose the service through a trusted campaign owner. Public `sca` tool registration remains a separate release decision.
