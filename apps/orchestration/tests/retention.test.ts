/**
 * Terminal-run retention owns correlated catalog-session JSONL as one run cohort.
 */

import { CURRENT_SESSION_VERSION } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CatalogSessionRetentionError,
  ProjectRetentionOwner,
} from "../dist/catalog-session-retention.js";
import { Checkpointer } from "../dist/checkpointer.js";
import { RunContext } from "../dist/context.js";
import type { ArtifactRef, RunIdentity, RunStatus } from "../dist/contracts.js";
import {
  CATALOG_WORKER_CONTINUITY_METADATA,
  CATALOG_WORKER_SESSION_METADATA,
  createDurableCatalogSession,
  finalizeDurableCatalogSession,
  type CatalogWorkerSessionMetadataV1,
  type ModelClient,
} from "../dist/model-client.js";
import { OrchestrationService } from "../dist/service.js";
import { initializePennyState } from "../dist/state/index.js";
import { requireRecordArray, requireString, requireValue } from "./helpers/narrowing.js";

const PROJECT_ID = `prj_${"a".repeat(32)}`;
const OTHER_PROJECT_ID = `prj_${"b".repeat(32)}`;
const roots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "penny-retention-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function database(file: string): import("node:sqlite").DatabaseSync {
  const sqlite = requireValue(process.getBuiltinModule("node:sqlite"), "node:sqlite");
  return new sqlite.DatabaseSync(file);
}

function executeSql(file: string, sql: string): void {
  const db = database(file);
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
}

function runIds(file: string, sql = "SELECT run_id FROM runs ORDER BY run_id"): string[] {
  const db = database(file);
  try {
    return requireRecordArray(db.prepare(sql).all(), "retention run rows").map((row, index) =>
      requireString(row["run_id"], `retention run rows[${index}].run_id`)
    );
  } finally {
    db.close();
  }
}

function sessionRoot(root: string): string {
  const directory = path.join(root, "subagent-sessions");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  return directory;
}

function mkRun(
  checkpointer: Checkpointer,
  databasePath: string,
  runId: string,
  status: RunStatus,
  timestamp: string,
  projectRoot: string,
  initialArtifacts: readonly ArtifactRef[] = []
): RunContext {
  const identity = {
    schema_version: 2,
    run_id: runId,
    session_id: `session-${runId}`,
    playbook: "research",
    engine_owner: "typescript",
  } satisfies RunIdentity;
  const context = RunContext.create({
    identity,
    goal: `retention test ${runId}`,
    constraints: {},
    projectRoot,
    trustProfile: "trusted-interactive",
    maxSteps: 8,
    initialArtifacts: [...initialArtifacts],
  });
  context.status = status;
  checkpointer.createRun(context, "run_created", {});
  const db = database(databasePath);
  try {
    db.prepare("UPDATE runs SET status=?, created_at=?, updated_at=? WHERE run_id=?").run(
      status,
      timestamp,
      timestamp,
      runId
    );
  } finally {
    db.close();
  }
  return context;
}

function appendProgressHistory(file: string, runId: string, count: number): void {
  const db = database(file);
  try {
    db.prepare(
      `WITH RECURSIVE progress(n) AS (
      VALUES(2) UNION ALL SELECT n + 1 FROM progress WHERE n < ? + 1
    ) INSERT INTO events(run_id, sequence, event_type, payload_json, created_at)
      SELECT ?, n, 'worker_progress', '{"liveness_v1":{"activity":"progress"}}', '2026-01-01'
      FROM progress`
    ).run(count, runId);
  } finally {
    db.close();
  }
}

/** Schema-valid control-store selection; retention does not read artifact bodies. */
function selectedRef(producerRunId: string): ArtifactRef {
  const digest = createHash("sha256").update(producerRunId).digest("hex");
  return {
    schema_version: 2,
    artifact_id: `art_${digest}`,
    run_id: producerRunId,
    phase: "fixture",
    branch_id: null,
    kind: "semantic-core",
    operation_id: `handoff-${producerRunId}`,
    version: 1,
    producer: "fixture",
    media_type: "application/json",
    byte_length: 2,
    content_digest: digest,
    store_ref: `artifact://sha256/${digest}`,
  };
}

function metadata(input: {
  readonly runId: string;
  readonly agent: string;
  readonly projectId?: string;
}): CatalogWorkerSessionMetadataV1 {
  return {
    schema_version: 1,
    project_id: input.projectId ?? PROJECT_ID,
    run_id: input.runId,
    workflow_session_id: `workflow-${input.runId}`,
    state_id: "report_writing",
    branch_id: null,
    attempt: 1,
    worker_id: `worker-${input.runId}`,
    agent: input.agent,
    purpose: "phase",
  };
}

