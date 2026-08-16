# MEM-05/MEM-06 shadow, canary, replay, and rollback runbook

This runbook describes the generic tooling only. It does **not** authorize contact with a service, a production cutover, or use of live data. Every endpoint, palace, client set, state file, journal, approval ledger, fixture, evidence file, and output path must be supplied by the operator.

## Safety invariants

- Source is the sole writer throughout shadow comparison.
- Shadow calls only fixture-declared read tools. IDs and content must match exactly; only ranking displacement and latency use explicit per-fixture tolerances.
- Canary authority admits only the configured bounded client set. Other approved clients are blocked; fallback is always false.
- Candidate writes use one target only. There is no normal-path dual-write branch.
- A stable operation ID is derived from cutover ID, client ID, and logical operation key. Reusing it with another plane or payload is refused.
- The owner-only append-only journal fsyncs `prepared`, `remote-ack`, and `accepted` events. An operation is acknowledged only after exact post-ack read evidence is fsynced.
- Timeout/disconnect after a prepared intent is ambiguous. Normal writes do not retry it. Only explicit fault-gated recovery/replay may reuse the same idempotency key.
- Expansion requires a reconciliation receipt for the current journal hash with zero pending operations and zero mismatches.
- Before the first accepted candidate write, rollback restores and reconciles the proven source copy.
- After any accepted candidate write, rollback preserves candidate, drains, replays the exact journal into a compatible restored authority, and fully reconciles the replay journal.
- Package downgrade is not a rollback mechanism and every rollback evidence bundle must state `package_downgrade: false`.
- Live peak and complete diary/retention/maintenance cycles remain release blockers until real evidence marks them complete. The generated templates say `NOT RUN`.

## Configuration

Create two separate owner-only hub configs and render one owner-only cutover config from `scripts/setup/mempalace-cutover.config.json.in` (private evidence copies may remain in ignored staging). The cutover config must contain explicit absolute paths for:

- source and candidate hub configs;
- atomic canary authority/FSM state;
- accepted-write JSONL journal;
- append-only one-time approval ledger;
- owner-only cutover control lock;
- shadow fixtures.

It must also declare the complete approved client set, smaller canary client set, `no_fallback: true`, `post_ack_read_required: true`, and explicit tool/result extraction for every journaled plane. Each operation spec declares whether write result IDs are a `scalar` or `list`, whether the exact-read ID argument is `scalar` or `list`, and whether the read response is a root `single` object or a path-selected `list`; this is required for upstream shapes such as `mempalace_add_drawer` plus `mempalace_get_drawer`.

Never put operator filesystem coordinates, credentials, or live corpus content in tracked files. Keep runtime configs and receipts in an ignored/private directory with owner-only permissions.

## Read-only planning and status

All examples require caller-selected absolute paths; no path is inferred.

```bash
cd "$PROJECT_ROOT"
.venv/bin/python -m scripts.system.memory.cutover_cli \
  --config <ABSOLUTE_CUTOVER_CONFIG> plan

.venv/bin/python -m scripts.system.memory.cutover_cli \
  --config <ABSOLUTE_CUTOVER_CONFIG> status
```

`plan` and `status` do not contact either hub. `status` validates local state and journal and reports pending/accepted operation counts.

## MEM-05 shadow comparison

Prerequisites are an approved source-sole-writer authority receipt and owner-reviewed fixtures. The command contacts both configured hubs for reads only and writes a new immutable receipt path.

```bash
.venv/bin/python -m scripts.system.memory.cutover_cli \
  --config <ABSOLUTE_CUTOVER_CONFIG> shadow \
  --source-authority-receipt <ABSOLUTE_SOURCE_AUTHORITY_RECEIPT> \
  --output <ABSOLUTE_NEW_SHADOW_RECEIPT>
```

Exit `0` means every ID set and content digest matched, ranking stayed within each fixture tolerance, and latency stayed within each fixture bounds. Exit `1` is a no-go receipt. Resolve mismatches; do not “accept” unexplained drift by editing output.

## Qualification and authority state machine

The enforced order is:

1. `qualify`: approved GATE-A, GATE-B1, DATA-03, source authority/drain/export, exact data reconciliation, complete approved disposition, approved shadow comparison, and passed fault gate.
2. `drain`: final source drain; all clients blocked.
3. `final-delta`: final source/candidate exports and exact logical reconciliation, with no candidate writes.
4. `start-canary`: approved candidate sole authority, bounded canary clients, no fallback, post-ack reads.
5. `reconcile`: exact current accepted-write reconciliation.
6. `expand`: revalidate exact current reconciliation, then admit the complete approved client set.

Validate without mutation:

