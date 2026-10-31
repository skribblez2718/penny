# Skill State Management

Penny's shared orchestration engine stores run control state in a durable SQLite
checkpointer keyed by `run_id`. Each skill contributes a registered TypeScript playbook
with states, routing, gates, and terminal candidates. Registrations declare contracts and
completion policy; the engine alone admits positive terminals. Skill directories contain no
executable delegate.

This page is the canonical human reference for Penny's three state data planes,
workflow recovery, and current child-workflow status.

## Three data planes

| Plane          | Owns                                                                                                                                 |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Checkpointer   | Current state, compact routing fields, selected canonical refs, durable child linkage, and the project-local host-operation journal. |
| Artifact plane | Immutable exact worker/stage bytes and evidence, including child and host-operation request/result refs.                             |
| Durable memory | Optional primary cross-session recall/curation, diary, and temporal knowledge graph.                                                 |

These planes do not substitute for one another. Payload bytes do not enter
`RunContext`; memory does not carry active workflow handoff or determine state-machine
correctness.

## Current child-workflow status

### Availability and limits

Internal runtime dispatch is active. Each approved ordinary workflow—`assess`,
`decide`, `define`, `diagnose`, `plan`, `produce`, and `research`—may invoke any approved
ordinary workflow as one depth-one child. Admission permits one child-workflow call
per parent run, one active child, and project concurrency of one. A child cannot invoke
a grandchild. Unknown workflow names and the dedicated/private `knowledge-base`
workflow deny.

A normal orchestration service constructs the child runtime owner. A host may disable
child workflows explicitly, in which case dispatch returns a typed owner-unavailable
refusal.

### Custody and execution

A child call is a compact canonical control record, not an inline payload. The child
state owner mints custody from one concrete artifact store, verifies that the artifact
store and control database belong to the same project, and checks the persisted
canonical request and every bound input against its exact manifest ref and immutable
bytes.

One control-store transaction records the exact parent visit and pending child
directive, creates an ordinary unstarted child run and initial event, inserts the call
record, and records the reservation event. If any part fails, all of those control-state
changes roll back. An exact retry adopts the existing record and lifecycle; changed
immutable operands conflict. Artifact-only state, an unpaired child run, or missing or
mismatched run, registration, project, trust, or visit linkage is never repaired by
guessing.

The runtime owner drives the reserved child through the ordinary engine and runner,
validates its exact terminal result, persists the child result, and atomically continues
the parent once. Child completion does **not** prove parent completion: the parent must
still satisfy its own routing, evidence, gate, and terminal-admission rules.

Current child execution uses the child's registered repair and liveness policy, the
service-wide step backstop, and a fenced inactivity lease renewed only by non-empty
host-observed worker activity or workflow convergence. Stale or empty signals refuse;
activity cannot manufacture convergence. Runner cancellation, concurrent durable
parent cancellation, and lease expiry stop the child under their respective rules.
Legacy fixed-allocation call records remain replay-only and are not created for new
calls.

Child user gates are projected as version-2 parent-owned waits. Only an exact committed,
parent-mediated reply may continue the child; direct, stale, duplicate, or mismatched replies refuse.
Waiting and captured-terminal restart recovery retain frozen registration and operand bindings;
missing linkage is never invented. Consumption rechecks the current parent snapshot, so cancellation
or changed selections cannot be overwritten by an older prepared continuation.

Retention holds linked control/gate/receipt cohorts and correlated catalog sessions together while
live, retained, or custody-blocked, including unconsumed/quarantined host effects. Eligible controls
are evicted atomically before safe session cleanup; immutable artifact bytes are preserved, not
garbage-collected. Separate opt-in imagegen reuse requires its own policy and concrete enabled
asset/runtime owners; it is not an eighth ordinary peer or a deployment qualification.

