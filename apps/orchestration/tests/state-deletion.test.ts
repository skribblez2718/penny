import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { Checkpointer } from "../src/checkpointer.js";
import {
  applyStateMigration,
  createStateMigrationPlan,
  deleteStateMigrationLegacy,
  finalizeStateMigration,
  prepareStateMigrationDeletion,
  resolvePennyProjectState,
  verifyStateMigration,
} from "../src/state/index.js";

const roots: string[] = [];
const sqlite = process.getBuiltinModule("node:sqlite");

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "penny-state-delete-"));
  roots.push(root);
  const projectRoot = path.join(root, "project");
  const control = path.join(root, "control");
  const legacy = path.join(root, "legacy");
  mkdirSync(projectRoot, { mode: 0o700 });
  mkdirSync(control, { mode: 0o700 });
  mkdirSync(legacy, { mode: 0o700 });
  const database = path.join(legacy, "orchestration-v2.db");
  {
    using _checkpointer = new Checkpointer(database);
  }
  const source = new sqlite.DatabaseSync(database);
  source.exec("DROP TABLE store_metadata; PRAGMA user_version=9");
  source.close();
  const key = path.join(legacy, "receipt-key");
  writeFileSync(key, Buffer.alloc(32, 0x62), { mode: 0o600 });
  const chains = path.join(legacy, "chains");
  mkdirSync(chains, { mode: 0o700 });
  const sourceManifestPath = path.join(control, "sources.json");
  writeFileSync(
    sourceManifestPath,
    `${JSON.stringify({
      schema_version: 1,
      migration_id: "deletion-fixture",
      stores: [
        { id: "orchestration-db", kind: "sqlite", path: database },
        { id: "orchestration-receipt-key", kind: "file", path: key },
        { id: "skill-chains", kind: "tree", path: chains },
      ],
    })}\n`,
    { mode: 0o600 }
  );
  const deletionManifestPath = path.join(control, "deletion.json");
  writeFileSync(
    deletionManifestPath,
    `${JSON.stringify({
      schema_version: 1,
      migration_id: "deletion-fixture",
      entries: [{ id: "legacy-root", path: legacy, kind: "tree" }],
    })}\n`,
    { mode: 0o600 }
  );
  const planPath = path.join(control, "plan.json");
  const approvalPath = path.join(control, "approval.json");
  const rootOptions = { env: { PENNY_STATE_ROOT: path.join(root, "state") } } as const;
  createStateMigrationPlan({
    projectRoot,
    sourceManifestPath,
    outputPath: planPath,
    rootOptions,
  });
  return {
    projectRoot,
    legacy,
    sourceManifestPath,
    deletionManifestPath,
    planPath,
    approvalPath,
    rootOptions,
  };
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("one-time legacy deletion authority", () => {
  it("checksum-binds one approval, deletes only declared legacy state, and reruns as a no-op", async () => {
    const input = fixture();
    await applyStateMigration({
      projectRoot: input.projectRoot,
      sourceManifestPath: input.sourceManifestPath,
      planPath: input.planPath,
      rootOptions: input.rootOptions,
    });
    await verifyStateMigration({
      projectRoot: input.projectRoot,
      planPath: input.planPath,
      rootOptions: input.rootOptions,
    });
    await finalizeStateMigration({
      projectRoot: input.projectRoot,
      planPath: input.planPath,
      rootOptions: input.rootOptions,
    });

    await expect(
      prepareStateMigrationDeletion({
        ...input,
        confirmation: "wrong",
      })
    ).rejects.toThrow("confirmation phrase");
    const approval = await prepareStateMigrationDeletion({
      ...input,
      confirmation: "deletion-fixture:DELETE-ALL-MANAGED-LEGACY",
    });
    expect(approval.status).toBe("approved");
    expect(existsSync(input.legacy)).toBe(true);

    const deleted = await deleteStateMigrationLegacy(input);
    expect(deleted.status).toBe("completed");
    expect(deleted.completed_entry_ids).toEqual(["legacy-root"]);
    expect(existsSync(input.legacy)).toBe(false);
    expect(resolvePennyProjectState(input.projectRoot, input.rootOptions).projectId).toBe(
      approval.project_id
    );
    await expect(deleteStateMigrationLegacy(input)).resolves.toMatchObject({
      status: "completed",
    });
  });

  it("fails closed on a wrong-typed persisted approval before deleting bytes", async () => {
    const input = fixture();
    await applyStateMigration({
      projectRoot: input.projectRoot,
      sourceManifestPath: input.sourceManifestPath,
      planPath: input.planPath,
      rootOptions: input.rootOptions,
    });
    await verifyStateMigration({
      projectRoot: input.projectRoot,
      planPath: input.planPath,
      rootOptions: input.rootOptions,
    });
    await finalizeStateMigration({
      projectRoot: input.projectRoot,
      planPath: input.planPath,
      rootOptions: input.rootOptions,
    });
    await prepareStateMigrationDeletion({
      ...input,
      confirmation: "deletion-fixture:DELETE-ALL-MANAGED-LEGACY",
    });
    const parsed: unknown = JSON.parse(readFileSync(input.approvalPath, "utf8"));
    if (!isUnknownRecord(parsed)) throw new Error("expected a persisted approval object");
    writeFileSync(
      input.approvalPath,
      `${JSON.stringify({ ...parsed, completed_entry_ids: [42] })}\n`,
      { mode: 0o600 }
    );

    await expect(deleteStateMigrationLegacy(input)).rejects.toThrow(
      "legacy deletion approval is invalid"
    );
    expect(existsSync(input.legacy)).toBe(true);
  });

  it("refuses source drift after approval", async () => {
    const input = fixture();
    await applyStateMigration({
      projectRoot: input.projectRoot,
      sourceManifestPath: input.sourceManifestPath,
      planPath: input.planPath,
      rootOptions: input.rootOptions,
    });
    await verifyStateMigration({
      projectRoot: input.projectRoot,
      planPath: input.planPath,
      rootOptions: input.rootOptions,
    });
    await finalizeStateMigration({
      projectRoot: input.projectRoot,
      planPath: input.planPath,
      rootOptions: input.rootOptions,
    });
    await prepareStateMigrationDeletion({
      ...input,
      confirmation: "deletion-fixture:DELETE-ALL-MANAGED-LEGACY",
    });
    const added = path.join(input.legacy, "changed");
    writeFileSync(added, "drift", { mode: 0o600 });
    chmodSync(added, 0o600);
    await expect(deleteStateMigrationLegacy(input)).rejects.toThrow(
      /changed after approval|changed/
    );
    expect(existsSync(input.legacy)).toBe(true);
  });
});