function writeSessionFile(input: {
  readonly root: string;
  readonly agent: string;
  readonly runId: string;
  readonly file?: string;
  readonly metadataAgent?: string;
  readonly projectId?: string;
  readonly mode?: number;
}): string {
  const agentDirectory = path.join(input.root, input.agent);
  mkdirSync(agentDirectory, { recursive: true, mode: 0o700 });
  chmodSync(agentDirectory, 0o700);
  const sessionId = `pi-${input.agent}-${input.runId}-${input.file ?? "session"}`;
  const timestamp = "2026-01-01T00:00:00.000Z";
  const header = {
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id: sessionId,
    timestamp,
    cwd: path.dirname(input.root),
  };
  const entry = {
    type: "custom",
    customType: CATALOG_WORKER_SESSION_METADATA,
    data: metadata({
      runId: input.runId,
      agent: input.metadataAgent ?? input.agent,
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
    }),
    id: `entry-${input.runId}`,
    parentId: null,
    timestamp,
  };
  const filePath = path.join(input.root, input.agent, input.file ?? `${input.runId}.jsonl`);
  writeFileSync(filePath, `${JSON.stringify(header)}\n${JSON.stringify(entry)}\n`, {
    mode: input.mode ?? 0o600,
  });
  chmodSync(filePath, input.mode ?? 0o600);
  return filePath;
}

function createProducedSession(input: {
  readonly projectRoot: string;
  readonly root: string;
  readonly agent: string;
  readonly runId: string;
}): string {
  const manager = createDurableCatalogSession({
    projectRoot: input.projectRoot,
    projectId: PROJECT_ID,
    sessionRoot: input.root,
    agent: input.agent,
    stateId: "report_writing",
    correlation: {
      run_id: input.runId,
      workflow_session_id: `workflow-${input.runId}`,
      branch_id: null,
      attempt: 1,
      worker_id: `worker-${input.runId}`,
      purpose: "phase",
    },
  });
  manager.appendCustomEntry(CATALOG_WORKER_CONTINUITY_METADATA, {
    ...metadata({ runId: input.runId, agent: input.agent }),
    task: `Retained assignment for ${input.runId}`,
    registered_guidance: "Return the registered result framing.",
    input_artifacts: [],
    compaction_continuity: {
      mode: "exact_opening",
      opening: `Retained authoritative opening for ${input.runId}`,
    },
  });
  const file = finalizeDurableCatalogSession(manager);
  if (file === undefined) throw new Error("catalog session was not materialized");
  return file;
}

function owner(
  checkpointer: Checkpointer,
  root: string,
  projectId = PROJECT_ID
): ProjectRetentionOwner {
  return new ProjectRetentionOwner(checkpointer, { projectId, sessionRoot: root });
}

function capturedRetentionError(action: () => void): CatalogSessionRetentionError {
  let failure: unknown;
  try {
    action();
  } catch (error) {
    failure = error;
  }
  if (!(failure instanceof CatalogSessionRetentionError)) {
    throw new Error("expected CatalogSessionRetentionError");
  }
  return failure;
}

