import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ArtifactStore } from "../dist/artifact-store.js";
import { canonicalJson, sha256 } from "../dist/canonical-json.js";
import {
  ChildWorkflowCallConflictError,
  Checkpointer,
  ORCHESTRATION_DATABASE_SCHEMA_VERSION,
} from "../dist/checkpointer.js";
import { ChildWorkflowStateOwner } from "../dist/child-workflows/owner.js";
import {
  ChildWorkflowArtifactCustody,
  createReservedChildWorkflowCallRecord,
  decodeChildWorkflowCallRecord,
  decodeStoredChildWorkflowCallRow,
  encodeChildWorkflowCallRecord,
} from "../dist/child-workflows/storage.js";
import { RunContext } from "../dist/context.js";
import type {
  ArtifactRef,
  ChildWorkflowBudgetAllocationV1,
  ChildWorkflowPolicyBindingV1,
  InvokeChildWorkflowDirective,
  OutputArtifactMetadata,
  RegistrationContractBindingV1,
  RunIdentity,
} from "../dist/contracts.js";
import {
  parseJson,
  requireNumber,
  requireRecord,
  requireString,
  requireValue,
} from "./helpers/narrowing.js";

const PROJECT_ID = `prj_${"3".repeat(32)}`;
const PARENT_REGISTRATION_SHA256 = "a".repeat(64);
const CHILD_REGISTRATION_SHA256 = "b".repeat(64);
const CREATED_AT = "2026-09-10T12:00:00.000Z";
const roots: string[] = [];

interface Fixture {
  readonly root: string;
  readonly databasePath: string;
  readonly checkpointer: Checkpointer;
  readonly artifacts: ArtifactStore;
  readonly owner: ChildWorkflowStateOwner;
  readonly parent: RunContext;
  readonly requestRef: ArtifactRef;
  readonly inputRef: ArtifactRef;
  readonly directive: InvokeChildWorkflowDirective;
  readonly record: import("../dist/child-workflows/contracts.js").ChildWorkflowCallRecordV1;
}

function temporaryRoot(label: string): string {
  const root = mkdtempSync(path.join(tmpdir(), `penny-child-storage-${label}-`));
  roots.push(root);
  return root;
}

function database(file: string): import("node:sqlite").DatabaseSync {
  const sqlite = requireValue(process.getBuiltinModule("node:sqlite"), "node:sqlite");
  return new sqlite.DatabaseSync(file);
}

function downgradeChildCallTableToV11(db: import("node:sqlite").DatabaseSync): void {
  db.exec(`
    ALTER TABLE child_workflow_calls RENAME TO child_workflow_calls_v12;
    CREATE TABLE child_workflow_calls (
      call_id TEXT PRIMARY KEY,
      schema_version INTEGER NOT NULL CHECK(schema_version = 1),
      parent_run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
      parent_state_id TEXT NOT NULL,
      parent_visit_sequence INTEGER NOT NULL CHECK(parent_visit_sequence >= 1),
      parent_visit_offset INTEGER NOT NULL CHECK(
        parent_visit_offset >= 0 AND parent_visit_offset <= 31
      ),
      call_key TEXT NOT NULL,
      child_run_id TEXT NOT NULL UNIQUE REFERENCES runs(run_id),
      lifecycle TEXT NOT NULL CHECK(lifecycle IN (
        'reserved','running','waiting_user','paused','terminal_recorded',
        'consumed','failed','cancelled'
      )),
      record_jcs TEXT NOT NULL,
      record_sha256 TEXT NOT NULL CHECK(length(record_sha256) = 64),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(parent_run_id, parent_state_id, call_key),
      CHECK(parent_run_id <> child_run_id)
    );
    INSERT INTO child_workflow_calls SELECT * FROM child_workflow_calls_v12;
    DROP TABLE child_workflow_calls_v12;
    DROP TABLE host_operation_calls;
    CREATE INDEX idx_child_workflow_calls_parent_lifecycle
      ON child_workflow_calls(parent_run_id, lifecycle);
    PRAGMA user_version=11;
  `);
}

function registration(name: string, registrationSha256: string): RegistrationContractBindingV1 {
  return {
    schema_version: 1,
    registration_name: name,
    contract_sha256: "c".repeat(64),
    registration_sha256: registrationSha256,
  };
}

function identity(
  runId: string,
  playbook: string,
  sessionId = "session-child-storage"
): RunIdentity {
  return {
    schema_version: 2,
    run_id: runId,
    session_id: sessionId,
    playbook,
    engine_owner: "typescript",
  };
}

function persistArtifact(
  artifacts: ArtifactStore,
  metadata: OutputArtifactMetadata,
  value: unknown
): ArtifactRef {
  return artifacts.persist({ metadata, content: canonicalJson(value) });
}

function childContext(
  record: ReturnType<typeof createReservedChildWorkflowCallRecord>,
  projectRoot: string
): RunContext {
  if (record.schema_version !== 1) throw new Error("legacy fixture requires a V1 call record");
  return RunContext.create({
    identity: record.child_identity,
    goal: "durable child storage fixture",
    constraints: {},
    projectRoot,
    trustProfile: "trusted-interactive",
    maxSteps: record.budget.max_steps,
    registrationContractBinding: registration("research", CHILD_REGISTRATION_SHA256),
  });
}

