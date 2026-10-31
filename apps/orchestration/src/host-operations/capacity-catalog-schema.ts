/** Global catalog extension; no per-skill database or runtime DDL. */
export const HOST_CAPACITY_CATALOG_COLUMNS = {
  host_capacity_policy: ["singleton", "policy_jcs", "policy_sha256"],
  host_capacity_records: [
    "operation_record_id",
    "project_id",
    "revision",
    "state",
    "record_jcs",
    "record_sha256",
  ],
  host_capacity_snapshots: [
    "operation_record_id",
    "source_revision",
    "snapshot_jcs",
    "snapshot_sha256",
  ],
} as const;
export const HOST_CAPACITY_CATALOG_SQL = `
  CREATE TABLE host_capacity_policy (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    policy_jcs TEXT NOT NULL CHECK(length(policy_jcs) <= 131072),
    policy_sha256 TEXT NOT NULL CHECK(length(policy_sha256) = 64)
  ) STRICT;
  CREATE TABLE host_capacity_records (
    operation_record_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(project_id),
    revision INTEGER NOT NULL CHECK(revision >= 1),
    state TEXT NOT NULL CHECK(state IN ('queued','held','expired','settled','quarantined')),
    record_jcs TEXT NOT NULL CHECK(length(record_jcs) <= 131072),
    record_sha256 TEXT NOT NULL CHECK(length(record_sha256) = 64)
  ) STRICT;
  CREATE INDEX idx_host_capacity_project ON host_capacity_records(project_id, state);
  CREATE TABLE host_capacity_snapshots (
    operation_record_id TEXT NOT NULL REFERENCES host_capacity_records(operation_record_id),
    source_revision INTEGER NOT NULL CHECK(source_revision >= 1),
    snapshot_jcs TEXT NOT NULL CHECK(length(snapshot_jcs) <= 131072),
    snapshot_sha256 TEXT NOT NULL CHECK(length(snapshot_sha256) = 64),
    PRIMARY KEY(operation_record_id, source_revision)
  ) STRICT;
`;