describe("run-cohort retention", () => {
  it.each([0, 1, 2])(
    "does not reserve the writer or hydrate contexts with %i terminals below/at the cap",
    (terminalCount) => {
      const root = temporaryRoot();
      const dbPath = path.join(root, "orchestration.db");
      const sessions = sessionRoot(root);
      using checkpointer = new Checkpointer(dbPath, undefined, { maxRetainedRuns: 2 });
      for (let index = 0; index < terminalCount; index += 1) {
        mkRun(checkpointer, dbPath, `terminal-${index}`, "complete", "2026-01-01", root);
      }
      mkRun(checkpointer, dbPath, "live", "running", "2026-01-01", root);
      const retainedSession = writeSessionFile({ root: sessions, agent: "echo", runId: "live" });
      const orphanSession = writeSessionFile({ root: sessions, agent: "echo", runId: "orphan" });
      const hydration = vi.spyOn(RunContext, "fromCheckpoint").mockImplementation(() => {
        throw new Error("no-op retention must not hydrate contexts");
      });
      const events = vi.spyOn(checkpointer, "eventsAfter").mockImplementation(() => {
        throw new Error("no-op retention must not replay events");
      });
      const holder = database(dbPath);
      try {
        holder.exec("BEGIN IMMEDIATE");
        expect(owner(checkpointer, sessions).run()).toEqual({
          evictedRunIds: [],
          removedSessionFiles: 1,
        });
        expect(hydration).not.toHaveBeenCalled();
        expect(events).not.toHaveBeenCalled();
        expect(existsSync(retainedSession)).toBe(true);
        expect(existsSync(orphanSession)).toBe(false);
      } finally {
        holder.exec("ROLLBACK");
        holder.close();
      }
    }
  );

  it("prunes with a large live progress history without hydrating runtime contexts or replaying it", () => {
    const root = temporaryRoot();
    const dbPath = path.join(root, "orchestration.db");
    const sessions = sessionRoot(root);
    using checkpointer = new Checkpointer(dbPath, undefined, { maxRetainedRuns: 1 });
    mkRun(checkpointer, dbPath, "old", "complete", "2026-01-01", root);
    mkRun(checkpointer, dbPath, "new", "complete", "2026-01-02", root);
    mkRun(checkpointer, dbPath, "live", "running", "2026-01-01", root);
    appendProgressHistory(dbPath, "live", 105_183);
    const oldSession = writeSessionFile({ root: sessions, agent: "echo", runId: "old" });
    const hydration = vi.spyOn(RunContext, "fromCheckpoint").mockImplementation(() => {
      throw new Error("dependency traversal needs compact checkpoints, not runtime contexts");
    });
    const events = vi.spyOn(checkpointer, "events").mockImplementation(() => {
      throw new Error("retention must not replay liveness history");
    });
    const visits = vi.spyOn(checkpointer, "stateVisits").mockImplementation(() => {
      throw new Error("dependency traversal must not reconstruct state visits");
    });
    expect(owner(checkpointer, sessions).run()).toEqual({
      evictedRunIds: ["old"],
      removedSessionFiles: 1,
    });
    expect(runIds(dbPath)).toEqual(["live", "new"]);
    expect(existsSync(oldSession)).toBe(false);
    expect(hydration).not.toHaveBeenCalled();
    expect(events).not.toHaveBeenCalled();
    expect(visits).not.toHaveBeenCalled();

    visits.mockRestore();
    const parses = vi.spyOn(JSON, "parse");
    expect(checkpointer.stateVisits("live")).toEqual([
      { event_sequence: 1, offset: 0, state_id: "intake", source: "create" },
    ]);
    // One relevant payload, not the 105,183 progress payloads. The public full-history
    // reader remains disabled so this also detects a regression to events(runId).
    expect(parses).toHaveBeenCalledTimes(1);
  });

  it.each([
    '{"state_visits_v1":null}',
    '{"state_visits_v1":{}}',
    JSON.stringify({ state_visits_v1: Array.from({ length: 33 }, () => ({})) }),
    '{"state_visits_v1":[{"schema_version":1,"state_id":"intake","source":"invented"}]}',
    '{"state_visits_v1":',
    "[]",
    "null",
    '{"unrelated":',
    '{"unrelated":1e999}',
    '{"unrelated":{"nested":[-1e999]}}',
    `{"unrelated":${"9".repeat(309)}}`,
  ])("refuses malformed event/visit payloads after SQL filtering: %s", (payload) => {
    const root = temporaryRoot();
    const dbPath = path.join(root, "orchestration.db");
    using checkpointer = new Checkpointer(dbPath);
    mkRun(checkpointer, dbPath, "live", "running", "2026-01-01", root);
    const db = database(dbPath);
    try {
      db.prepare(
        "INSERT INTO events(run_id, sequence, event_type, payload_json, created_at) VALUES (?, 2, 'fixture', ?, ?)"
      ).run("live", payload, "2026-01-01");
    } finally {
      db.close();
    }
    expect(() => checkpointer.stateVisits("live")).toThrow();
  });

  it.each([
    { sequence: 2, eventType: new Uint8Array([1]), createdAt: "2026-01-01" },
    { sequence: 2, eventType: "fixture", createdAt: new Uint8Array([1]) },
    { sequence: 2.5, eventType: "fixture", createdAt: "2026-01-01" },
    { sequence: Number.MAX_SAFE_INTEGER + 1, eventType: "fixture", createdAt: "2026-01-01" },
  ])("does not hide malformed SQLite event columns without visit metadata: %j", (event) => {
    const root = temporaryRoot();
    const dbPath = path.join(root, "orchestration.db");
    using checkpointer = new Checkpointer(dbPath);
    mkRun(checkpointer, dbPath, "live", "running", "2026-01-01", root);
    const db = database(dbPath);
    try {
      db.prepare(
        "INSERT INTO events(run_id, sequence, event_type, payload_json, created_at) VALUES ('live', ?, ?, '{}', ?)"
      ).run(event.sequence, event.eventType, event.createdAt);
    } finally {
      db.close();
    }
    expect(() => checkpointer.stateVisits("live")).toThrow();
  });

  it("keeps exact sequences and offsets for visit metadata on any event type", () => {
    const root = temporaryRoot();
    const dbPath = path.join(root, "orchestration.db");
    using checkpointer = new Checkpointer(dbPath);
    mkRun(checkpointer, dbPath, "live", "running", "2026-01-01", root);
    appendProgressHistory(dbPath, "live", 10);
    const db = database(dbPath);
    try {
      db.prepare(
        "INSERT INTO events(run_id, sequence, event_type, payload_json, created_at) VALUES ('live', 12, 'worker_progress', ?, '2026-01-01')"
      ).run(
        JSON.stringify({
          state_visits_v1: [
            { schema_version: 1, state_id: "review", source: "transition" },
            { schema_version: 1, state_id: "review", source: "restored_current" },
          ],
        })
      );
    } finally {
      db.close();
    }
    expect(checkpointer.stateVisits("live")).toEqual([
      { event_sequence: 1, offset: 0, state_id: "intake", source: "create" },
      { event_sequence: 12, offset: 0, state_id: "review", source: "transition" },
      { event_sequence: 12, offset: 1, state_id: "review", source: "restored_current" },
    ]);
  });

  it("pins transitive exact cross-run producers, but not unrelated old runs", () => {
    const root = temporaryRoot();
    const dbPath = path.join(root, "orchestration.db");
    using checkpointer = new Checkpointer(dbPath, undefined, { maxRetainedRuns: 0 });
    mkRun(checkpointer, dbPath, "ancestor", "complete", "2026-01-01", root);
    mkRun(checkpointer, dbPath, "producer", "complete", "2026-01-02", root, [
      selectedRef("ancestor"),
    ]);
    mkRun(checkpointer, dbPath, "unrelated", "complete", "2026-01-03", root);
    const consumer = mkRun(checkpointer, dbPath, "consumer", "running", "2026-01-04", root, [
      selectedRef("producer"),
    ]);
    expect(checkpointer.pruneTerminalRuns()).toEqual(["unrelated"]);
    expect(runIds(dbPath)).toEqual(["ancestor", "consumer", "producer"]);
    consumer.status = "error";
    checkpointer.saveRun(consumer, "fixture_settled", {});
    expect(new Set(checkpointer.pruneTerminalRuns())).toEqual(
      new Set(["ancestor", "producer", "consumer"])
    );
  });

  it("refuses a malformed retained dependency projection before any deletion or session cleanup", () => {
    const root = temporaryRoot();
    const dbPath = path.join(root, "orchestration.db");
    const sessions = sessionRoot(root);
    using checkpointer = new Checkpointer(dbPath, undefined, { maxRetainedRuns: 1 });
    mkRun(checkpointer, dbPath, "old", "complete", "2026-01-01", root);
    mkRun(checkpointer, dbPath, "new", "complete", "2026-01-02", root);
    const oldSession = writeSessionFile({ root: sessions, agent: "echo", runId: "old" });
    executeSql(
      dbPath,
      "UPDATE runs SET context_json=json_set(context_json, '$.selected_artifacts', json('[{}]')) WHERE run_id='new'"
    );
    expect(() => owner(checkpointer, sessions).run()).toThrow();
    expect(runIds(dbPath)).toEqual(["new", "old"]);
    expect(existsSync(oldSession)).toBe(true);
  });

  it.each(["during-read", "after-read"])(
    "defers after a concurrent consumer selection committed %s instead of deleting its producer",
    (phase) => {
      const root = temporaryRoot();
      const dbPath = path.join(root, "orchestration.db");
      using checkpointer = new Checkpointer(dbPath, undefined, { maxRetainedRuns: 1 });
      mkRun(checkpointer, dbPath, "old", "complete", "2026-01-01", root);
      mkRun(checkpointer, dbPath, "new", "complete", "2026-01-02", root);
      mkRun(checkpointer, dbPath, "consumer", "running", "2026-01-01", root);
      const rival = database(dbPath);
      const sqlite = requireValue(process.getBuiltinModule("node:sqlite"), "node:sqlite");
      const exec = sqlite.DatabaseSync.prototype.exec;
      let committed = false;
      // Interleave a real second-connection commit at an exact transaction boundary,
      // without sleeps, model calls or a production database.
      vi.spyOn(sqlite.DatabaseSync.prototype, "exec").mockImplementation(function (
        this: import("node:sqlite").DatabaseSync,
        sql: string
      ) {
        const boundary = phase === "during-read" ? "COMMIT" : "BEGIN IMMEDIATE";
        if (this !== rival && sql === boundary && !committed) {
          rival
            .prepare(
              "UPDATE runs SET context_json=json_set(context_json, '$.selected_artifacts', json(?)) WHERE run_id='consumer'"
            )
            .run(JSON.stringify([selectedRef("old")]));
          committed = true;
        }
        return exec.call(this, sql);
      });
      try {
        expect(checkpointer.pruneTerminalRuns()).toEqual([]);
        expect(committed).toBe(true);
        expect(runIds(dbPath)).toEqual(["consumer", "new", "old"]);
      } finally {
        rival.close();
      }
    }
  );

  it("does not spin or hold the writer during planning when other writers keep committing", () => {
    const root = temporaryRoot();
    const dbPath = path.join(root, "orchestration.db");
    using checkpointer = new Checkpointer(dbPath, undefined, { maxRetainedRuns: 1 });
    mkRun(checkpointer, dbPath, "old", "complete", "2026-01-01", root);
    mkRun(checkpointer, dbPath, "new", "complete", "2026-01-02", root);
    const rival = database(dbPath);
    const sqlite = requireValue(process.getBuiltinModule("node:sqlite"), "node:sqlite");
    const exec = sqlite.DatabaseSync.prototype.exec;
    let writeReservations = 0;
    vi.spyOn(sqlite.DatabaseSync.prototype, "exec").mockImplementation(function (
      this: import("node:sqlite").DatabaseSync,
      sql: string
    ) {
      if (this !== rival && sql === "BEGIN IMMEDIATE") {
        writeReservations += 1;
        // Fail deterministically rather than hanging if retention retries indefinitely.
        if (writeReservations > 1) throw new Error("retention repeated a stale plan");
        rival.exec("UPDATE runs SET updated_at='2026-01-03' WHERE run_id='new'");
      }
      return exec.call(this, sql);
    });
    try {
      expect(checkpointer.pruneTerminalRuns()).toEqual([]);
      expect(writeReservations).toBe(1);
      expect(runIds(dbPath)).toEqual(["new", "old"]);
    } finally {
      rival.close();
    }
  });

  it("defers stale custody/keep-order plans and recomputes them on the next pass", () => {
    const root = temporaryRoot();
    const dbPath = path.join(root, "orchestration.db");
    using checkpointer = new Checkpointer(dbPath, undefined, { maxRetainedRuns: 1 });
    mkRun(checkpointer, dbPath, "old", "complete", "2026-01-01", root);
    mkRun(checkpointer, dbPath, "middle", "complete", "2026-01-02", root);
    mkRun(checkpointer, dbPath, "new", "complete", "2026-01-03", root);
    const rival = database(dbPath);
    const sqlite = requireValue(process.getBuiltinModule("node:sqlite"), "node:sqlite");
    const exec = sqlite.DatabaseSync.prototype.exec;
    let committed = false;
    vi.spyOn(sqlite.DatabaseSync.prototype, "exec").mockImplementation(function (
      this: import("node:sqlite").DatabaseSync,
      sql: string
    ) {
      if (this !== rival && sql === "BEGIN IMMEDIATE" && !committed) {
        rival.exec("BEGIN IMMEDIATE");
        rival
          .prepare(
            `INSERT INTO private_inputs(private_input_id, run_id, request_sha256, storage_key, state, created_at, updated_at)
          VALUES ('hold', 'old', ?, 'fixture/request.json', 'active', '2026-01-01', '2026-01-01')`
          )
          .run("a".repeat(64));
        rival.exec("UPDATE runs SET updated_at='2026-01-04' WHERE run_id='middle'");
        rival.exec("COMMIT");
        committed = true;
      }
      return exec.call(this, sql);
    });
    try {
      expect(checkpointer.pruneTerminalRuns()).toEqual([]);
      expect(committed).toBe(true);
      expect(runIds(dbPath)).toEqual(["middle", "new", "old"]);
      expect(checkpointer.pruneTerminalRuns()).toEqual(["new"]);
      expect(runIds(dbPath)).toEqual(["middle", "old"]);
      // Even above cap, an all-held plan must not request a writer reservation.
      rival.exec("BEGIN IMMEDIATE");
      expect(checkpointer.pruneTerminalRuns()).toEqual([]);
      rival.exec("ROLLBACK");
    } finally {
      rival.close();
    }
  });

  it("co-retains exactly the newest 500 terminal database and JSONL cohorts by default", () => {
    const root = temporaryRoot();
    const dbPath = path.join(root, "orchestration.db");
    const sessions = sessionRoot(root);
    const checkpointer = new Checkpointer(dbPath);
    for (let index = 0; index < 501; index += 1) {
      const runId = `run-${String(index).padStart(3, "0")}`;
      const timestamp = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
      mkRun(checkpointer, dbPath, runId, "complete", timestamp, root);
      writeSessionFile({ root: sessions, agent: "echo", runId });
    }

    const result = owner(checkpointer, sessions).run();
    expect(result.evictedRunIds).toEqual(["run-000"]);
    expect(result.removedSessionFiles).toBe(1);
    expect(runIds(dbPath)).toHaveLength(500);
    expect(
      readdirSync(path.join(sessions, "echo")).filter((file) => file.endsWith(".jsonl"))
    ).toHaveLength(500);
    expect(existsSync(path.join(sessions, "echo", "run-000.jsonl"))).toBe(false);
    expect(existsSync(path.join(sessions, "echo", "run-500.jsonl"))).toBe(true);
    checkpointer.close();
  });

  it("removes every produced session for an evicted run across agents and retains the cohort kept", () => {
    const root = temporaryRoot();
    const dbPath = path.join(root, "orchestration.db");
    const sessions = sessionRoot(root);
    const checkpointer = new Checkpointer(dbPath, undefined, { maxRetainedRuns: 1 });
    mkRun(checkpointer, dbPath, "run-old", "complete", "2026-01-01T00:00:00Z", root);
    mkRun(checkpointer, dbPath, "run-new", "complete", "2026-01-02T00:00:00Z", root);
    const oldEcho = createProducedSession({
      projectRoot: root,
      root: sessions,
      agent: "echo",
      runId: "run-old",
    });
    const oldSkribble = createProducedSession({
      projectRoot: root,
      root: sessions,
      agent: "skribble",
      runId: "run-old",
    });
    const retained = createProducedSession({
      projectRoot: root,
      root: sessions,
      agent: "echo",
      runId: "run-new",
    });

    expect(owner(checkpointer, sessions).run()).toEqual({
      evictedRunIds: ["run-old"],
      removedSessionFiles: 2,
    });
    expect(existsSync(oldEcho)).toBe(false);
    expect(existsSync(oldSkribble)).toBe(false);
    expect(existsSync(retained)).toBe(true);
    checkpointer.close();
  });

  it("preserves nonterminal and custody-blocked terminal cohorts outside the cap", () => {
    const root = temporaryRoot();
    const dbPath = path.join(root, "orchestration.db");
    const sessions = sessionRoot(root);
    const checkpointer = new Checkpointer(dbPath, undefined, { maxRetainedRuns: 1 });
    mkRun(checkpointer, dbPath, "terminal-blocked", "complete", "2026-01-01T00:00:00Z", root);
    mkRun(checkpointer, dbPath, "terminal-prunable", "incomplete", "2026-01-02T00:00:00Z", root);
    mkRun(checkpointer, dbPath, "terminal-retained", "cancelled", "2026-01-03T00:00:00Z", root);
    mkRun(checkpointer, dbPath, "running", "running", "2025-01-01T00:00:00Z", root);
    mkRun(checkpointer, dbPath, "awaiting", "awaiting_user", "2025-01-02T00:00:00Z", root);
    const db = database(dbPath);
    try {
      db.prepare(
        `INSERT INTO private_inputs(
          private_input_id, run_id, request_sha256, storage_key, temporary_storage_key,
          state, created_at, updated_at
        ) VALUES (?, ?, ?, ?, NULL, 'active', ?, ?)`
      ).run(
        "private-blocker",
        "terminal-blocked",
        "a".repeat(64),
        "terminal-blocked/request.json",
        "2026-01-01T00:00:00Z",
        "2026-01-01T00:00:00Z"
      );
    } finally {
      db.close();
    }
    const files = new Map<string, string>();
    for (const runId of [
      "terminal-blocked",
      "terminal-prunable",
      "terminal-retained",
      "running",
      "awaiting",
    ]) {
      files.set(runId, writeSessionFile({ root: sessions, agent: "echo", runId }));
    }

    const result = owner(checkpointer, sessions).run();
    expect(result.evictedRunIds).toEqual(["terminal-prunable"]);
    expect(runIds(dbPath)).toEqual([
      "awaiting",
      "running",
      "terminal-blocked",
      "terminal-retained",
    ]);
    expect(existsSync(requireValue(files.get("terminal-prunable"), "prunable session"))).toBe(
      false
    );
    for (const runId of ["terminal-blocked", "terminal-retained", "running", "awaiting"]) {
      expect(existsSync(requireValue(files.get(runId), `${runId} session`))).toBe(true);
    }
    checkpointer.close();
  });

  it("rolls back a failed DB prune and performs no session deletion", () => {
    const root = temporaryRoot();
    const dbPath = path.join(root, "orchestration.db");
    const sessions = sessionRoot(root);
    const checkpointer = new Checkpointer(dbPath, undefined, { maxRetainedRuns: 1 });
    mkRun(checkpointer, dbPath, "run-old", "complete", "2026-01-01T00:00:00Z", root);
    mkRun(checkpointer, dbPath, "run-new", "complete", "2026-01-02T00:00:00Z", root);
    const oldSession = writeSessionFile({ root: sessions, agent: "echo", runId: "run-old" });
    executeSql(
      dbPath,
      `CREATE TRIGGER retention_failure BEFORE DELETE ON runs
       BEGIN SELECT RAISE(ABORT, 'retention fixture failure'); END;`
    );

    expect(() => owner(checkpointer, sessions).run()).toThrow(/retention fixture failure/u);
    expect(runIds(dbPath)).toEqual(["run-new", "run-old"]);
    expect(existsSync(oldSession)).toBe(true);
    checkpointer.close();
  });

  it("does not evict database rows from generic checkpointer shutdown", () => {
    const root = temporaryRoot();
    const dbPath = path.join(root, "orchestration.db");
    const checkpointer = new Checkpointer(dbPath, undefined, { maxRetainedRuns: 1 });
    mkRun(checkpointer, dbPath, "run-old", "complete", "2026-01-01T00:00:00Z", root);
    mkRun(checkpointer, dbPath, "run-new", "complete", "2026-01-02T00:00:00Z", root);
    checkpointer.close();
    expect(runIds(dbPath)).toEqual(["run-new", "run-old"]);
  });
});

