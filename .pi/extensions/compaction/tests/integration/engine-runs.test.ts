/**
 * Integration test: queryEngineRuns reads real run state from a real
 * SQLite checkpointer DB (same schema as apps/orchestration checkpointer),
 * via the venv Python.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

// Tests run with CWD = the extension dir; resolve the repo root (and its
// venv) relative to this file, and pin it BEFORE importing bridge.js so
// BRIDGE_CONFIG picks it up.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");
const venvPython = process.env.PI_VENV_PYTHON || join(repoRoot, ".venv/bin/python");
const pythonAvailable = existsSync(venvPython);
process.env.PI_VENV_PYTHON = venvPython;

const { queryEngineRuns } = await import("../../bridge.js");

const FIXTURE_SCRIPT = `
import json, sqlite3, sys
path = sys.argv[1]
conn = sqlite3.connect(path)
conn.executescript("""
CREATE TABLE IF NOT EXISTS runs (
  run_id           TEXT PRIMARY KEY,
  session_id       TEXT NOT NULL,
  playbook         TEXT NOT NULL,
  current_state_id TEXT NOT NULL,
  context_json     TEXT NOT NULL,
  status           TEXT NOT NULL,
  created_at       TEXT,
  updated_at       TEXT
);
""")
ctx = json.dumps({"goal": "Migrate research skill onto engine", "clarification_text": "Keep fixture?"})
rows = [
    ("code-a1b2c3", "code-1751700000000", "code", "VERIFY", ctx, "awaiting_user", "t0", "2026-07-05T12:00:00+00:00"),
    ("code-old111", "code-1751600000000", "code", "LEARN", "{}", "complete", "t0", "2026-07-04T12:00:00+00:00"),
    ("plan-run222", "plan-1751690000000", "plan", "PLAN", "not-json", "running", "t0", "2026-07-05T11:00:00+00:00"),
]
conn.executemany("INSERT INTO runs VALUES (?,?,?,?,?,?,?,?)", rows)
conn.commit()
`;

describe.skipIf(!pythonAvailable)("queryEngineRuns (real SQLite)", () => {
  let dir: string;
  let dbPath: string;
  const prevEnv = process.env.PENNY_ORCH_DB;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "compaction-engine-test-"));
    dbPath = join(dir, "orchestration.db");
    execFileSync(venvPython, ["-c", FIXTURE_SCRIPT, dbPath]);
    process.env.PENNY_ORCH_DB = dbPath;
  });

  afterAll(() => {
    if (prevEnv === undefined) delete process.env.PENNY_ORCH_DB;
    else process.env.PENNY_ORCH_DB = prevEnv;
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns pending runs only, newest first, with context fields", async () => {
    const runs = await queryEngineRuns();
    expect(runs.map((r) => r.run_id)).toEqual(["code-a1b2c3", "plan-run222"]);

    const code = runs[0];
    expect(code).toMatchObject({
      session_id: "code-1751700000000",
      playbook: "code",
      current_state_id: "VERIFY",
      status: "awaiting_user",
      goal: "Migrate research skill onto engine",
      clarification_text: "Keep fixture?",
    });

    // Malformed context_json degrades to no goal, not a crash
    const plan = runs[1];
    expect(plan.status).toBe("running");
    expect(plan.goal).toBeUndefined();
  });

  it("returns [] when the DB does not exist", async () => {
    process.env.PENNY_ORCH_DB = join(dir, "missing.db");
    const runs = await queryEngineRuns();
    expect(runs).toEqual([]);
    process.env.PENNY_ORCH_DB = dbPath;
  });
});