/** Exact catalog-v3 lease DDL reused by the explicit backup-first v2→v4 upgrade. */
export const HOST_LEASE_CATALOG_V3_SQL = `
          CREATE TABLE host_operation_queue (
            operation_record_id TEXT PRIMARY KEY,
            backend_key_sha256 TEXT NOT NULL,
            project_id TEXT NOT NULL REFERENCES projects(project_id),
            run_id TEXT NOT NULL,
            state_id TEXT NOT NULL,
            attempt INTEGER NOT NULL CHECK(attempt >= 1),
            operation_id TEXT NOT NULL,
            registration_sha256 TEXT NOT NULL CHECK(length(registration_sha256) = 64),
            request_sha256 TEXT NOT NULL CHECK(length(request_sha256) = 64),
            queued_at_ms INTEGER NOT NULL CHECK(queued_at_ms >= 0),
            queue_deadline_at_ms INTEGER NOT NULL CHECK(queue_deadline_at_ms >= queued_at_ms)
          ) STRICT;
          CREATE INDEX idx_host_operation_queue_backend_fifo
            ON host_operation_queue(backend_key_sha256, queued_at_ms, operation_record_id);
          CREATE TABLE host_backend_leases (
            backend_key_sha256 TEXT PRIMARY KEY,
            state TEXT NOT NULL CHECK(state IN ('free','active','quarantined')),
            active_phase TEXT CHECK(active_phase IN (
              'pre_submission','submission_guarded','remote_accepted'
            )),
            lease_id TEXT,
            lease_epoch INTEGER CHECK(lease_epoch >= 1),
            fencing_token_sha256 TEXT CHECK(
              fencing_token_sha256 IS NULL OR length(fencing_token_sha256) = 64
            ),
            operation_record_id TEXT,
            project_id TEXT REFERENCES projects(project_id),
            run_id TEXT,
            state_id TEXT,
            attempt INTEGER CHECK(attempt >= 1),
            operation_id TEXT,
            registration_sha256 TEXT CHECK(
              registration_sha256 IS NULL OR length(registration_sha256) = 64
            ),
            request_sha256 TEXT CHECK(request_sha256 IS NULL OR length(request_sha256) = 64),
            remote_correlation_sha256 TEXT CHECK(
              remote_correlation_sha256 IS NULL OR length(remote_correlation_sha256) = 64
            ),
            expires_at_ms INTEGER CHECK(expires_at_ms >= 0),
            quarantine_id TEXT,
            disposition_receipt_id TEXT,
            updated_at TEXT NOT NULL,
            CHECK(
              (state = 'free' AND active_phase IS NULL AND lease_id IS NULL AND
               lease_epoch IS NULL AND fencing_token_sha256 IS NULL AND
               operation_record_id IS NULL AND project_id IS NULL AND run_id IS NULL AND
               state_id IS NULL AND attempt IS NULL AND operation_id IS NULL AND
               registration_sha256 IS NULL AND request_sha256 IS NULL AND
               remote_correlation_sha256 IS NULL AND expires_at_ms IS NULL AND
               quarantine_id IS NULL)
              OR
              (state = 'active' AND active_phase IS NOT NULL AND lease_id IS NOT NULL AND
               lease_epoch IS NOT NULL AND fencing_token_sha256 IS NOT NULL AND
               operation_record_id IS NOT NULL AND project_id IS NOT NULL AND run_id IS NOT NULL AND
               state_id IS NOT NULL AND attempt IS NOT NULL AND operation_id IS NOT NULL AND
               registration_sha256 IS NOT NULL AND request_sha256 IS NOT NULL AND
               expires_at_ms IS NOT NULL AND quarantine_id IS NULL)
              OR
              (state = 'quarantined' AND active_phase IS NOT NULL AND lease_id IS NOT NULL AND
               lease_epoch IS NOT NULL AND fencing_token_sha256 IS NOT NULL AND
               operation_record_id IS NOT NULL AND project_id IS NOT NULL AND run_id IS NOT NULL AND
               state_id IS NOT NULL AND attempt IS NOT NULL AND operation_id IS NOT NULL AND
               registration_sha256 IS NOT NULL AND request_sha256 IS NOT NULL AND
               expires_at_ms IS NULL AND quarantine_id IS NOT NULL AND
               disposition_receipt_id IS NOT NULL)
            )
          ) STRICT;
          CREATE TABLE host_backend_lease_events (
            event_id INTEGER PRIMARY KEY AUTOINCREMENT,
            backend_key_sha256 TEXT NOT NULL,
            operation_record_id TEXT,
            event_type TEXT NOT NULL,
            event_jcs TEXT NOT NULL,
            event_sha256 TEXT NOT NULL CHECK(length(event_sha256) = 64),
            created_at TEXT NOT NULL
          ) STRICT;
          CREATE INDEX idx_host_backend_lease_events_backend
            ON host_backend_lease_events(backend_key_sha256, event_id);
          CREATE TABLE host_backend_dispositions (
            receipt_id TEXT PRIMARY KEY,
            operation_record_id TEXT NOT NULL,
            backend_key_sha256 TEXT NOT NULL,
            lease_id TEXT,
            lease_epoch INTEGER,
            disposition_jcs TEXT NOT NULL,
            receipt_jcs TEXT NOT NULL,
            receipt_sha256 TEXT NOT NULL CHECK(length(receipt_sha256) = 64),
            created_at TEXT NOT NULL
          ) STRICT;
          CREATE INDEX idx_host_backend_dispositions_operation
            ON host_backend_dispositions(operation_record_id, created_at);
          CREATE TABLE host_backend_quarantine_resets (
            reset_receipt_id TEXT PRIMARY KEY,
            backend_key_sha256 TEXT NOT NULL,
            quarantine_id TEXT NOT NULL UNIQUE,
            disposition TEXT NOT NULL CHECK(disposition IN (
              'queue_inspected_empty','queue_drained','specific_remote_terminal'
            )),
            evidence_sha256 TEXT NOT NULL CHECK(length(evidence_sha256) = 64),
            reset_jcs TEXT NOT NULL,
            reset_sha256 TEXT NOT NULL CHECK(length(reset_sha256) = 64),
            reset_at TEXT NOT NULL
          ) STRICT;
          PRAGMA user_version = 3;
`;