describe("catalog-session deletion custody", () => {
  it("preserves and skips no-follow, custody, malformed, oversized, and correlation adversaries", () => {
    const root = temporaryRoot();
    const dbPath = path.join(root, "orchestration.db");
    const sessions = sessionRoot(root);
    const checkpointer = new Checkpointer(dbPath);
    const validOrphan = writeSessionFile({
      root: sessions,
      agent: "echo",
      runId: "valid-orphan",
    });
    const unsafeMode = writeSessionFile({
      root: sessions,
      agent: "echo",
      runId: "unsafe-mode",
      mode: 0o644,
    });
    const projectMismatch = writeSessionFile({
      root: sessions,
      agent: "echo",
      runId: "project-mismatch",
      projectId: OTHER_PROJECT_ID,
    });
    const agentMismatch = writeSessionFile({
      root: sessions,
      agent: "echo",
      runId: "agent-mismatch",
      metadataAgent: "skribble",
    });
    const echoDirectory = path.join(sessions, "echo");
    const malformed = path.join(echoDirectory, "malformed.jsonl");
    writeFileSync(malformed, "not-json\nnot-json\n", { mode: 0o600 });
    const oversized = path.join(echoDirectory, "oversized.jsonl");
    writeFileSync(
      oversized,
      `${JSON.stringify({
        type: "session",
        version: CURRENT_SESSION_VERSION,
        id: "oversized",
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd: root,
      })}\n${"x".repeat(65_536)}\n`,
      { mode: 0o600 }
    );
    const jsonlDirectory = path.join(echoDirectory, "directory.jsonl");
    mkdirSync(jsonlDirectory, { mode: 0o700 });

    const symlinkTarget = path.join(root, "symlink-target");
    writeFileSync(symlinkTarget, "SYMLINK_TARGET_SENTINEL", { mode: 0o600 });
    const symlinkFile = path.join(echoDirectory, "symlink.jsonl");
    symlinkSync(symlinkTarget, symlinkFile);
    const symlinkTargetBefore = readFileSync(symlinkTarget);

    const hardTarget = path.join(root, "hard-target");
    writeFileSync(hardTarget, "HARD_TARGET_SENTINEL", { mode: 0o600 });
    const hardLink = path.join(echoDirectory, "hard-link.jsonl");
    linkSync(hardTarget, hardLink);
    const hardTargetBefore = readFileSync(hardTarget);

    expect(owner(checkpointer, sessions).run()).toEqual({
      evictedRunIds: [],
      removedSessionFiles: 1,
    });
    expect(existsSync(validOrphan)).toBe(false);
    for (const candidate of [
      unsafeMode,
      projectMismatch,
      agentMismatch,
      malformed,
      oversized,
      jsonlDirectory,
      symlinkFile,
      hardLink,
    ]) {
      expect(existsSync(candidate)).toBe(true);
    }
    expect(readFileSync(symlinkTarget)).toEqual(symlinkTargetBefore);
    expect(readFileSync(hardTarget)).toEqual(hardTargetBefore);
    expect(statSync(hardTarget).nlink).toBe(2);
    checkpointer.close();
  });

  it("surfaces post-commit cleanup failure and removes the exact orphan on retry", () => {
    const root = temporaryRoot();
    const dbPath = path.join(root, "orchestration.db");
    const sessions = sessionRoot(root);
    const checkpointer = new Checkpointer(dbPath, undefined, { maxRetainedRuns: 1 });
    mkRun(checkpointer, dbPath, "run-old", "complete", "2026-01-01T00:00:00Z", root);
    mkRun(checkpointer, dbPath, "run-new", "complete", "2026-01-02T00:00:00Z", root);
    const oldSession = writeSessionFile({ root: sessions, agent: "echo", runId: "run-old" });
    const echoDirectory = path.join(sessions, "echo");
    chmodSync(echoDirectory, 0o755);

    const failure = capturedRetentionError(() => owner(checkpointer, sessions).run());
    expect(failure.evictedRunIds).toEqual(["run-old"]);
    expect(failure.issues).toEqual([
      {
        relative_path: "echo",
        reason_code: "agent_directory_unsafe",
      },
    ]);
    expect(runIds(dbPath)).toEqual(["run-new"]);
    expect(existsSync(oldSession)).toBe(true);

    chmodSync(echoDirectory, 0o700);
    expect(owner(checkpointer, sessions).run()).toEqual({
      evictedRunIds: [],
      removedSessionFiles: 1,
    });
    expect(existsSync(oldSession)).toBe(false);
    expect(owner(checkpointer, sessions).run()).toEqual({
      evictedRunIds: [],
      removedSessionFiles: 0,
    });
    expect(runIds(dbPath)).toEqual(["run-new"]);
    checkpointer.close();
  });
});