function makeFixture(label: string, maxRetainedRuns = 500): Fixture {
  const root = temporaryRoot(label);
  const databasePath = path.join(root, "orchestration.db");
  const checkpointer = Checkpointer.provision(databasePath, undefined, {
    projectId: PROJECT_ID,
    maxRetainedRuns,
  });
  const artifacts = ArtifactStore.provision(path.join(root, "artifacts"), {
    projectId: PROJECT_ID,
  });
  const parent = RunContext.create({
    identity: identity("run-parent", "plan"),
    goal: "parent storage fixture",
    constraints: {},
    projectRoot: root,
    trustProfile: "trusted-interactive",
    maxSteps: 12,
    registrationContractBinding: registration("plan", PARENT_REGISTRATION_SHA256),
  });
  checkpointer.createRun(parent, "run_created", {});

  const policyBinding: ChildWorkflowPolicyBindingV1 = {
    schema_version: 1,
    project_id: PROJECT_ID,
    principal_id: "principal-fixture",
    scope_id: "scope-fixture",
    source_policy_id: "source-policy-fixture",
    destination_policy_id: "destination-policy-fixture",
  };
  const requestRef = persistArtifact(
    artifacts,
    {
      schema_version: 2,
      run_id: parent.identity.run_id,
      phase: "intake",
      branch_id: null,
      kind: "child-request",
      operation_id: "child-request-call-a",
      version: 1,
      producer: "child-state-owner",
      media_type: "application/json",
      content_schema: {
        schema_id: "penny.child-workflow-request.v1",
        schema_version: 1,
      },
      parent_ref: null,
      upstream_refs: [],
    },
    {
      schema_id: "penny.child-workflow-request.v1",
      schema_version: 1,
      child_name: "research",
      provider_request_schema_id: "penny.research-request.v1",
      provider_request_schema_version: 1,
      provider_request: { question: "What evidence is retained?" },
      policy_binding: policyBinding,
    }
  );
  const inputRef = persistArtifact(
    artifacts,
    {
      schema_version: 2,
      run_id: parent.identity.run_id,
      phase: "intake",
      branch_id: null,
      kind: "semantic-core",
      operation_id: "child-input-call-a",
      version: 1,
      producer: "parent-fixture",
      media_type: "application/json",
      content_schema: { schema_id: "penny.fixture-input.v1", schema_version: 1 },
      parent_ref: null,
      upstream_refs: [],
    },
    { fixture: true }
  );
  const budget: ChildWorkflowBudgetAllocationV1 = {
    schema_version: 1,
    model_turns: 2,
    tool_calls: 3,
    external_calls: 0,
    wall_clock_ms: 10_000,
    max_steps: 8,
    output_bytes: 16_384,
  };
  const directive: InvokeChildWorkflowDirective = {
    schema_version: 2,
    action: "invoke_child_workflow",
    identity: parent.identity,
    state_id: "intake",
    call_key: "call-a",
    child_name: "research",
    request_ref: requestRef,
    input_artifacts: {
      schema_version: 2,
      artifacts: [{ slot: "prior_evidence", ref: inputRef }],
    },
    expected_output: {
      schema_version: 1,
      port_name: "grounded_synthesis",
      schema_id: "penny.grounded-synthesis.v1",
      schema_version_required: 1,
      artifact_kind: "semantic-core",
    },
    policy_binding: policyBinding,
    budget,
  };
  const record = createReservedChildWorkflowCallRecord({
    directive,
    parent_visit_sequence: 1,
    parent_visit_offset: 0,
    parent_registration_sha256: PARENT_REGISTRATION_SHA256,
    child_registration_sha256: CHILD_REGISTRATION_SHA256,
    timestamp: CREATED_AT,
  });
  if (record.schema_version !== 1) throw new Error("legacy storage fixture minted a non-V1 row");
  return {
    root,
    databasePath,
    checkpointer,
    artifacts,
    owner: new ChildWorkflowStateOwner(checkpointer, artifacts),
    parent,
    requestRef,
    inputRef,
    directive,
    record,
  };
}

function callCount(databasePath: string): number {
  const db = database(databasePath);
  try {
    const row = requireRecord(
      db.prepare("SELECT COUNT(*) AS count FROM child_workflow_calls").get(),
      "child-workflow call count"
    );
    return requireNumber(row["count"], "child-workflow call count value");
  } finally {
    db.close();
  }
}

function childRunCount(databasePath: string): number {
  const db = database(databasePath);
  try {
    const row = requireRecord(
      db.prepare("SELECT COUNT(*) AS count FROM runs WHERE run_id LIKE 'child-run-%'").get(),
      "child run count"
    );
    return requireNumber(row["count"], "child run count value");
  } finally {
    db.close();
  }
}

const RESERVATION_WORKER_PATH = fileURLToPath(
  new URL("./fixtures/child-workflow-reservation-worker.ts", import.meta.url)
);

