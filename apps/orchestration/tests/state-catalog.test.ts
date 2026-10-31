import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  initializePennyState,
  ProjectCatalog,
  projectRootCommitment,
  relinkPennyProject,
  resolvePennyProjectState,
} from "../dist/state/index.js";
import { upgradePennyCatalog } from "../dist/state/upgrade.js";
import {
  HostOperationLeaseAuthority,
  type HostOperationLeaseRequestV1,
} from "../dist/host-operations/lease-authority.js";
import { requireSqlite } from "./helpers/narrowing.js";

const roots: string[] = [];

function sandbox(): string {
  const root = mkdtempSync(path.join(tmpdir(), "penny-state-catalog-test-"));
  roots.push(root);
  return root;
}

function directory(parent: string, name: string): string {
  const candidate = path.join(parent, name);
  mkdirSync(candidate, { mode: 0o700 });
  return candidate;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Penny project catalog", () => {
  it("initializes owner-only target state idempotently", () => {
    const root = sandbox();
    const projectRoot = directory(root, "project");
    const stateRoot = path.join(root, "state");
    const options = { env: { PENNY_STATE_ROOT: stateRoot }, agentDir: "/ignored" } as const;

    const first = initializePennyState(projectRoot, options);
    const second = initializePennyState(projectRoot, options);

    expect(second.projectId).toBe(first.projectId);
    expect(second.rootCommitment).toBe(first.rootCommitment);
    expect(path.basename(first.paths.orchestration.database)).toBe("orchestration.db");
    expect(path.basename(first.paths.artifacts.manifestDatabase)).toBe("manifest.db");
    for (const candidate of [
      first.state.root,
      first.state.projects,
      first.paths.root,
      first.paths.orchestration.root,
      first.paths.artifacts.root,
      first.paths.skillChains,
      first.paths.subagentSessions,
      first.paths.knowledgeBase.approval,
    ]) {
      expect(lstatSync(candidate).mode & 0o777).toBe(0o700);
    }
    expect(lstatSync(first.state.catalogDatabase).mode & 0o777).toBe(0o600);
  });

  it("adds global host-operation authority tables only through backup-first explicit upgrade", async () => {
    const root = sandbox();
    const projectRoot = directory(root, "project");
    const stateRoot = path.join(root, "state");
    const binding = initializePennyState(projectRoot, {
      env: { PENNY_STATE_ROOT: stateRoot },
    });
    {
      const sqlite = requireSqlite(process.getBuiltinModule("node:sqlite"), "state catalog test");
      using database = new sqlite.DatabaseSync(binding.state.catalogDatabase);
      database.exec(`
        DROP TABLE host_capacity_snapshots;
        DROP TABLE host_capacity_records;
        DROP TABLE host_capacity_policy;
        DROP TABLE host_backend_quarantine_resets;
        DROP TABLE host_backend_dispositions;
        DROP TABLE host_backend_lease_events;
        DROP TABLE host_backend_leases;
        DROP TABLE host_operation_queue;
        PRAGMA user_version=2;
      `);
    }

    expect(() => new ProjectCatalog(stateRoot, { create: false, readOnly: true })).toThrow(
      /backup-first global catalog upgrade/u
    );
    expect(() => new ProjectCatalog(stateRoot, { create: true })).toThrow("backup-first");
    await upgradePennyCatalog({ stateRoot, backupDirectory: path.join(root, "backups") });
    using upgraded = new ProjectCatalog(stateRoot, { create: false });
    expect(upgraded.lookupProject(projectRoot)?.projectId).toBe(binding.projectId);
    const sqlite = requireSqlite(process.getBuiltinModule("node:sqlite"), "state catalog test");
    using database = new sqlite.DatabaseSync(binding.state.catalogDatabase, { readOnly: true });
    expect(database.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: 4 });
    expect(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name LIKE 'host_%'"
        )
        .get()
    ).toMatchObject({ count: 8 });
  });

  it("preserves retained v3 queue SQL and inactivity columns inside the upgraded catalog", () => {
    const root = sandbox();
    const projectRoot = directory(root, "project");
    const stateRoot = path.join(root, "state");
    const options = { env: { PENNY_STATE_ROOT: stateRoot } };
    const binding = initializePennyState(projectRoot, options);
    const sqlite = requireSqlite(process.getBuiltinModule("node:sqlite"), "retained catalog test");
    // Independently freeze the already-deployed v3 table. Deriving this fixture
    // from current production DDL would conceal another same-version rename.
    const retainedQueueSql = `CREATE TABLE host_operation_queue (
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
    ) STRICT`;
    const request: HostOperationLeaseRequestV1 = {
      operation_record_id: `hop_${"a".repeat(64)}`,
      backend_key_sha256: "b".repeat(64),
      project_id: binding.projectId,
      run_id: "retained-run",
      state_id: "host-operation",
      attempt: 1,
      operation_id: "retained-operation",
      registration_sha256: "c".repeat(64),
      request_sha256: "d".repeat(64),
      duration_ms: 1_000,
      queue_inactivity_expires_at_ms: 10_000,
    };
    {
      using database = new sqlite.DatabaseSync(binding.state.catalogDatabase);
      database.exec(`DROP TABLE host_operation_queue; ${retainedQueueSql};
        CREATE INDEX idx_host_operation_queue_backend_fifo
          ON host_operation_queue(backend_key_sha256, queued_at_ms, operation_record_id);`);
      database
        .prepare(`INSERT INTO host_operation_queue VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          request.operation_record_id,
          request.backend_key_sha256,
          request.project_id,
          request.run_id,
          request.state_id,
          request.attempt,
          request.operation_id,
          request.registration_sha256,
          request.request_sha256,
          0,
          10_000
        );
    }

    expect(resolvePennyProjectState(projectRoot, options).projectId).toBe(binding.projectId);
    using catalog = new ProjectCatalog(stateRoot, { create: false, readOnly: true });
    expect(catalog.lookupProject(projectRoot)?.projectId).toBe(binding.projectId);
    using authority = new HostOperationLeaseAuthority(stateRoot);
    // Read an existing row, then write and re-read a second queued request.
    expect(authority.tryAcquire(request, 1).kind).toBe("acquired");
    const waiting = {
      ...request,
      operation_record_id: `hop_${"e".repeat(64)}`,
      operation_id: "waiting-operation",
    };
    expect(authority.tryAcquire(waiting, 2).kind).toBe("waiting");
    expect(authority.tryAcquire(waiting, 3).kind).toBe("waiting");
    expect(() =>
      authority.tryAcquire({ ...waiting, queue_inactivity_expires_at_ms: 20_000 }, 4)
    ).toThrow("host operation queue identity conflicts");

    using database = new sqlite.DatabaseSync(binding.state.catalogDatabase, { readOnly: true });
    expect(database.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: 4 });
    expect(
      database.prepare("SELECT sql FROM sqlite_master WHERE name='host_operation_queue'").get()
    ).toMatchObject({ sql: retainedQueueSql });
    expect(
      database
        .prepare(
          "SELECT queue_deadline_at_ms FROM host_operation_queue WHERE operation_record_id=?"
        )
        .get(waiting.operation_record_id)
    ).toMatchObject({ queue_deadline_at_ms: 10_000 });
  });

  it("stores a commitment rather than the canonical project path", () => {
    const root = sandbox();
    const projectRoot = directory(root, "private-project-name");
    const stateRoot = path.join(root, "state");
    const binding = initializePennyState(projectRoot, {
      env: { PENNY_STATE_ROOT: stateRoot },
    });

    expect(binding.rootCommitment).toBe(projectRootCommitment(projectRoot));
    expect(binding.rootCommitment).not.toContain(projectRoot);
    expect(readFileSync(binding.state.catalogDatabase).includes(Buffer.from(projectRoot))).toBe(
      false
    );
  });

  it("isolates distinct canonical project roots", () => {
    const root = sandbox();
    const firstProject = directory(root, "first-project");
    const secondProject = directory(root, "second-project");
    const options = { env: { PENNY_STATE_ROOT: path.join(root, "state") } } as const;

    const first = initializePennyState(firstProject, options);
    const second = initializePennyState(secondProject, options);

    expect(second.projectId).not.toBe(first.projectId);
    expect(second.paths.root).not.toBe(first.paths.root);
    expect(resolvePennyProjectState(firstProject, options).projectId).toBe(first.projectId);
    expect(resolvePennyProjectState(secondProject, options).projectId).toBe(second.projectId);
  });

  it("relinks one existing opaque partition transactionally", () => {
    const root = sandbox();
    const currentRoot = directory(root, "current-project");
    const replacementRoot = directory(root, "replacement-project");
    const options = { env: { PENNY_STATE_ROOT: path.join(root, "state") } } as const;
    const original = initializePennyState(currentRoot, options);

    const relinked = relinkPennyProject(original.projectId, currentRoot, replacementRoot, options);

    expect(relinked.projectId).toBe(original.projectId);
    expect(() => resolvePennyProjectState(currentRoot, options)).toThrow(
      "project is not registered"
    );
    expect(resolvePennyProjectState(replacementRoot, options).projectId).toBe(original.projectId);
  });

  it("refuses relink collisions", () => {
    const root = sandbox();
    const firstRoot = directory(root, "first-project");
    const secondRoot = directory(root, "second-project");
    const options = { env: { PENNY_STATE_ROOT: path.join(root, "state") } } as const;
    const first = initializePennyState(firstRoot, options);
    initializePennyState(secondRoot, options);

    expect(() => relinkPennyProject(first.projectId, firstRoot, secondRoot, options)).toThrow(
      "already registered"
    );
    expect(resolvePennyProjectState(firstRoot, options).projectId).toBe(first.projectId);
  });

  it("does not create missing state during ordinary resolution", () => {
    const root = sandbox();
    const projectRoot = directory(root, "project");
    const stateRoot = path.join(root, "missing-state");

    expect(() =>
      resolvePennyProjectState(projectRoot, { env: { PENNY_STATE_ROOT: stateRoot } })
    ).toThrow();
    expect(() => lstatSync(stateRoot)).toThrow();
  });

  it("rejects symlinked and broadly accessible managed roots", () => {
    const root = sandbox();
    const projectRoot = directory(root, "project");
    const actualStateRoot = directory(root, "actual-state");
    const linkedStateRoot = path.join(root, "linked-state");
    symlinkSync(actualStateRoot, linkedStateRoot);

    expect(() =>
      initializePennyState(projectRoot, { env: { PENNY_STATE_ROOT: linkedStateRoot } })
    ).toThrow("symlink ancestor");

    const broadStateRoot = directory(root, "broad-state");
    chmodSync(broadStateRoot, 0o755);
    expect(() =>
      initializePennyState(projectRoot, { env: { PENNY_STATE_ROOT: broadStateRoot } })
    ).toThrow("mode must be exactly 0700");
  });
});