```bash
.venv/bin/python -m scripts.system.memory.cutover_cli \
  --config <ABSOLUTE_CUTOVER_CONFIG> dry-run \
  --transition <TRANSITION> \
  --evidence <ABSOLUTE_STAGE_EVIDENCE_BUNDLE>
```

Apply exactly one transition only with a short-lived capability hash-bound to the config, action, and evidence bundle. The configured append-only ledger burns the capability before state mutation; a second consumption path cannot make it reusable.

```bash
.venv/bin/python -m scripts.system.memory.cutover_cli \
  --config <ABSOLUTE_CUTOVER_CONFIG> apply \
  --transition <TRANSITION> \
  --evidence <ABSOLUTE_STAGE_EVIDENCE_BUNDLE> \
  --approval-receipt <ABSOLUTE_ONE_TIME_APPROVAL> \
  --consumption-receipt <ABSOLUTE_NEW_CONSUMPTION_RECEIPT>
```

## Accepted candidate writes

Canary clients integrate `CanaryWriteCoordinator`; they do not call the write tool directly. Each caller supplies:

- admitted client ID;
- logical operation key stable across retry;
- configured plane;
- exact payload.

The coordinator checks the atomic authority state, rejects non-admitted clients, derives the stable operation ID, writes exactly once to candidate, fsyncs remote IDs, performs the configured exact projection read, fsyncs acceptance, then returns. Logs/receipts may use digest/length metadata; the protected journal contains replay payloads and must remain owner-only.

A pending `prepared` or `remote-ack` event is not accepted. Stop expansion and use the fault-gated replay/recovery process.

## Reconciliation

This is a read-only hub operation but still requires explicit target, journal, and output paths:

```bash
.venv/bin/python -m scripts.system.memory.cutover_cli \
  --config <ABSOLUTE_CUTOVER_CONFIG> reconcile \
  --target candidate \
  --journal <ABSOLUTE_ACCEPTED_WRITE_JOURNAL> \
  --output <ABSOLUTE_NEW_RECONCILIATION_RECEIPT>
```

Exit `0` requires no pending operation, exact resulting IDs, and exact configured projection digest for every accepted write. Exit `1` blocks expansion/rollback completion.

## Replay plan and apply

Replay defaults to a non-mutating plan and never prints payload content:

```bash
.venv/bin/python -m scripts.system.memory.cutover_cli \
  --config <ABSOLUTE_CUTOVER_CONFIG> replay \
  --journal <ABSOLUTE_ACCEPTED_WRITE_JOURNAL>
```

After candidate preservation and drain, obtain a source-authority receipt and a `REPLAY-COMPATIBILITY` PASS receipt for the compatible restored/forward-recovery authority. Apply exact source replay with a separate append-only replay journal, replay-stage evidence binding all of those receipts, and a one-time capability:

```bash
.venv/bin/python -m scripts.system.memory.cutover_cli \
  --config <ABSOLUTE_CUTOVER_CONFIG> replay \
  --journal <ABSOLUTE_ACCEPTED_WRITE_JOURNAL> \
  --apply \
  --evidence <ABSOLUTE_REPLAY_EVIDENCE_BUNDLE> \
  --approval-receipt <ABSOLUTE_ONE_TIME_REPLAY_APPROVAL> \
  --consumption-receipt <ABSOLUTE_NEW_REPLAY_CONSUMPTION> \
  --replay-journal <ABSOLUTE_REPLAY_JOURNAL> \
  --output <ABSOLUTE_NEW_REPLAY_RECEIPT>
```

Replay uses original operation IDs, payloads, sequence, resulting IDs, and read-after-write digests. Any difference writes a no-go replay receipt and stops.

## Independent rollback

### Before accepted candidate writes

1. Drain/block all clients.
2. Restore the proven immutable source copy.
3. Produce exact logical reconciliation.
4. Apply `rollback-before-write` with a bundle claiming no candidate writes, source copy restored, and no package downgrade.

### After accepted candidate writes

1. Drain/block all clients.
2. Preserve candidate as an immutable verified copy.
3. Replay the complete accepted-write journal into a compatible restored source/forward-recovery authority.
4. Reconcile the replay journal against that authority.
5. Apply `rollback-after-write` with candidate manifest/copy, exact replay receipt, full source reconciliation, and `package_downgrade: false`.

Track B rollback changes memory authority only. It must not restore semantic workflow handoff or alter Track A authority.

## Required hermetic fault evidence

Before qualification, the approved fault-gate receipt must show all of these pass against a hermetic fake server:

- ambiguous timeout after target object creation;
- disconnect/kill between object creation and journal/ack;
- duplicate operation ID with identical and divergent payloads;
- idempotent exact replay;
- shadow/replay mismatch no-go.

No command in this runbook was run against live data by creation of this tooling.