interface ReservationWorkerResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function startReservationWorker(input: {
  readonly fixture: Fixture;
  readonly readyPath: string;
  readonly releasePath: string;
}): Promise<ReservationWorkerResult> {
  // Node strips only the fixture types; dist stays native ESM at its original URLs,
  // preserving shipping-generation guards instead of bundling a second runtime.
  const child = spawn(
    process.execPath,
    [
      RESERVATION_WORKER_PATH,
      input.fixture.databasePath,
      path.join(input.fixture.root, "artifacts"),
      PROJECT_ID,
      canonicalJson(input.fixture.record),
      input.fixture.root,
      input.readyPath,
      input.releasePath,
    ],
    { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] }
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (value: string) => {
    stdout += value;
  });
  child.stderr.on("data", (value: string) => {
    stderr += value;
  });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function waitForPaths(paths: readonly string[], timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!paths.every(existsSync)) {
    const failures = paths.map((path) => `${path}.error`).filter(existsSync);
    if (failures.length > 0) {
      throw new Error(
        `concurrent reservation worker failed: ${failures
          .map((failure) => requireString(readFileSync(failure, "utf8"), "worker failure"))
          .join("\n")}`
      );
    }
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for concurrent reservation workers: ${paths.join(", ")}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("CW-03 child-workflow call codec", () => {
  it("requires exact canonical record bytes, digest, projected columns, and durable visit bounds", () => {
    const fixture = makeFixture("codec");
    const encoded = encodeChildWorkflowCallRecord(fixture.record);
    expect(
      decodeChildWorkflowCallRecord({
        record_jcs: encoded.record_jcs,
        record_sha256: encoded.record_sha256,
      })
    ).toEqual(fixture.record);

    const noncanonical = JSON.stringify(JSON.parse(encoded.record_jcs), null, 2);
    expect(() =>
      decodeChildWorkflowCallRecord({
        record_jcs: noncanonical,
        record_sha256: sha256(noncanonical),
      })
    ).toThrow("not canonical JSON");
    expect(() =>
      decodeChildWorkflowCallRecord({
        record_jcs: encoded.record_jcs,
        record_sha256: "0".repeat(64),
      })
    ).toThrow("digest does not match");
    expect(() =>
      decodeStoredChildWorkflowCallRow({
        call_id: fixture.record.call_id,
        schema_version: 1,
        parent_run_id: fixture.record.parent_identity.run_id,
        parent_state_id: fixture.record.parent_state_id,
        parent_visit_sequence: fixture.record.parent_visit_sequence,
        parent_visit_offset: fixture.record.parent_visit_offset,
        call_key: fixture.record.call_key,
        child_run_id: fixture.record.child_identity.run_id,
        lifecycle: "running",
        record_jcs: encoded.record_jcs,
        record_sha256: encoded.record_sha256,
        created_at: fixture.record.created_at,
        updated_at: fixture.record.updated_at,
      })
    ).toThrow("lifecycle projection diverged");
    expect(() =>
      encodeChildWorkflowCallRecord({
        ...fixture.record,
        parent_visit_sequence: 0,
        directive_sha256: fixture.record.directive_sha256,
      })
    ).toThrow("visit coordinates are out of bounds");
    fixture.artifacts.close();
    fixture.checkpointer.close();
  });
});

describe("CW-03 child-workflow reservation and recovery", () => {
  it("serializes concurrent same-call reservations from independent processes", async () => {
    const fixture = makeFixture("concurrent-reservation");
    fixture.artifacts.close();
    fixture.checkpointer.close();
    const firstReady = path.join(fixture.root, "first.ready");
    const secondReady = path.join(fixture.root, "second.ready");
    const releasePath = path.join(fixture.root, "release");
    const first = startReservationWorker({
      fixture,
      readyPath: firstReady,
      releasePath,
    });
    const second = startReservationWorker({
      fixture,
      readyPath: secondReady,
      releasePath,
    });
    await waitForPaths([firstReady, secondReady]);
    writeFileSync(releasePath, "release", { flag: "wx", mode: 0o600 });
    const outcomes = await Promise.all([first, second]);
    for (const outcome of outcomes) expect(outcome.code, outcome.stderr).toBe(0);
    expect(
      outcomes
        .map((outcome) => requireRecord(parseJson(outcome.stdout), "worker outcome")["kind"])
        .sort()
    ).toEqual(["adopted", "created"]);

    using checkpointer = Checkpointer.openExisting(fixture.databasePath, undefined, {
      projectId: PROJECT_ID,
    });
    using artifacts = ArtifactStore.openExisting(path.join(fixture.root, "artifacts"), {
      projectId: PROJECT_ID,
    });
    expect(callCount(fixture.databasePath)).toBe(1);
    expect(childRunCount(fixture.databasePath)).toBe(1);
    expect(checkpointer.childWorkflowCall(fixture.record.call_id)?.lifecycle).toBe("reserved");
    expect(checkpointer.loadRun(fixture.parent.identity).pendingDirective).toEqual(
      fixture.directive
    );
    expect(artifacts.refById(fixture.requestRef.artifact_id)).toEqual(fixture.requestRef);
  });

  it("creates one atomic call/reservation, adopts exact duplicates, and conflicts on changed operands", () => {
    const fixture = makeFixture("idempotency");
    const created = fixture.owner.reserve({
      record: fixture.record,
      childContext: childContext(fixture.record, fixture.root),
    });
    expect(created.kind).toBe("created");
    expect(callCount(fixture.databasePath)).toBe(1);
    expect(childRunCount(fixture.databasePath)).toBe(1);

    const running = encodeChildWorkflowCallRecord({
      ...fixture.record,
      lifecycle: "running",
      updated_at: "2026-09-10T12:01:00.000Z",
    }).record;
    expect(
      fixture.owner.transition({ call_id: running.call_id, from: "reserved", next: running })
        .lifecycle
    ).toBe("running");

    const duplicate = createReservedChildWorkflowCallRecord({
      directive: fixture.directive,
      parent_visit_sequence: 1,
      parent_visit_offset: 0,
      parent_registration_sha256: PARENT_REGISTRATION_SHA256,
      child_registration_sha256: CHILD_REGISTRATION_SHA256,
      timestamp: "2026-09-10T12:02:00.000Z",
    });
    const adopted = fixture.owner.reserve({
      record: duplicate,
      childContext: childContext(duplicate, fixture.root),
    });
    expect(adopted).toMatchObject({
      kind: "adopted",
      record: { lifecycle: "running", created_at: CREATED_AT },
    });

    const changedDirective: InvokeChildWorkflowDirective = {
      ...fixture.directive,
      budget: { ...fixture.directive.budget, model_turns: 3 },
    };
    const changed = createReservedChildWorkflowCallRecord({
      directive: changedDirective,
      parent_visit_sequence: 1,
      parent_visit_offset: 0,
      parent_registration_sha256: PARENT_REGISTRATION_SHA256,
      child_registration_sha256: CHILD_REGISTRATION_SHA256,
      timestamp: "2026-09-10T12:03:00.000Z",
    });
    expect(() =>
      fixture.owner.reserve({
        record: changed,
        childContext: childContext(changed, fixture.root),
      })
    ).toThrow(ChildWorkflowCallConflictError);
    expect(callCount(fixture.databasePath)).toBe(1);
    expect(childRunCount(fixture.databasePath)).toBe(1);
    fixture.artifacts.close();
    fixture.checkpointer.close();
  });

  it("never adopts a changed versioned request policy at an existing logical call", () => {
    const fixture = makeFixture("policy-operand");
    expect(
      fixture.owner.reserve({
        record: fixture.record,
        childContext: childContext(fixture.record, fixture.root),
      }).kind
    ).toBe("created");
    const native: unknown = JSON.parse(fixture.artifacts.read(fixture.requestRef).toString("utf8"));
    const original = requireRecord(native, "child request");
    const alternate = persistArtifact(
      fixture.artifacts,
      {
        ...fixture.artifacts.metadata(fixture.requestRef),
        operation_id: "child-request-call-a-policy-variant",
      },
      {
        ...original,
        invocation_policy: { schema_version: 2, specification_assurance: "reviewed_definition" },
      }
    );
    const changedDirective = { ...fixture.directive, request_ref: alternate };
    const changed = createReservedChildWorkflowCallRecord({
      directive: changedDirective,
      parent_visit_sequence: 1,
      parent_visit_offset: 0,
      parent_registration_sha256: PARENT_REGISTRATION_SHA256,
      child_registration_sha256: CHILD_REGISTRATION_SHA256,
      timestamp: CREATED_AT,
    });
    expect(() =>
      fixture.owner.reserve({ record: changed, childContext: childContext(changed, fixture.root) })
    ).toThrow(ChildWorkflowCallConflictError);
    expect(callCount(fixture.databasePath)).toBe(1);
    expect(childRunCount(fixture.databasePath)).toBe(1);
    fixture.artifacts.close();
    fixture.checkpointer.close();
  });

  it("rolls back parent suspension and child creation if the call insert cannot commit", () => {
    const fixture = makeFixture("transaction-rollback");
    const db = database(fixture.databasePath);
    try {
      db.exec(`
        CREATE TRIGGER fail_child_call_insert
        BEFORE INSERT ON child_workflow_calls
        BEGIN
          SELECT RAISE(ABORT, 'injected child call insertion failure');
        END;
      `);
    } finally {
      db.close();
    }
    expect(() =>
      fixture.owner.reserve({
        record: fixture.record,
        childContext: childContext(fixture.record, fixture.root),
      })
    ).toThrow("injected child call insertion failure");
    expect(callCount(fixture.databasePath)).toBe(0);
    expect(childRunCount(fixture.databasePath)).toBe(0);
    expect(fixture.checkpointer.loadRun(fixture.parent.identity).pendingDirective).toBeNull();
    fixture.artifacts.close();
    fixture.checkpointer.close();
  });

  it("recovers artifact-only and committed crash boundaries without synthetic or duplicate linkage", () => {
    const fixture = makeFixture("recovery");
    expect(callCount(fixture.databasePath)).toBe(0);
    expect(childRunCount(fixture.databasePath)).toBe(0);
    expect(fixture.checkpointer.loadRun(fixture.parent.identity).pendingDirective).toBeNull();

    fixture.artifacts.close();
    fixture.checkpointer.close();
    const reopenedCheckpointer = Checkpointer.openExisting(fixture.databasePath, undefined, {
      projectId: PROJECT_ID,
    });
    const reopenedArtifacts = ArtifactStore.openExisting(path.join(fixture.root, "artifacts"), {
      projectId: PROJECT_ID,
    });
    const reopenedOwner = new ChildWorkflowStateOwner(reopenedCheckpointer, reopenedArtifacts);
    expect(
      reopenedOwner.reserve({
        record: fixture.record,
        childContext: childContext(fixture.record, fixture.root),
      }).kind
    ).toBe("created");
    reopenedArtifacts.close();
    reopenedCheckpointer.close();

    const recoveredCheckpointer = Checkpointer.openExisting(fixture.databasePath, undefined, {
      projectId: PROJECT_ID,
    });
    const recoveredArtifacts = ArtifactStore.openExisting(path.join(fixture.root, "artifacts"), {
      projectId: PROJECT_ID,
    });
    const recoveredOwner = new ChildWorkflowStateOwner(recoveredCheckpointer, recoveredArtifacts);
    expect(recoveredCheckpointer.childWorkflowCall(fixture.record.call_id)).toEqual(fixture.record);
    expect(recoveredCheckpointer.loadRun(fixture.parent.identity).pendingDirective).toEqual(
      fixture.directive
    );
    expect(
      recoveredOwner.reserve({
        record: fixture.record,
        childContext: childContext(fixture.record, fixture.root),
      }).kind
    ).toBe("adopted");
    expect(callCount(fixture.databasePath)).toBe(1);
    expect(childRunCount(fixture.databasePath)).toBe(1);
    recoveredArtifacts.close();
    recoveredCheckpointer.close();
  });

  it("replays the exact committed call from a fresh process", () => {
    const fixture = makeFixture("fresh-process");
    fixture.owner.reserve({
      record: fixture.record,
      childContext: childContext(fixture.record, fixture.root),
    });
    fixture.artifacts.close();
    fixture.checkpointer.close();

    const replay = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `
          import { createHash } from "node:crypto";
          import { DatabaseSync } from "node:sqlite";
          const database = new DatabaseSync(process.argv[1], { readOnly: true });
          const row = database.prepare("SELECT record_jcs,record_sha256 FROM child_workflow_calls WHERE call_id=?").get(process.argv[2]);
          if (row === undefined) throw new Error("call absent after restart");
          const digest = createHash("sha256").update(row.record_jcs).digest("hex");
          if (digest !== row.record_sha256) throw new Error("call digest changed after restart");
          const record = JSON.parse(row.record_jcs);
          const child = database.prepare("SELECT COUNT(*) AS count FROM runs WHERE run_id=?").get(record.child_identity.run_id);
          const parent = database.prepare("SELECT context_json FROM runs WHERE run_id=?").get(record.parent_identity.run_id);
          database.close();
          if (child?.count !== 1 || parent === undefined) throw new Error("linked run absent after restart");
          const pending = JSON.parse(parent.context_json).pending_directive;
          if (pending?.call_key !== record.call_key) throw new Error("parent suspension changed after restart");
          process.stdout.write(JSON.stringify({ call_id: record.call_id, lifecycle: record.lifecycle, child_count: child.count }));
        `,
        fixture.databasePath,
        fixture.record.call_id,
      ],
      { encoding: "utf8" }
    );
    expect(replay.status, replay.stderr).toBe(0);
    expect(requireRecord(parseJson(replay.stdout), "fresh-process child replay")).toEqual({
      call_id: fixture.record.call_id,
      lifecycle: "reserved",
      child_count: 1,
    });
  });

  it("leaves artifact-only or corrupt-byte interruptions non-authoritative", () => {
    const fixture = makeFixture("artifact-first");
    const forgedCustody = {};
    expect(() =>
      fixture.checkpointer.reserveChildWorkflowCall({
        record: fixture.record,
        childContext: childContext(fixture.record, fixture.root),
        custody: forgedCustody,
      })
    ).toThrow("does not carry a trusted ArtifactStore");
    expect(callCount(fixture.databasePath)).toBe(0);
    expect(childRunCount(fixture.databasePath)).toBe(0);

    const foreignArtifacts = ArtifactStore.provision(path.join(fixture.root, "foreign-artifacts"), {
      projectId: `prj_${"4".repeat(32)}`,
    });
    try {
      expect(() =>
        fixture.checkpointer.reserveChildWorkflowCall({
          record: fixture.record,
          childContext: childContext(fixture.record, fixture.root),
          custody: ChildWorkflowArtifactCustody.fromArtifactStore(foreignArtifacts),
        })
      ).toThrow("belongs to another Penny project");
    } finally {
      foreignArtifacts.close();
    }
    expect(callCount(fixture.databasePath)).toBe(0);
    expect(childRunCount(fixture.databasePath)).toBe(0);

    const changedRef: ArtifactRef = { ...fixture.requestRef, producer: "other-producer" };
    const changedDirective: InvokeChildWorkflowDirective = {
      ...fixture.directive,
      request_ref: changedRef,
    };
    const changedRecord = createReservedChildWorkflowCallRecord({
      directive: changedDirective,
      parent_visit_sequence: 1,
      parent_visit_offset: 0,
      parent_registration_sha256: PARENT_REGISTRATION_SHA256,
      child_registration_sha256: CHILD_REGISTRATION_SHA256,
      timestamp: CREATED_AT,
    });
    expect(() =>
      fixture.owner.reserve({
        record: changedRecord,
        childContext: childContext(changedRecord, fixture.root),
      })
    ).toThrow("ref differs from custody");
    expect(callCount(fixture.databasePath)).toBe(0);
    expect(childRunCount(fixture.databasePath)).toBe(0);

    const wrongRegistrationChild = RunContext.create({
      identity: fixture.record.child_identity,
      goal: "wrong registration fixture",
      constraints: {},
      projectRoot: fixture.root,
      trustProfile: "trusted-interactive",
      maxSteps: fixture.record.budget.max_steps,
      registrationContractBinding: registration("research", "e".repeat(64)),
    });
    expect(() =>
      fixture.owner.reserve({ record: fixture.record, childContext: wrongRegistrationChild })
    ).toThrow("initial child-workflow registration");
    expect(callCount(fixture.databasePath)).toBe(0);
    expect(childRunCount(fixture.databasePath)).toBe(0);

    const digest = fixture.requestRef.content_digest;
    const objectPath = path.join(
      fixture.root,
      "artifacts",
      "objects",
      "sha256",
      digest.slice(0, 2),
      digest.slice(2)
    );
    writeFileSync(objectPath, "corrupt", { mode: 0o600 });
    expect(() =>
      fixture.owner.reserve({
        record: fixture.record,
        childContext: childContext(fixture.record, fixture.root),
      })
    ).toThrow(/artifact.*(length|digest|bytes|verification)/u);
    expect(callCount(fixture.databasePath)).toBe(0);
    expect(childRunCount(fixture.databasePath)).toBe(0);
    expect(fixture.checkpointer.loadRun(fixture.parent.identity).pendingDirective).toBeNull();
    fixture.artifacts.close();
    fixture.checkpointer.close();
  });

  it("refuses a call whose durable parent suspension linkage was tampered", () => {
    const fixture = makeFixture("pending-directive-linkage");
    fixture.owner.reserve({
      record: fixture.record,
      childContext: childContext(fixture.record, fixture.root),
    });
    const db = database(fixture.databasePath);
    try {
      const row = requireRecord(
        db
          .prepare("SELECT context_json FROM runs WHERE run_id=?")
          .get(fixture.parent.identity.run_id),
        "stored parent child directive"
      );
      const checkpoint = requireRecord(
        parseJson(requireString(row["context_json"], "stored parent checkpoint")),
        "stored parent checkpoint"
      );
      db.prepare("UPDATE runs SET context_json=? WHERE run_id=?").run(
        canonicalJson({ ...checkpoint, pending_directive: null }),
        fixture.parent.identity.run_id
      );
    } finally {
      db.close();
    }
    expect(() => fixture.checkpointer.childWorkflowCall(fixture.record.call_id)).toThrow(
      "not the parent's exact pending directive"
    );
    fixture.artifacts.close();
    fixture.checkpointer.close();
  });

  it("enforces lifecycle compare-and-set while reserving consumption for the atomic owner", () => {
    const fixture = makeFixture("lifecycle");
    fixture.owner.reserve({
      record: fixture.record,
      childContext: childContext(fixture.record, fixture.root),
    });
    const running = encodeChildWorkflowCallRecord({
      ...fixture.record,
      lifecycle: "running",
      updated_at: "2026-09-10T12:01:00.000Z",
    }).record;
    fixture.owner.transition({ call_id: running.call_id, from: "reserved", next: running });
    expect(() =>
      fixture.owner.transition({ call_id: running.call_id, from: "reserved", next: running })
    ).toThrow("compare-and-set expected 'reserved', found 'running'");

    const failed = encodeChildWorkflowCallRecord({
      ...running,
      lifecycle: "failed",
      terminal_action: "error",
      terminal_sha256: "d".repeat(64),
      usage: {
        schema_version: 1,
        model_turns: 1,
        tool_calls: 0,
        external_calls: 0,
        active_wall_clock_ms: 1,
        steps: 1,
        output_bytes: 0,
        unknown_usage: false,
      },
      updated_at: "2026-09-10T12:02:00.000Z",
    }).record;
    expect(
      fixture.owner.transition({ call_id: failed.call_id, from: "running", next: failed }).lifecycle
    ).toBe("failed");
    expect(fixture.checkpointer.loadRun(fixture.parent.identity).pendingDirective).toEqual(
      fixture.directive
    );
    expect(fixture.checkpointer.loadRun(fixture.parent.identity)).toMatchObject({
      status: "running",
      met: false,
    });

    const consumed = encodeChildWorkflowCallRecord({
      ...failed,
      lifecycle: "consumed",
      updated_at: "2026-09-10T12:03:00.000Z",
    }).record;
    expect(() =>
      fixture.owner.transition({ call_id: consumed.call_id, from: "failed", next: consumed })
    ).toThrow("Checkpointer.consumeChildWorkflowCall");
    expect(fixture.checkpointer.childWorkflowCall(running.call_id)?.lifecycle).toBe("failed");
    fixture.artifacts.close();
    fixture.checkpointer.close();
  });
});

