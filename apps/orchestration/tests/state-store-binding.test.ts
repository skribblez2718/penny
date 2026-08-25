import { requireNumber, requireRecord, requireString, requireSqlite } from "./helpers/narrowing.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { Checkpointer } from "../src/checkpointer.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("project-bound orchestration stores", () => {
  it("binds orchestration.db to one opaque project ID at schema v10", () => {
    const root = mkdtempSync(path.join(tmpdir(), "penny-orchestration-binding-test-"));
    roots.push(root);
    const databasePath = path.join(root, "orchestration.db");
    const firstProject = `prj_${"1".repeat(32)}`;
    const secondProject = `prj_${"2".repeat(32)}`;

    const first = new Checkpointer(databasePath, undefined, { projectId: firstProject });
    first.close();

    expect(() => new Checkpointer(databasePath, undefined, { projectId: secondProject })).toThrow(
      "belongs to another Penny project"
    );

    const sqlite = process.getBuiltinModule("node:sqlite");
    const database = new (requireSqlite(
      sqlite,
      "apps/orchestration/tests/state-store-binding.test.ts:32"
    ).DatabaseSync)(databasePath, { readOnly: true });
    const version = requireRecord(
      database.prepare("PRAGMA user_version").get(),
      "orchestration schema version row"
    );
    const binding = requireRecord(
      database.prepare("SELECT project_id FROM store_metadata").get(),
      "orchestration project binding row"
    );
    database.close();
    expect(requireNumber(version["user_version"], "schema user_version")).toBe(10);
    expect(requireString(binding["project_id"], "store project_id")).toBe(firstProject);
  });
});
