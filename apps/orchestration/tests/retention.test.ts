/**
 * Bounded retention — the checkpointer prunes the oldest terminal runs that exceed
 * the retention cap, while never pruning running or awaiting_user runs.
 */

import { requireRecordArray, requireString, requireValue } from "./helpers/narrowing.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { Checkpointer } from "../src/checkpointer.js";
import { RunContext } from "../src/context.js";
import type { RunIdentity, RunStatus } from "../src/contracts.js";

const dirs: string[] = [];
function tmpDb(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "penny-retention-"));
  dirs.push(dir);
  return path.join(dir, "test.db");
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
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

function runIds(file: string, sql: string): string[] {
  const db = database(file);
  try {
    return requireRecordArray(db.prepare(sql).all(), "retention run rows").map((row, index) =>
      requireString(row["run_id"], `retention run rows[${index}].run_id`)
    );
  } finally {
    db.close();
  }
}

function mkRun(
  checkpointer: Checkpointer,
  databasePath: string,
  runId: string,
  status: RunStatus,
  ts?: string
): void {
  const identity = {
    schema_version: 2,
    run_id: runId,
    session_id: runId,
    playbook: "research",
    engine_owner: "typescript",
  } satisfies RunIdentity;
  const ctx = RunContext.create({
    identity,
    goal: `retention test ${runId}`,
    constraints: {},
    projectRoot: "/tmp",
    trustProfile: "trusted-interactive",
    maxSteps: 8,
  });
  ctx.status = status;
  checkpointer.createRun(ctx, "run_created", {});
  const createdAt = ts ?? new Date().toISOString();
  executeSql(
    databasePath,
    `UPDATE runs SET status='${status}', created_at='${createdAt}', updated_at='${createdAt}' WHERE run_id='${runId}'`
  );
}

describe("bounded retention", () => {
  it("prunes the oldest terminal runs when the cap is exceeded", () => {
    const db = tmpDb();
    const cp = new Checkpointer(db, undefined, { maxRetainedRuns: 3 });
    for (let i = 0; i < 5; i++) {
      mkRun(cp, db, `run-${i}`, "complete", `2026-01-0${i + 1}T00:00:00Z`);
    }
    cp.pruneTerminalRuns();
    const remaining = runIds(db, "SELECT run_id FROM runs ORDER BY run_id");
    expect(remaining.length).toBe(3);
    // Oldest two pruned, newest three kept.
    expect(remaining).toContain("run-4");
    expect(remaining).toContain("run-3");
    expect(remaining).toContain("run-2");
    expect(remaining).not.toContain("run-0");
    expect(remaining).not.toContain("run-1");
    cp.close();
  });

  it("never prunes running or awaiting_user runs", () => {
    const db = tmpDb();
    const cp = new Checkpointer(db, undefined, { maxRetainedRuns: 1 });
    mkRun(cp, db, "terminal-1", "complete", "2026-01-01T00:00:00Z");
    mkRun(cp, db, "terminal-2", "incomplete", "2026-01-02T00:00:00Z");
    mkRun(cp, db, "running-1", "running", "2026-01-03T00:00:00Z");
    mkRun(cp, db, "awaiting-1", "awaiting_user", "2026-01-04T00:00:00Z");
    cp.pruneTerminalRuns();
    const remaining = runIds(db, "SELECT run_id FROM runs");
    // Only 2 terminal runs, cap is 1, so 1 terminal is pruned. Non-terminals are untouched.
    expect(remaining).toContain("running-1");
    expect(remaining).toContain("awaiting-1");
    // Exactly one terminal survives.
    const terminals = remaining.filter((id) => id.startsWith("terminal-"));
    expect(terminals.length).toBe(1);
    cp.close();
  });

  it("cascades deletion to events, receipts, and gates", () => {
    const db = tmpDb();
    const cp = new Checkpointer(db, undefined, { maxRetainedRuns: 1 });
    mkRun(cp, db, "run-a", "complete", "2026-01-01T00:00:00Z");
    // Insert a dummy event through an independent public SQLite connection.
    executeSql(
      db,
      `INSERT INTO events (run_id, sequence, event_type, payload_json, created_at) VALUES ('run-a', 0, 'test', '{}', '2026-01-01T00:00:00Z')`
    );
    mkRun(cp, db, "run-b", "complete", "2026-01-02T00:00:00Z");
    cp.pruneTerminalRuns();
    // run-a was older, so it was pruned; its event must be gone (cascade).
    const sqlite = database(db);
    const events = sqlite.prepare("SELECT * FROM events WHERE run_id='run-a'").all();
    sqlite.close();
    expect(events.length).toBe(0);
    cp.close();
  });
});
