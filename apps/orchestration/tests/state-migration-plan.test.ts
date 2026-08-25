import {
  parseJson,
  requireRecord,
  requireString,
  requireValue,
  requireSqlite,
} from "./helpers/narrowing.js";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createStateMigrationPlan, executeStateCommand } from "../src/state/index.js";

const sqlite = process.getBuiltinModule("node:sqlite");
const roots: string[] = [];

function sandbox(): string {
  const root = mkdtempSync(path.join(tmpdir(), "penny-state-migration-plan-test-"));
  roots.push(root);
  return root;
}

function sourceFixture(root: string): {
  projectRoot: string;
  sourceManifest: string;
  database: string;
  key: string;
  tree: string;
} {
  const projectRoot = path.join(root, "private-project-name");
  mkdirSync(projectRoot, { mode: 0o700 });

  const database = path.join(root, "orchestration-v2.db");
  const db = new (requireSqlite(
    sqlite,
    "apps/orchestration/tests/state-migration-plan.test.ts:39"
  ).DatabaseSync)(database);
  db.exec(`
    PRAGMA user_version=9;
    CREATE TABLE runs(run_id TEXT PRIMARY KEY, status TEXT NOT NULL) STRICT;
    INSERT INTO runs VALUES('run-a', 'running'), ('run-b', 'complete');
  `);
  db.close();
  chmodSync(database, 0o600);

  const key = path.join(root, "orchestration-v2.db.receipt-key");
  writeFileSync(key, Buffer.alloc(32, 7), { mode: 0o600 });

  const tree = path.join(root, "skill-chains");
  mkdirSync(tree, { mode: 0o700 });
  writeFileSync(
    path.join(tree, "chain-a.json"),
    `${JSON.stringify({
      schema_version: 1,
      chain_session_id: "chain-a",
      chain_run_id: "chain-a",
      chain_goal_summary: "fixture chain",
      steps: [],
      current_step: 0,
      total_steps: 0,
      chain_status: "failed",
      pending_steps: [],
      created_at: "2026-08-22T00:00:00.000Z",
      updated_at: "2026-08-22T00:00:00.000Z",
    })}\n`,
    { mode: 0o600 }
  );

  const sourceManifest = path.join(root, "sources.json");
  writeFileSync(
    sourceManifest,
    `${JSON.stringify({
      schema_version: 1,
      migration_id: "migration-fixture-001",
      stores: [
        { id: "orchestration-db", kind: "sqlite", path: database },
        { id: "orchestration-receipt-key", kind: "file", path: key },
        { id: "skill-chains", kind: "tree", path: tree },
      ],
    })}\n`,
    { mode: 0o600 }
  );
  return { projectRoot, sourceManifest, database, key, tree };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("read-only state migration planning", () => {
  it("inventories explicit SQLite, file, and tree sources without persisting raw paths", () => {
    const root = sandbox();
    const fixture = sourceFixture(root);
    const output = path.join(root, "plan.json");
    const databaseBefore = readFileSync(fixture.database);
    const keyBefore = readFileSync(fixture.key);

    const plan = createStateMigrationPlan({
      projectRoot: fixture.projectRoot,
      sourceManifestPath: fixture.sourceManifest,
      outputPath: output,
      rootOptions: { env: { PENNY_STATE_ROOT: path.join(root, "target-state") } },
    });

    expect(plan.stores.map((store) => store.id)).toEqual([
      "orchestration-db",
      "orchestration-receipt-key",
      "skill-chains",
    ]);
    const orchestration = plan.stores[0];
    expect(orchestration?.source_snapshot.kind).toBe("sqlite");
    if (orchestration?.source_snapshot.kind !== "sqlite") {
      throw new Error("expected SQLite source snapshot");
    }
    expect(orchestration.source_snapshot.sqlite).toMatchObject({
      user_version: 9,
      quick_check: "ok",
      foreign_key_violation_count: 0,
    });
    expect(orchestration.source_snapshot.sqlite.tables).toContainEqual({
      name: "runs",
      row_count: 2,
    });
    const chains = plan.stores.find((store) => store.id === "skill-chains");
    expect(chains?.source_snapshot.kind).toBe("tree");
    if (chains?.source_snapshot.kind !== "tree") {
      throw new Error("expected skill-chain source snapshot");
    }
    const chainFile = requireValue(chains.source_snapshot.files[0], "first skill-chain file");
    expect(chainFile.kind).toBe("file");
    if (chainFile.kind !== "file") throw new Error("expected a skill-chain file snapshot");
    expect(typeof chainFile.target_size).toBe("number");
    expect(chainFile.target_sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(readFileSync(fixture.database)).toEqual(databaseBefore);
    expect(readFileSync(fixture.key)).toEqual(keyBefore);
    expect(lstatSync(output).mode & 0o777).toBe(0o600);

    const persisted = readFileSync(output, "utf8");
    expect(persisted).not.toContain(fixture.projectRoot);
    expect(persisted).not.toContain(fixture.database);
    expect(persisted).not.toContain(fixture.key);
    expect(persisted).not.toContain("chain-a.json");
    expect(persisted).not.toContain("fixture chain");
    const persistedPlan = requireRecord(parseJson(persisted), "persisted migration plan");
    expect(requireString(persistedPlan["plan_sha256"], "persisted migration plan digest")).toBe(
      plan.plan_sha256
    );
  });

  it("is exposed only as an explicit operator command", async () => {
    const root = sandbox();
    const fixture = sourceFixture(root);
    const output = path.join(root, "plan.json");
    const result = await executeStateCommand(
      [
        "migrate",
        "plan",
        `--project-root=${fixture.projectRoot}`,
        `--source-manifest=${fixture.sourceManifest}`,
        `--output=${output}`,
      ],
      { PENNY_STATE_ROOT: path.join(root, "target-state") }
    );
    expect(result).toMatchObject({
      schema_version: 1,
      action: "migrate-plan",
      migration_id: "migration-fixture-001",
      output,
    });
  });

  it("rejects duplicate stores and unsafe tree entries", () => {
    const root = sandbox();
    const fixture = sourceFixture(root);
    const duplicateManifest = path.join(root, "duplicate.json");
    writeFileSync(
      duplicateManifest,
      `${JSON.stringify({
        schema_version: 1,
        migration_id: "duplicate",
        stores: [
          { id: "orchestration-db", kind: "sqlite", path: fixture.database },
          { id: "orchestration-db", kind: "sqlite", path: fixture.database },
        ],
      })}\n`,
      { mode: 0o600 }
    );
    expect(() =>
      createStateMigrationPlan({
        projectRoot: fixture.projectRoot,
        sourceManifestPath: duplicateManifest,
        outputPath: path.join(root, "duplicate-plan.json"),
      })
    ).toThrow("duplicate store IDs");

    symlinkSync(fixture.key, path.join(fixture.tree, "unsafe-link"));
    expect(() =>
      createStateMigrationPlan({
        projectRoot: fixture.projectRoot,
        sourceManifestPath: fixture.sourceManifest,
        outputPath: path.join(root, "unsafe-plan.json"),
      })
    ).toThrow("symbolic link");
  });
});
