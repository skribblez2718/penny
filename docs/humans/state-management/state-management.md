# Skill State Management

Penny's shared orchestration engine stores run control state in a durable SQLite
checkpointer keyed by `run_id`. Each skill contributes a registered TypeScript playbook
with states, contracts, routing, gates, and terminal truth. Skill directories contain no
executable delegate.

## Three data planes

| Plane          | Owns                                                                                                           |
| -------------- | -------------------------------------------------------------------------------------------------------------- |
| Checkpointer   | Current state, compact routing fields, selected canonical refs, status, and durable parent/child call linkage. |
| Artifact plane | Immutable exact worker/stage bytes and evidence, including child request/input/output refs.                    |
| Durable memory | Optional primary cross-session recall/curation, diary, and temporal KG.                                        |

These planes do not substitute for each other. Payload bytes do not enter
`RunContext`; memory does not carry active workflow handoff.

## Durable child-workflow calls

A child-workflow call is a compact canonical record, not an inline child payload. The child state
owner mints custody from one concrete artifact store. The checkpointer verifies that the
artifact store and control database belong to the same project, then checks the already-persisted
canonical request and every bound input against the exact manifest ref and immutable bytes.

One control-store transaction records the exact parent visit and pending child directive, creates an
ordinary unstarted child run and its initial event, inserts the call record, and records the
reservation event. If any part fails, the transaction rolls all of those control-state changes
back. The deterministic `(parent run, parent state, call key)` identity is **adopt or conflict**: an
exact retry adopts the existing record and lifecycle, while changed immutable operands fail closed.
Artifact-only state, an unpaired child run, or missing/mismatched run, registration, project, trust,
or visit linkage is never repaired by guessing.

The record has a bounded lifecycle. Its storage owner handles reservation and the atomic
terminal-consumption transaction; the active runtime owner executes a registered depth-one child,
validates its exact terminal core, and continues the parent once. Normal services construct the
owner by default, and hosts may explicitly disable it. Child completion never makes the parent
successful by itself. New V2 records carry no predicted child-specific resource allocation,
aggregate capacity, or parent reserve. The child uses its registered repair/liveness policy and the
service-wide step backstop, while a content-free inactivity lease binds to a fenced owner attempt.
Trusted non-empty host-observed worker activity or workflow convergence renews one interval; stale/empty signals refuse, activity does not
manufacture convergence, and expiry stops the child. Runner and concurrent parent cancellation are
also forwarded. Child gates, arbitrary post-capture restart reconciliation, cohort retention,
promotion, and live qualification remain separate. Gate 2 remains unrun. Fixed-time V1 records are
legacy replay only and are not created for new calls.

Retention respects the durable linkage at the run-table level: an unsettled child call keeps its
parent run, and any extant call record keeps its child run. This does not yet establish integrated
artifact, receipt, or catalog-session cohort retention or eventual cohort cleanup. Explicit state
migration verifies retained call rows, linked identities and exact artifact refs; supported old
state gains an empty call table rather than invented linkage, while unsupported, unversioned,
newer, or malformed state refuses.

## Recovery

Every cognitive stage receives exact owner-selected input refs. The worker reads
them with `artifact_read` through `next_range`. The owner persists, re-reads, and
verifies the response before SUMMARY routing. If the process stops, recovery
rehydrates the checkpoint and reissues only pending work with the same refs. For a
child call, artifact-only state is non-authoritative; once the reservation transaction
commits, restart adopts the exact durable call instead of creating duplicate linkage.

Read-only worker recall is advisory and write-capable memory remains primary-only, so memory availability cannot
change state-machine correctness.

## Active schema upgrades

`penny-state init` is intentionally non-mutating for retained state. If an ordinary skill, subagent,
artifact, compaction, or knowledge-base call reports `STATE_SCHEMA_INCOMPATIBLE`, do not retry
`init` and do not delete the state directory.

1. Stop or pause workflow writers for the project.
2. Confirm the diagnosis with
   `penny-state readiness --project-root=$PROJECT_ROOT`.
3. Choose an existing owner-only `$BACKUP_ROOT` outside both the project tree and the Penny state
   tree.
4. Run
   `penny-state upgrade --project-root=$PROJECT_ROOT --backup-dir=$BACKUP_ROOT`.
5. Keep the returned backup directory and `upgrade-backup.json` manifest until normal work has been
   verified. Re-run the readiness command, then resume the affected operation.

The upgrade command validates the project binding, artifact store, receipt key, SQLite custody,
integrity, and supported source fingerprint before changing schema. It takes an administrative lock,
opens an exclusive database transaction, creates and verifies a consistent pre-upgrade SQLite image,
and applies every required schema step in that one transaction. A current schema is a successful
no-op and creates no backup.

If the command fails, keep the reported backup. A failure before commit rolls schema changes back;
run readiness to distinguish a safely retained old schema from a committed schema whose final
post-check was interrupted. A `prepared` manifest always identifies the verified pre-upgrade image,
not proof that the live database is damaged. Do not copy it over live state while Penny is running.
If readiness still reports the supported old version, correct the reported custody or environment
problem and retry the upgrade into a new backup directory. If readiness reports corruption or an
unsupported version, preserve both live state and the backup for explicit offline recovery rather
than using `init` or guessing a repair.

## Learn more

- [Architecture](state-machine-architecture.md)
- [Patterns](state-machine-patterns.md)
- Agent reference: [State Machine Reference](../../agents/state-management/state-machine-reference.md)
