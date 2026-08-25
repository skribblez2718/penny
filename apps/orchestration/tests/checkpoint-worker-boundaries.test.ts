import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync as SqliteDatabase } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { ArtifactStore } from "../src/artifact-store.js";
import {
  Checkpointer,
  ReceiptConflictError,
  canonicalJson,
  sha256,
  type KbPhaseOperands,
} from "../src/checkpointer.js";
import { RunContext } from "../src/context.js";
import { KbWorkerClient, KbWorkerPostureError } from "../src/kb/kb-worker-client.js";
import type { AgentInvocation } from "../src/model-client.js";

const roots: string[] = [];

interface SqliteModule {
  readonly DatabaseSync: typeof import("node:sqlite").DatabaseSync;
}

function isSqliteModule(value: object | undefined): value is SqliteModule {
  return value !== undefined && "DatabaseSync" in value && typeof value.DatabaseSync === "function";
}

function database(file: string): SqliteDatabase {
  const sqlite = process.getBuiltinModule("node:" + "sqlite");
  if (!isSqliteModule(sqlite)) throw new Error("node:sqlite unavailable");
  return new sqlite.DatabaseSync(file);
}

function temporaryRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "penny-ts240-boundary-"));
  roots.push(root);
  return root;
}

function context(root: string, runId: string): RunContext {
  return RunContext.create({
    identity: {
      schema_version: 2,
      run_id: runId,
      session_id: "session_ts240",
      playbook: "research",
      engine_owner: "typescript",
    },
    goal: "Characterize the durable boundary.",
    constraints: { mode: "quick" },
    projectRoot: root,
    trustProfile: "hardened-untrusted",
    maxSteps: 8,
  });
}

function invocation(root: string): AgentInvocation {
  return {
    agent: "echo",
    stateId: "ingest",
    task: "Exercise only the worker control lifecycle.",
    projectRoot: root,
    trustProfile: "hardened-untrusted",
    inputArtifacts: [],
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("TS-240 checkpoint and worker production boundaries", () => {
  it("restores exact canonical KB operands and rejects an unknown SQLite projection field", () => {
    const root = temporaryRoot();
    const dbPath = path.join(root, "orchestration.db");
    using checkpointer = new Checkpointer(dbPath);
    checkpointer.createRun(context(root, "run_operand_restore"), "run_started", {});

    const operands: KbPhaseOperands = {
      schema_version: 1,
      run_id: "run_operand_restore",
      state_id: "query",
      session_id: "session_ts240",
      kb_profile_id: "profile_ts240",
      operation: "query",
      agent: "synthia",
      expected_artifact_kind: "query_answer",
      expected_media_type: "application/json",
      source_ids: [],
      prior_state_ids: [],
      allowed_prior_artifacts: [],
      allowed_selected_pages: [],
      private_input_sha256: "a".repeat(64),
      admitted_policy_sha256: "b".repeat(64),
    };
    const operandsJcs = canonicalJson(operands);
    const raw = database(dbPath);
    raw
      .prepare(
        `INSERT INTO kb_phase_operands(
           run_id,state_id,operands_jcs,operands_sha256,lifecycle,
           closed_result_sha256,created_at,closed_at
         ) VALUES (?,?,?,?,'open',NULL,?,NULL)`
      )
      .run(
        operands.run_id,
        operands.state_id,
        operandsJcs,
        sha256(operandsJcs),
        "2026-08-24T00:00:00.000Z"
      );

    const restored = checkpointer.kbPhaseOperandsRecord(operands.run_id, operands.state_id);
    if (restored === undefined) throw new Error("expected the exact KB operand row to restore");
    expect(restored.operands).toEqual(operands);
    expect(restored.operands_sha256).toBe(sha256(operandsJcs));
    expect(restored.lifecycle).toBe("open");

    const broadenedJcs = canonicalJson({ ...operands, unknown_authority: "forbidden" });
    raw
      .prepare(
        "UPDATE kb_phase_operands SET operands_jcs=?,operands_sha256=? WHERE run_id=? AND state_id=?"
      )
      .run(broadenedJcs, sha256(broadenedJcs), operands.run_id, operands.state_id);
    raw.close();

    expect(() => checkpointer.kbPhaseOperandsRecord(operands.run_id, operands.state_id)).toThrow(
      ReceiptConflictError
    );
  });

  it("preserves the open SQLite-column policy while validating the selected manifest projection", () => {
    const root = temporaryRoot();
    using store = new ArtifactStore(path.join(root, "artifacts"));
    const ref = store.persist({
      metadata: {
        schema_version: 2,
        run_id: "run_projection_policy",
        phase: "analysis",
        branch_id: null,
        kind: "agent-output",
        operation_id: "operation_projection_policy",
        version: 1,
        producer: "agent:echo",
        media_type: "text/plain",
        parent_ref: null,
        upstream_refs: [],
      },
      content: "projection policy bytes",
    });
    const raw = database(path.join(root, "artifacts", "manifest.db"));
    raw.exec("ALTER TABLE artifacts ADD COLUMN future_metadata TEXT");
    expect(store.refById(ref.artifact_id)).toEqual(ref);

    raw.exec("DROP TRIGGER artifacts_no_update");
    raw
      .prepare("UPDATE artifacts SET ref_json=? WHERE artifact_id=?")
      .run(Buffer.from("not text", "utf8"), ref.artifact_id);
    raw.close();
    expect(() => store.refById(ref.artifact_id)).toThrow(/ref_json is not text/i);
  });

  it("fails closed when persisted event JSON is not the named object contract", () => {
    const root = temporaryRoot();
    const dbPath = path.join(root, "orchestration.db");
    using checkpointer = new Checkpointer(dbPath);
    checkpointer.createRun(context(root, "run_event_restore"), "run_started", {
      run_id: "run_event_restore",
    });

    const before = checkpointer.events("run_event_restore");
    expect(before).toHaveLength(1);
    expect(before[0]?.payload).toEqual({ run_id: "run_event_restore" });

    const raw = database(dbPath);
    raw
      .prepare("UPDATE events SET payload_json='[]' WHERE run_id=? AND sequence=1")
      .run("run_event_restore");
    raw.close();

    expect(() => checkpointer.events("run_event_restore")).toThrow(/schema validation/i);
  });

  it("models unbound, bound, closed, and rebound worker control states explicitly", async () => {
    const root = temporaryRoot();
    const checkpointer = new Checkpointer(path.join(root, "orchestration.db"));
    const worker = new KbWorkerClient({
      projectRoot: root,
      kbRoot: root,
      runId: "run_worker_lifecycle",
      sessionId: "session_ts240",
      profileId: "profile_ts240",
      operation: "ingest",
      sourceIds: [],
      testOnlyAgentRunner: async () => {
        throw new Error("runner must not be reached by a lifecycle-only test");
      },
    });

    await expect(worker.runAgent(invocation(root))).rejects.toBeInstanceOf(KbWorkerPostureError);

    worker.bindCheckpointer(checkpointer);
    worker.bindCheckpointer(checkpointer);
    worker.close();
    worker.close();
    await expect(worker.runAgent(invocation(root))).rejects.toBeInstanceOf(KbWorkerPostureError);

    worker.bindCheckpointer(checkpointer);
    worker.close();
    checkpointer.close();
  });
});
