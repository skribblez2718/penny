import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Checkpointer, initializePennyState } from "@penny/orchestration/source";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { readExactCheckpoints } from "../../checkpointer.js";
import { ArtifactRefSchema } from "../../schema.js";

const sqlite = process.getBuiltinModule("node:sqlite");
if (sqlite === undefined) throw new Error("node:sqlite unavailable");
const { DatabaseSync } = sqlite;

function artifactRef(runId: string, operationId: string, digest = "a".repeat(64)) {
  const identity = {
    branch_id: null,
    kind: "agent-output",
    operation_id: operationId,
    phase: "observing",
    run_id: runId,
    version: 1,
  };
  return {
    schema_version: 1,
    artifact_id: `art_${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`,
    run_id: runId,
    phase: "observing",
    branch_id: null,
    kind: "agent-output",
    operation_id: operationId,
    version: 1,
    producer: "agent:echo",
    consumer_scope: ["state:framing"],
    media_type: "text/markdown; charset=utf-8",
    byte_length: 123,
    content_digest: digest,
    store_ref: `artifact://sha256/${digest}`,
  };
}

function context(runId: string, selectedRefs: unknown[]) {
  return JSON.stringify({
    goal: `Goal for ${runId}`,
    clarification_text: "Keep the fixture?",
    selected_artifacts: selectedRefs,
  });
}

describe("readExactCheckpoints (TypeScript v2 read-only SQLite)", () => {
  let directory: string;
  let projectRoot: string;
  let databasePath: string;
  const previousStateRoot = process.env.PENNY_STATE_ROOT;
  const previousDatabase = process.env.PENNY_ORCH_V2_DB;
  const selected = artifactRef("run-current", "observe-1");

  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), "compaction-checkpointer-"));
    projectRoot = join(directory, "project");
    mkdirSync(projectRoot, { mode: 0o700 });
    process.env.PENNY_STATE_ROOT = join(directory, "state");
    delete process.env.PENNY_ORCH_V2_DB;
    const state = initializePennyState(projectRoot, { env: process.env });
    databasePath = state.paths.orchestration.database;
    const checkpointer = new Checkpointer(databasePath, undefined, {
      projectId: state.projectId,
    });
    checkpointer.close();
    const database = new DatabaseSync(databasePath);
    const insert = database.prepare(
      "INSERT INTO runs(" +
        "run_id, session_id, playbook, engine_owner, schema_version, status, state_id, " +
        "context_json, created_at, updated_at" +
        ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    );
    insert.run(
      "run-current",
      "session-current",
      "research",
      "typescript",
      2,
      "awaiting_user",
      "framing",
      context("run-current", [selected]),
      "t0",
      "2026-08-15T12:00:00Z"
    );
    insert.run(
      "run-unrelated",
      "session-unrelated",
      "research",
      "typescript",
      2,
      "running",
      "observing",
      context("run-unrelated", [artifactRef("run-unrelated", "observe-2")]),
      "t0",
      "2026-08-15T13:00:00Z"
    );
    insert.run(
      "run-complete",
      "session-current",
      "research",
      "typescript",
      2,
      "complete",
      "complete",
      context("run-complete", []),
      "t0",
      "2026-08-15T14:00:00Z"
    );
    database.close();
  });

  afterAll(() => {
    if (previousStateRoot === undefined) delete process.env.PENNY_STATE_ROOT;
    else process.env.PENNY_STATE_ROOT = previousStateRoot;
    if (previousDatabase === undefined) delete process.env.PENNY_ORCH_V2_DB;
    else process.env.PENNY_ORCH_V2_DB = previousDatabase;
    rmSync(directory, { recursive: true, force: true });
  });

  it("reads only caller-supplied exact run IDs and selected artifact refs", () => {
    const result = readExactCheckpoints(["run-current"], projectRoot);
    expect(result.runs.map((run) => run.run_id)).toEqual(["run-current"]);
    expect(result.runs[0]).toMatchObject({
      playbook: "research",
      current_state_id: "framing",
      status: "awaiting_user",
      clarification_text: "Keep the fixture?",
    });
    expect(result.artifactRefs).toEqual([ArtifactRefSchema.parse(selected)]);
    expect(result.runs).not.toContainEqual(expect.objectContaining({ run_id: "run-unrelated" }));
  });

  it("supports a fresh reader using only the prior exact run ref", () => {
    const previousSummary = "[RESUME-REFS v2]\nrun:run-current\n[/RESUME-REFS]";
    const runId = previousSummary.match(/^run:(.+)$/m)?.[1];
    const result = readExactCheckpoints(runId ? [runId] : [], projectRoot);
    expect(result.runs[0]?.run_id).toBe("run-current");
    expect(result.artifactRefs[0]?.artifact_id).toBe(selected.artifact_id);
  });

  it("does not require artifact object bytes to preserve a valid selected ref", () => {
    const result = readExactCheckpoints(["run-current"], projectRoot);
    expect(result.runs).toHaveLength(1);
    expect(result.artifactRefs).toHaveLength(1);
  });

  it("rejects a corrupt selected ref without blocking its run reference", () => {
    const database = new DatabaseSync(databasePath);
    const corrupt = { ...selected, store_ref: `artifact://sha256/${"b".repeat(64)}` };
    database
      .prepare("UPDATE runs SET context_json = ? WHERE run_id = ?")
      .run(context("run-current", [corrupt]), "run-current");
    database.close();

    const result = readExactCheckpoints(["run-current"], projectRoot);
    expect(result.runs).toHaveLength(1);
    expect(result.artifactRefs).toEqual([]);
    expect(result.issues[0]).toContain("selected_artifacts[0] rejected");

    const restore = new DatabaseSync(databasePath);
    restore
      .prepare("UPDATE runs SET context_json = ? WHERE run_id = ?")
      .run(context("run-current", [selected]), "run-current");
    restore.close();
  });

  it("skips terminal or missing exact IDs and degrades on a missing database", () => {
    expect(readExactCheckpoints(["run-complete", "does-not-exist"], projectRoot).runs).toEqual([]);
    const missingPath = `${databasePath}.missing`;
    renameSync(databasePath, missingPath);
    try {
      expect(readExactCheckpoints(["run-current"], projectRoot)).toEqual({
        runs: [],
        artifactRefs: [],
        issues: [],
      });
    } finally {
      renameSync(missingPath, databasePath);
    }
  });
});
