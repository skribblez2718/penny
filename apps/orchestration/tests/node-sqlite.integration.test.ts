import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Node SQLite runtime spike", () => {
  it("supports WAL, transactions, foreign keys, and a second connection", () => {
    // Vite 5 predates node:sqlite, so resolve the built-in through Node itself.
    const sqlite = process.getBuiltinModule("node:" + "sqlite") as
      | typeof import("node:sqlite")
      | undefined;
    expect(sqlite).toBeDefined();
    const DatabaseSync = sqlite!.DatabaseSync;
    const directory = mkdtempSync(path.join(tmpdir(), "penny-orch-sqlite-"));
    tempDirectories.push(directory);
    const dbPath = path.join(directory, "orchestration-v2.db");
    const first = new DatabaseSync(dbPath);
    first.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    first.exec(
      "CREATE TABLE runs(run_id TEXT PRIMARY KEY);" +
        "CREATE TABLE events(id INTEGER PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(run_id));"
    );
    first.exec("BEGIN IMMEDIATE");
    first.prepare("INSERT INTO runs(run_id) VALUES(?)").run("run-001");
    first.prepare("INSERT INTO events(run_id) VALUES(?)").run("run-001");
    first.exec("COMMIT");

    expect(() =>
      first.prepare("INSERT INTO events(run_id) VALUES(?)").run("missing-run")
    ).toThrow();

    const second = new DatabaseSync(dbPath);
    expect(second.prepare("SELECT run_id FROM runs WHERE run_id = ?").get("run-001")).toEqual({
      run_id: "run-001",
    });
    expect(first.prepare("PRAGMA journal_mode").get()).toEqual({
      journal_mode: "wal",
    });
    second.close();
    first.close();
  });
});