describe("ordinary runtime retention owner", () => {
  it("makes OrchestrationService honor the existing configured cohort cap", () => {
    const root = temporaryRoot();
    const projectRoot = path.join(root, "project");
    const stateRoot = path.join(root, "state");
    mkdirSync(projectRoot, { mode: 0o700 });
    const env = {
      PENNY_STATE_ROOT: stateRoot,
      PENNY_ORCHESTRATION_MAX_RETAINED_RUNS: "1",
    };
    initializePennyState(projectRoot, { env });
    const unusedClient: ModelClient = {
      async runAgent() {
        throw new Error("retention fixture must not invoke a model client");
      },
    };
    const service = new OrchestrationService({ projectRoot, env, modelClient: unusedClient });
    mkRun(
      service.checkpointer,
      service.config.dbPath,
      "service-old",
      "complete",
      "2026-01-01T00:00:00Z",
      projectRoot
    );
    mkRun(
      service.checkpointer,
      service.config.dbPath,
      "service-new",
      "complete",
      "2026-01-02T00:00:00Z",
      projectRoot
    );
    const oldSession = writeSessionFile({
      root: service.config.subagentSessionRoot,
      agent: "echo",
      runId: "service-old",
      projectId: service.config.projectId,
    });
    const newSession = writeSessionFile({
      root: service.config.subagentSessionRoot,
      agent: "echo",
      runId: "service-new",
      projectId: service.config.projectId,
    });
    const unsafeModeSession = writeSessionFile({
      root: service.config.subagentSessionRoot,
      agent: "echo",
      runId: "service-new",
      file: "service-new-unsafe-mode.jsonl",
      projectId: service.config.projectId,
      mode: 0o644,
    });
    const legacySession = path.join(
      service.config.subagentSessionRoot,
      "echo",
      "legacy-model-change.jsonl"
    );
    const legacyTimestamp = "2026-01-01T00:00:00.000Z";
    writeFileSync(
      legacySession,
      `${JSON.stringify({
        type: "session",
        version: CURRENT_SESSION_VERSION,
        id: "legacy-model-change-session",
        timestamp: legacyTimestamp,
        cwd: projectRoot,
      })}\n${JSON.stringify({
        type: "model_change",
        id: "legacy-model-change-entry",
        parentId: null,
        timestamp: legacyTimestamp,
        provider: "fixture",
        modelId: "fixture",
      })}\n`,
      { mode: 0o600 }
    );

    service.close();
    expect(runIds(service.config.dbPath)).toEqual(["service-new"]);
    expect(existsSync(oldSession)).toBe(false);
    expect(existsSync(newSession)).toBe(true);
    expect(existsSync(unsafeModeSession)).toBe(true);
    expect(existsSync(legacySession)).toBe(true);
  });
});
