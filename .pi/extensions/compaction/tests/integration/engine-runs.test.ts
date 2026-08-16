import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const { DatabaseSync } = createRequire(import.meta.url)(
  "node:sqlite"
) as typeof import("node:sqlite");

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { readExactCheckpoints } from "../../checkpointer.js";

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
    extras: {
      artifact_protocol: {
        schema_version: 2,
        selected_refs: selectedRefs,
        state_inputs: {},
        parallel_fan_in: {},
      },
    },
  });
}

describe("readExactCheckpoints (real read-only SQLite)", () => {
  let directory: string;
  let databasePath: string;
  const previousDatabase = process.env.PENNY_ORCH_DB;
  const selected = artifactRef("run-current", "observe-1");

  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), "compaction-checkpointer-"));
    databasePath = join(directory, "orchestration.db");
    const database = new DatabaseSync(databasePath);
    database.exec(`
      CREATE TABLE runs (
        run_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        playbook TEXT NOT NULL,
        current_state_id TEXT NOT NULL,
        context_json TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT,
        updated_at TEXT
      )
    `);
    const insert = database.prepare("INSERT INTO runs VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    insert.run(
      "run-current",
      "session-current",
      "research",
      "framing",
      context("run-current", [selected]),
      "awaiting_user",
      "t0",
      "2026-08-15T12:00:00Z"
    );
    insert.run(
      "run-unrelated",
      "session-unrelated",
      "research",
      "observing",
      context("run-unrelated", [artifactRef("run-unrelated", "observe-2")]),
      "running",
      "t0",
      "2026-08-15T13:00:00Z"
    );
    insert.run(
      "run-complete",
      "session-current",
      "research",
      "complete",
      context("run-complete", []),
      "complete",
      "t0",
      "2026-08-15T14:00:00Z"
    );
    database.close();
    process.env.PENNY_ORCH_DB = databasePath;
  });

  afterAll(() => {
    if (previousDatabase === undefined) delete process.env.PENNY_ORCH_DB;
    else process.env.PENNY_ORCH_DB = previousDatabase;
    rmSync(directory, { recursive: true, force: true });
  });

  it("reads only caller-supplied exact run IDs and selected artifact refs", () => {
    const result = readExactCheckpoints(["run-current"]);
    expect(result.runs.map((run) => run.run_id)).toEqual(["run-current"]);
    expect(result.runs[0]).toMatchObject({
      playbook: "research",
      current_state_id: "framing",
      status: "awaiting_user",
      clarification_text: "Keep the fixture?",
    });
    expect(result.artifactRefs).toEqual([selected]);
    expect(result.runs).not.toContainEqual(expect.objectContaining({ run_id: "run-unrelated" }));
  });

  it("supports a fresh reader using only the prior exact run ref", () => {
    const previousSummary = "[RESUME-REFS v2]\nrun:run-current\n[/RESUME-REFS]";
    const runId = previousSummary.match(/^run:(.+)$/m)?.[1];
    const result = readExactCheckpoints(runId ? [runId] : []);
    expect(result.runs[0]?.run_id).toBe("run-current");
    expect(result.artifactRefs[0]?.artifact_id).toBe(selected.artifact_id);
  });

  it("does not require artifact object bytes to preserve a valid selected ref", () => {
    // No artifact store exists in this fixture. Compaction validates exact ref
    // metadata but never opens raw artifact content.
    const result = readExactCheckpoints(["run-current"]);
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

    const result = readExactCheckpoints(["run-current"]);
    expect(result.runs).toHaveLength(1);
    expect(result.artifactRefs).toEqual([]);
    expect(result.issues[0]).toContain("selected_refs[0] rejected");

    const restore = new DatabaseSync(databasePath);
    restore
      .prepare("UPDATE runs SET context_json = ? WHERE run_id = ?")
      .run(context("run-current", [selected]), "run-current");
    restore.close();
  });

  it("skips terminal or missing exact IDs and degrades on a missing database", () => {
    expect(readExactCheckpoints(["run-complete", "does-not-exist"]).runs).toEqual([]);
    process.env.PENNY_ORCH_DB = join(directory, "missing.db");
    expect(readExactCheckpoints(["run-current"])).toEqual({
      runs: [],
      artifactRefs: [],
      issues: [],
    });
    process.env.PENNY_ORCH_DB = databasePath;
  });
});