describe("CW-03 child-workflow retention linkage", () => {
  it("plans linked cohorts without a writer reservation and deletes an exact abandoned cohort parent-first", () => {
    const fixture = makeFixture("retention-abandoned", 0);
    fixture.owner.reserve({
      record: fixture.record,
      childContext: childContext(fixture.record, fixture.root),
    });
    const child = fixture.checkpointer.loadRun(fixture.record.child_identity);
    child.status = "error";
    child.terminalDirective = {
      schema_version: 2,
      action: "error",
      identity: child.identity,
      status: "error",
      met: false,
      result: {},
      artifacts: [],
      unresolved: ["storage fixture"],
    };
    fixture.checkpointer.saveRun(child, "fixture_child_terminal", {});
    const running = encodeChildWorkflowCallRecord({
      ...fixture.record,
      lifecycle: "running",
      updated_at: "2026-09-10T12:01:00.000Z",
    }).record;
    fixture.owner.transition({ call_id: running.call_id, from: "reserved", next: running });
    const failed = encodeChildWorkflowCallRecord({
      ...running,
      lifecycle: "failed",
      terminal_action: "error",
      terminal_sha256: sha256(canonicalJson(child.terminalDirective)),
      usage: {
        schema_version: 1,
        model_turns: 0,
        tool_calls: 0,
        external_calls: 0,
        active_wall_clock_ms: 0,
        steps: 0,
        output_bytes: 0,
        unknown_usage: false,
      },
      updated_at: "2026-09-10T12:02:00.000Z",
    }).record;
    fixture.owner.transition({ call_id: failed.call_id, from: "running", next: failed });
    const rival = database(fixture.databasePath);
    const fromCheckpoint = RunContext.fromCheckpoint;
    const hydration = vi
      .spyOn(RunContext, "fromCheckpoint")
      .mockImplementation((value, options) => {
        // Every runtime hydration during linkage validation must occur in the read phase.
        // A competing connection can reserve the writer right here, without a timing oracle.
        rival.exec("BEGIN IMMEDIATE");
        rival.exec("ROLLBACK");
        return fromCheckpoint(value, options);
      });
    const history = vi.spyOn(fixture.checkpointer, "events").mockImplementation(() => {
      throw new Error("linked retention must not replay full event history");
    });
    try {
      expect(fixture.checkpointer.pruneTerminalRuns()).toEqual([]);
      expect(hydration).toHaveBeenCalled();
      expect(history).not.toHaveBeenCalled();
      hydration.mockRestore();
      const parent = fixture.checkpointer.loadRun(fixture.record.parent_identity);
      parent.status = "cancelled";
      parent.pendingDirective = null;
      parent.terminalDirective = {
        schema_version: 2,
        action: "cancelled",
        identity: parent.identity,
        status: "cancelled",
        met: false,
        result: {},
        artifacts: [],
        unresolved: ["storage fixture"],
      };
      history.mockRestore();
      fixture.checkpointer.saveRun(parent, "fixture_parent_cancelled", {});
      expect(fixture.checkpointer.pruneTerminalRuns()).toEqual([
        parent.identity.run_id,
        child.identity.run_id,
      ]);
      expect(fixture.checkpointer.childWorkflowCall(failed.call_id)).toBeUndefined();
      expect(fixture.checkpointer.hasRunById(parent.identity.run_id)).toBe(false);
      expect(fixture.checkpointer.hasRunById(child.identity.run_id)).toBe(false);
      expect(fixture.artifacts.read(fixture.inputRef).toString("utf8")).toBe(
        canonicalJson({ fixture: true })
      );
    } finally {
      rival.close();
      fixture.artifacts.close();
      fixture.checkpointer.close();
    }
  });

  it("pins a terminal child call and run while its parent remains live", () => {
    const fixture = makeFixture("retention-linkage", 0);
    fixture.owner.reserve({
      record: fixture.record,
      childContext: childContext(fixture.record, fixture.root),
    });
    const running = encodeChildWorkflowCallRecord({
      ...fixture.record,
      lifecycle: "running",
      updated_at: "2026-09-10T12:01:00.000Z",
    }).record;
    fixture.owner.transition({ call_id: running.call_id, from: "reserved", next: running });
    const failed = encodeChildWorkflowCallRecord({
      ...running,
      lifecycle: "failed",
      terminal_action: "error",
      terminal_sha256: "d".repeat(64),
      usage: {
        schema_version: 1,
        model_turns: 0,
        tool_calls: 0,
        external_calls: 0,
        active_wall_clock_ms: 0,
        steps: 0,
        output_bytes: 0,
        unknown_usage: false,
      },
      updated_at: "2026-09-10T12:02:00.000Z",
    }).record;
    fixture.owner.transition({ call_id: failed.call_id, from: "running", next: failed });

    // CW-03 owns the durable linkage, not child terminal routing. The direct status setup
    // supplies retention pressure with a terminal child while the parent is still live.
    const db = database(fixture.databasePath);
    try {
      db.prepare("UPDATE runs SET status='complete', updated_at=? WHERE run_id=?").run(
        "2026-09-01T00:00:00.000Z",
        fixture.record.child_identity.run_id
      );
    } finally {
      db.close();
    }

    expect(fixture.checkpointer.pruneTerminalRuns()).toEqual([]);
    expect(fixture.checkpointer.hasRunById(fixture.parent.identity.run_id)).toBe(true);
    expect(fixture.checkpointer.hasRunById(fixture.record.child_identity.run_id)).toBe(true);
    expect(fixture.checkpointer.childWorkflowCall(fixture.record.call_id)?.lifecycle).toBe(
      "failed"
    );
    fixture.artifacts.close();
    fixture.checkpointer.close();
  });
});