The [engine feature-status table](../../agents/orchestration/overview.md#child-workflow-feature-status)
is the agent-facing status owner. Storage-only tests do not prove dispatch, active-runtime tests
do not qualify providers, and internal execution does not promote or externally discover them.

### Qualification is separate from dispatch

The active registration records `gate_2_live_provider` as an unrun live-provider
qualification with `status: not_run` and no evidence (`evidence: null`). This gate is
not dispatch authorization. Internal dispatch is authorized separately by the static
ordinary-workflow registration and the active runtime owner.

No supported acceptance criteria, evaluator, or promotion procedure are currently published for this qualification. It is therefore non-actionable status, not an operator approval route. Do not infer qualification from successful internal execution or treat an ordinary smoke run as promotion evidence.

## Current asynchronous host-operation status

The platform supports generic registered asynchronous host operations. No operation kind or production adapter is implied by that support. A registration must declare the exact adapter, request/result artifact contracts, backend binding, capability classes, lease profile, deadlines, and byte/event bounds; the host must explicitly inject the matching adapter map.

The runner is the only dispatcher. Workers and model tools cannot execute these directives. A project-local canonical journal records lifecycle milestones, while the state-root catalog serializes each backend key across projects and service processes with a FIFO queue, epoch, and fencing-token digest. Ambiguous submission or accepted-remote expiry quarantines the backend instead of allowing duplicate submission. Reset is explicit, quarantine-ID-bound, and evidence-bearing.

Results and receipts contain refs, digests, counts, timings, and closed dispositions rather than request or response bodies. The engine revalidates exact artifact bytes before ordinary playbook routing, and one project-database transaction commits both the parent continuation and the consumed marker. See [Registered Asynchronous Host Operations](../architecture/host-operations.md).

## Recovery

Every cognitive stage receives exact owner-selected input refs. The worker reads needed
refs with `artifact_read`, continuing through `next_range` until complete. The owner
persists, re-reads, and verifies the response before routing its `SUMMARY`.

If a process stops, recovery rehydrates the exact checkpoint and reissues only pending
work with the same refs. Host work must therefore be idempotent or split into safe
prepare, verify, and apply steps. For a child call, artifact-only state is
non-authoritative: after the reservation transaction commits, restart adopts the exact
durable call instead of creating duplicate linkage. The same rule applies to host
operations: recovery adopts the exact call journal and lease fence. A persisted output
without its pre-journaled deterministic persistence plan cannot advance the lifecycle.

Read-only worker recall is advisory, and write-capable memory remains primary-only.
Memory availability cannot change recovery or state-machine truth.

## Database health

Exact artifact reads still verify the selected artifact's metadata, length, and digest.
They no longer trigger a scan of every database. Startup/readiness and explicit state
status run full integrity and foreign-key checks. Checks read through SQLite itself,
which may maintain journal sidecars and access timestamps but does not repair application
data. A corruption error preserves the diagnostic: stop writers, retain the database
and WAL, and recover into a separate validated database before approving replacement.
Do not treat corruption as missing configuration or bypass the checks.

`readiness` checks the catalog and runtime-required project state: orchestration,
artifacts, and receipt authority. It does not check the observability database. `status`
runs those readiness checks and also checks observability.

## Readiness and schema-upgrade runbook

The orchestration package exposes a `penny-state` binary when installed as a package. In a repository checkout, use the built CLI directly so the command does not depend on a global binary or shell-exported `.env` values.

First stop active workflow writers, open a shell at the repository root, and prepare the local command:

```bash
PROJECT_ROOT="$(pwd -P)"
bun run --cwd apps/orchestration build
STATE_CLI="$PROJECT_ROOT/apps/orchestration/dist/state-cli.js"
test -r "$STATE_CLI"
```

The build is state-independent. It does not initialize, upgrade, or repair retained state. Keep the same shell for the remaining commands so `PROJECT_ROOT` and `STATE_CLI` remain defined.

`penny-state init` is intentionally non-mutating for retained state. If an ordinary skill, subagent, artifact, compaction, or knowledge-base call reports `STATE_SCHEMA_INCOMPATIBLE`, do not retry `init` and do not delete the state directory.

### Check readiness

Run:

```bash
node "$STATE_CLI" readiness --project-root="$PROJECT_ROOT"
```

Success requires both:

1. process exit code `0`; and
2. one JSON object on standard output with the required readiness fields.

The fields mean:

| Field                        | Meaning                                                                                                      |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `schema_version`             | Identifies the machine-readable response contract. Do not use a hard-coded emitted value as a health signal. |
| `action`                     | Must be `readiness` for this command.                                                                        |
| `project_id`                 | The opaque project binding whose state was checked.                                                          |
| `state_root`                 | The resolved Penny state root.                                                                               |
| `project_state_root`         | The selected project's bound state partition.                                                                |
| `orchestration_database`     | The orchestration database that passed custody, compatibility, integrity, and foreign-key checks.            |
| `orchestration_receipt_key`  | The existing receipt authority loaded for that project.                                                      |
| `artifact_manifest_database` | The artifact manifest database whose project binding, schema, integrity, and foreign keys were checked.      |

A nonzero exit means readiness failed even if a caller captured partial output.

For an administrative check that includes observability, run:

```bash
node "$STATE_CLI" status --project-root="$PROJECT_ROOT"
```

`status` is stronger only in scope: it performs the readiness checks and then checks the
observability database. Observability availability does not gate ordinary runtime
readiness.

### Upgrade a recognized retained schema

1. Stop or pause workflow writers for the project.
2. Run the readiness command once to confirm the typed incompatibility.
3. Choose an existing caller-controlled, owner-only absolute directory outside both the project tree and the Penny state tree, then set `BACKUP_ROOT` to it in the same shell:

   ```bash
   BACKUP_ROOT="/absolute/private/backup-parent"
   test -d "$BACKUP_ROOT"
   ```

4. Run:

   ```bash
   node "$STATE_CLI" upgrade --project-root="$PROJECT_ROOT" --backup-dir="$BACKUP_ROOT"
   ```

The upgrade validates project binding, artifact storage, receipt authority, database
custody and integrity, and a supported source fingerprint before schema mutation. When
mutation is required, it takes an administrative lock, creates and verifies a consistent
pre-upgrade SQLite image, and applies all required schema steps in one exclusive
transaction. An already current schema is a successful no-op and creates no backup.

Upgrade success is exit code `0` plus one JSON object on standard output. Its `action`
must be `upgrade`; `schema_version` and `project_id` have the meanings above. The object
also contains:

| Field                   | Meaning                                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------ |
| `source_schema_version` | The schema inspected before the command's upgrade decision.                                      |
| `target_schema_version` | The schema expected by the running command.                                                      |
| `changed`               | Whether this invocation committed a schema mutation. It is not a success flag.                   |
| `backup_root`           | The created backup directory for a changed upgrade, or `null` for a successful no-op.            |
| `backup_database`       | The verified pre-upgrade database image for a changed upgrade, or `null` for a successful no-op. |

Treat exit code `0` as command success. `changed: true` means mutation occurred;
`changed: false` means the command succeeded without mutation.

### Prove readiness after a successful upgrade

Keep writers paused and run exactly one post-upgrade check:

```bash
node "$STATE_CLI" readiness --project-root="$PROJECT_ROOT"
```

Resume workflow writers only if it exits `0`, returns `action: readiness`, identifies
the same `project_id` as the successful upgrade, and includes all required readiness
fields listed above. This is a bounded proof, not a polling loop. If the check fails,
keep writers paused and handle the structured failure instead of repeatedly retrying.

Retain a successful changed upgrade's returned backup directory and
`upgrade-backup.json` manifest until normal work has also been verified.

### Handle failure without inventing recovery

A failed command exits `1` and writes a structured JSON error to standard error. Every
failure includes `error` and `message`. Only typed state-resolution failures also
include `code` and `details`; generic command or upgrade failures do not.

A failed upgrade does **not** report `backup_root` or `backup_database`. An interrupted
run may nevertheless have created a unique directory under the caller-selected
`$BACKUP_ROOT`, possibly with an `upgrade-backup.json` manifest whose phase is
`prepared`. Inspect that caller-controlled location without modifying it and preserve
any manifest, backup database, live database, and WAL. A prepared manifest identifies
a verified pre-upgrade image; it does not prove whether the live upgrade committed or
that live state is damaged.

Do not copy a prepared image over live state, delete partial evidence, reset retained
state, or infer a repair from file presence. Follow the typed `code` and recovery action
in `details` when present, together with the current recovery documentation. If the
failure has no typed action, stop and preserve the evidence for explicit inspection
rather than guessing.

## Learn more

- [Architecture](state-machine-architecture.md)
- [Patterns](state-machine-patterns.md)
- Agent reference: [State Machine Reference](../../agents/state-management/state-machine-reference.md)