describe("CW-03 schema-version boundary", () => {
  it("provisions v13 and explicitly upgrades v10 without synthesizing child linkage", () => {
    const root = temporaryRoot("schema-upgrade");
    const file = path.join(root, "orchestration.db");
    Checkpointer.provision(file, undefined, { projectId: PROJECT_ID }).close();
    const downgrade = database(file);
    try {
      downgrade.exec(
        "DROP TABLE host_operation_calls; DROP TABLE child_workflow_calls; PRAGMA user_version=10;"
      );
    } finally {
      downgrade.close();
    }
    expect(() => Checkpointer.openExisting(file, undefined, { projectId: PROJECT_ID })).toThrow(
      "schema 10 is not current"
    );

    Checkpointer.provision(file, undefined, { projectId: PROJECT_ID }).close();
    const upgraded = database(file);
    try {
      const version = requireRecord(
        upgraded.prepare("PRAGMA user_version").get(),
        "upgraded schema version"
      );
      const rows = requireRecord(
        upgraded.prepare("SELECT COUNT(*) AS count FROM child_workflow_calls").get(),
        "upgraded child call rows"
      );
      expect(requireNumber(version["user_version"], "upgraded schema user_version")).toBe(
        ORCHESTRATION_DATABASE_SCHEMA_VERSION
      );
      expect(requireNumber(rows["count"], "upgraded child call count")).toBe(0);
    } finally {
      upgraded.close();
    }
  });

  it("upgrades v11 while preserving exact legacy V1 child-call bytes", () => {
    const fixture = makeFixture("v11-call-upgrade");
    const reserved = fixture.owner.reserve({
      record: fixture.record,
      childContext: childContext(fixture.record, fixture.root),
    }).record;
    const expected = canonicalJson(reserved);
    fixture.checkpointer.close();
    const legacy = database(fixture.databasePath);
    try {
      downgradeChildCallTableToV11(legacy);
    } finally {
      legacy.close();
    }

    const upgraded = Checkpointer.provision(fixture.databasePath, undefined, {
      projectId: PROJECT_ID,
    });
    expect(canonicalJson(upgraded.childWorkflowCall(reserved.call_id))).toBe(expected);
    upgraded.close();
    fixture.artifacts.close();
  });

  it("refuses newer, unversioned retained, and malformed-current databases", () => {
    const root = temporaryRoot("schema-refusal");
    const newer = path.join(root, "newer.db");
    Checkpointer.provision(newer, undefined, { projectId: PROJECT_ID }).close();
    const newerDb = database(newer);
    try {
      newerDb.exec("PRAGMA user_version=14;");
    } finally {
      newerDb.close();
    }
    expect(() => Checkpointer.provision(newer, undefined, { projectId: PROJECT_ID })).toThrow(
      "newer than supported"
    );

    const unversioned = path.join(root, "unversioned.db");
    const unversionedDb = database(unversioned);
    try {
      unversionedDb.exec("CREATE TABLE mystery(value TEXT);");
    } finally {
      unversionedDb.close();
    }
    chmodSync(unversioned, 0o600);
    expect(() => Checkpointer.provision(unversioned, undefined, { projectId: PROJECT_ID })).toThrow(
      "not a recognized retained-state version"
    );
    const unchangedUnversioned = database(unversioned);
    try {
      const mode = requireRecord(
        unchangedUnversioned.prepare("PRAGMA journal_mode").get(),
        "unversioned retained journal mode"
      );
      const version = requireRecord(
        unchangedUnversioned.prepare("PRAGMA user_version").get(),
        "unversioned retained schema version"
      );
      expect(requireString(mode["journal_mode"], "unversioned retained journal mode")).toBe(
        "delete"
      );
      expect(requireNumber(version["user_version"], "unversioned retained schema version")).toBe(0);
    } finally {
      unchangedUnversioned.close();
    }

    const unsupportedLegacy = path.join(root, "unsupported-v8.db");
    Checkpointer.provision(unsupportedLegacy, undefined, { projectId: PROJECT_ID }).close();
    const unsupportedLegacyDb = database(unsupportedLegacy);
    try {
      unsupportedLegacyDb.exec(
        "DROP TABLE child_workflow_calls; DROP TABLE store_metadata; PRAGMA user_version=8;"
      );
    } finally {
      unsupportedLegacyDb.close();
    }
    expect(() =>
      Checkpointer.provision(unsupportedLegacy, undefined, { projectId: PROJECT_ID })
    ).toThrow("schema 8 is not an approved retained-state migration source");
    const unchangedLegacy = database(unsupportedLegacy);
    try {
      const version = requireRecord(
        unchangedLegacy.prepare("PRAGMA user_version").get(),
        "unsupported retained schema version"
      );
      expect(requireNumber(version["user_version"], "unsupported retained schema version")).toBe(8);
      expect(
        unchangedLegacy
          .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='child_workflow_calls'")
          .get()
      ).toBeUndefined();
    } finally {
      unchangedLegacy.close();
    }

    const wrongProject = path.join(root, "wrong-project.db");
    const storedProjectId = `prj_${"5".repeat(32)}`;
    const requestedProjectId = `prj_${"6".repeat(32)}`;
    Checkpointer.provision(wrongProject, undefined, { projectId: storedProjectId }).close();
    const wrongProjectDb = database(wrongProject);
    try {
      wrongProjectDb.exec("PRAGMA journal_mode=DELETE;");
    } finally {
      wrongProjectDb.close();
    }
    expect(() =>
      Checkpointer.provision(wrongProject, undefined, { projectId: requestedProjectId })
    ).toThrow("belongs to another Penny project");
    const unchangedWrongProject = database(wrongProject);
    try {
      const mode = requireRecord(
        unchangedWrongProject.prepare("PRAGMA journal_mode").get(),
        "wrong-project retained journal mode"
      );
      expect(requireString(mode["journal_mode"], "wrong-project retained journal mode")).toBe(
        "delete"
      );
    } finally {
      unchangedWrongProject.close();
    }

    const incompatibleLegacy = path.join(root, "incompatible-v10.db");
    Checkpointer.provision(incompatibleLegacy, undefined, { projectId: PROJECT_ID }).close();
    const incompatibleLegacyDb = database(incompatibleLegacy);
    try {
      incompatibleLegacyDb.exec(
        "DROP TABLE host_operation_calls; DROP TABLE child_workflow_calls; CREATE INDEX unexpected_runs_index ON runs(status); PRAGMA user_version=10;"
      );
    } finally {
      incompatibleLegacyDb.close();
    }
    expect(() =>
      Checkpointer.provision(incompatibleLegacy, undefined, { projectId: PROJECT_ID })
    ).toThrow("schema 10 fingerprint is incompatible");

    const malformed = path.join(root, "malformed.db");
    Checkpointer.provision(malformed, undefined, { projectId: PROJECT_ID }).close();
    const malformedDb = database(malformed);
    try {
      malformedDb.exec("DROP TABLE child_workflow_calls;");
    } finally {
      malformedDb.close();
    }
    expect(() =>
      Checkpointer.openExisting(malformed, undefined, { projectId: PROJECT_ID })
    ).toThrow("missing required table 'child_workflow_calls'");

    const newerVersion = database(newer);
    try {
      const row = requireRecord(
        newerVersion.prepare("PRAGMA user_version").get(),
        "retained newer version"
      );
      expect(requireNumber(row["user_version"], "retained newer user_version")).toBe(14);
    } finally {
      newerVersion.close();
    }
  });

  it("fails closed when a stored canonical row digest is changed", () => {
    const fixture = makeFixture("stored-corruption");
    fixture.owner.reserve({
      record: fixture.record,
      childContext: childContext(fixture.record, fixture.root),
    });
    const db = database(fixture.databasePath);
    try {
      const row = requireRecord(
        db
          .prepare("SELECT record_jcs FROM child_workflow_calls WHERE call_id=?")
          .get(fixture.record.call_id),
        "stored child call record"
      );
      const recordJcs = requireString(row["record_jcs"], "stored child call JCS");
      db.prepare("UPDATE child_workflow_calls SET record_sha256=? WHERE call_id=?").run(
        sha256(`${recordJcs}x`),
        fixture.record.call_id
      );
    } finally {
      db.close();
    }
    fixture.artifacts.close();
    fixture.checkpointer.close();
    expect(() =>
      Checkpointer.openExisting(fixture.databasePath, undefined, { projectId: PROJECT_ID })
    ).toThrow("stored child-workflow call");
  });
});
