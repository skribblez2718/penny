import {
  parseJson,
  requireRecord,
  requireRecordArray,
  requireString,
  requireValue,
  requireSqlite,
} from "./helpers/narrowing.js";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ArtifactStore } from "../src/artifact-store.js";
import { Checkpointer } from "../src/checkpointer.js";
import { ReceiptAuthority } from "../src/receipts.js";
import {
  applyStateMigration,
  createStateMigrationPlan,
  verifyStateMigration,
} from "../src/state/index.js";

const sqlite = process.getBuiltinModule("node:sqlite");
const roots: string[] = [];
const CREATED_AT = "2026-08-23T00:00:00.000Z";

function sandbox(): string {
  const root = mkdtempSync(path.join(tmpdir(), "penny-state-reconciliation-test-"));
  roots.push(root);
  return root;
}

function orchestrationSource(
  databasePath: string,
  runs: readonly { readonly runId: string; readonly status: "running" | "complete" }[]
): void {
  using _initialized = new Checkpointer(databasePath);
  const database = new (requireSqlite(
    sqlite,
    "apps/orchestration/tests/state-reconciliation.test.ts:40"
  ).DatabaseSync)(databasePath);
  try {
    database.exec("DROP TABLE store_metadata; PRAGMA user_version=9;");
    const insert = database.prepare(
      `INSERT INTO runs(
        run_id,session_id,playbook,engine_owner,schema_version,status,
        state_id,context_json,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?)`
    );
    for (const run of runs) {
      insert.run(
        run.runId,
        `session-${run.runId}`,
        "research",
        "typescript",
        2,
        run.status,
        run.status === "complete" ? "terminal" : "dispatch",
        "{}",
        CREATED_AT,
        CREATED_AT
      );
    }
  } finally {
    database.close();
  }
  chmodSync(databasePath, 0o600);
}

function addSignedReceipt(databasePath: string, keyPath: string, runId: string): void {
  const authority = ReceiptAuthority.loadExisting(keyPath);
  const digest = "a".repeat(64);
  const receipt = authority.sign({
    schema_version: 2,
    receipt_id: `receipt-${runId}`,
    run_id: runId,
    state_id: "dispatch",
    branch_id: "main",
    agent: "annie",
    attempt: 1,
    worker_id: "worker-fixture",
    executor: "pi-sdk",
    command: ["fixture"],
    model: null,
    working_directory: "/fixture",
    trust_profile: "trusted-interactive",
    started_at: CREATED_AT,
    ended_at: CREATED_AT,
    exit_code: 0,
    output_digest: digest,
    output_artifact_ref: {
      schema_version: 2,
      artifact_id: `art_${"b".repeat(64)}`,
      run_id: runId,
      phase: "dispatch",
      branch_id: "main",
      kind: "agent-output",
      operation_id: "operation-fixture",
      version: 1,
      producer: "agent:annie",
      media_type: "text/plain",
      byte_length: 0,
      content_digest: digest,
      store_ref: `artifact://sha256/${digest}`,
    },
    trusted_invocation_digest: "c".repeat(64),
  });
  const database = new (requireSqlite(
    sqlite,
    "apps/orchestration/tests/state-reconciliation.test.ts:107"
  ).DatabaseSync)(databasePath);
  try {
    database
      .prepare(
        `INSERT INTO receipts(
          receipt_id,run_id,state_id,branch_id,agent,attempt,worker_id,
          output_digest,result_json,created_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        receipt.receipt_id,
        receipt.run_id,
        receipt.state_id,
        receipt.branch_id,
        receipt.agent,
        receipt.attempt,
        receipt.worker_id,
        receipt.output_digest,
        JSON.stringify(receipt),
        CREATED_AT
      );
  } finally {
    database.close();
  }
}

function writeManifest(file: string, value: unknown): void {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function reconciliationPaths(root: string): {
  readonly projectRoot: string;
  readonly stateRoot: string;
  readonly planPath: string;
  readonly sourceManifest: string;
} {
  const projectRoot = path.join(root, "project");
  mkdirSync(projectRoot, { mode: 0o700 });
  return {
    projectRoot,
    stateRoot: path.join(root, "state"),
    planPath: path.join(root, "plan.json"),
    sourceManifest: path.join(root, "sources.json"),
  };
}

function artifactMetadata(input: {
  readonly operationId: string;
  readonly version: number;
  readonly parentRef: ReturnType<ArtifactStore["persist"]> | null;
}) {
  return {
    schema_version: 2 as const,
    run_id: "run-artifact-reconciliation",
    phase: "analysis",
    branch_id: null,
    kind: "agent-output" as const,
    operation_id: input.operationId,
    version: input.version,
    producer: "agent:annie",
    media_type: "text/plain",
    parent_ref: input.parentRef,
    upstream_refs: [],
  };
}

function copyArtifactObject(sourceRoot: string, targetRoot: string, digest: string): void {
  const relative = path.join("sha256", digest.slice(0, 2), digest.slice(2));
  const target = path.join(targetRoot, "objects", relative);
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  copyFileSync(path.join(sourceRoot, "objects", relative), target);
  chmodSync(target, 0o600);
}

function convertArtifactRowsToLegacy(databasePath: string): void {
  const database = new (requireSqlite(
    sqlite,
    "apps/orchestration/tests/state-reconciliation.test.ts:182"
  ).DatabaseSync)(databasePath);
  try {
    database.exec("DROP TRIGGER artifacts_no_update; DROP TRIGGER artifacts_no_delete;");
    const rows = requireRecordArray(
      database.prepare("SELECT artifact_id,ref_json,metadata_json FROM artifacts").all(),
      "legacy artifact rows"
    );
    const legacyRef = (value: Record<string, unknown>): Record<string, unknown> => ({
      ...value,
      schema_version: 1,
      consumer_scope: ["state:analysis"],
    });
    const update = database.prepare(
      "UPDATE artifacts SET ref_json=?,metadata_json=? WHERE artifact_id=?"
    );
    for (const [index, row] of rows.entries()) {
      const artifactId = requireString(row["artifact_id"], `legacy rows[${index}].artifact_id`);
      const ref = legacyRef(
        requireRecord(
          parseJson(requireString(row["ref_json"], `legacy rows[${index}].ref_json`)),
          `legacy rows[${index}] ref`
        )
      );
      const metadata = requireRecord(
        parseJson(requireString(row["metadata_json"], `legacy rows[${index}].metadata_json`)),
        `legacy rows[${index}] metadata`
      );
      const parent =
        metadata["parent_ref"] === null
          ? null
          : legacyRef(requireRecord(metadata["parent_ref"], `legacy rows[${index}] parent ref`));
      update.run(
        JSON.stringify(ref),
        JSON.stringify({
          ...metadata,
          schema_version: 1,
          consumer_scope: ["state:analysis"],
          parent_ref: parent,
        }),
        artifactId
      );
    }
    database.exec(`
      CREATE TRIGGER artifacts_no_update BEFORE UPDATE ON artifacts BEGIN
        SELECT RAISE(ABORT, 'artifact rows are immutable');
      END;
      CREATE TRIGGER artifacts_no_delete BEFORE DELETE ON artifacts BEGIN
        SELECT RAISE(ABORT, 'artifact rows are immutable');
      END;
    `);
  } finally {
    database.close();
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("explicit duplicate-source reconciliation", () => {
  it("strictly unions disjoint orchestration databases and checksum-binds the result", async () => {
    const root = sandbox();
    const paths = reconciliationPaths(root);
    const primary = path.join(root, "primary.db");
    const nested = path.join(root, "nested.db");
    orchestrationSource(primary, [{ runId: "run-primary", status: "running" }]);
    orchestrationSource(nested, [{ runId: "run-nested", status: "complete" }]);
    const receiptKey = path.join(root, "receipt-key");
    writeFileSync(receiptKey, Buffer.alloc(32, 0x44), { mode: 0o600 });
    writeManifest(paths.sourceManifest, {
      schema_version: 1,
      migration_id: "orchestration-reconciliation-001",
      stores: [
        {
          id: "orchestration-db",
          kind: "sqlite",
          sources: [
            { source_id: "main", path: primary },
            { source_id: "nested", path: nested },
          ],
          reconciliation: {
            strategy: "strict-union",
            precedence: ["main", "nested"],
          },
        },
        { id: "orchestration-receipt-key", kind: "file", path: receiptKey },
      ],
    });
    const rootOptions = { env: { PENNY_STATE_ROOT: paths.stateRoot } } as const;
    const plan = createStateMigrationPlan({
      projectRoot: paths.projectRoot,
      sourceManifestPath: paths.sourceManifest,
      outputPath: paths.planPath,
      rootOptions,
    });
    const store = requireValue(
      plan.stores.find((value) => value.id === "orchestration-db"),
      "orchestration migration store"
    );
    expect(store.source_candidates).toHaveLength(2);
    const reconciliation = requireValue(store.reconciliation, "orchestration reconciliation");
    expect(reconciliation.strategy).toBe("strict-union");
    if (reconciliation.strategy !== "strict-union") {
      throw new Error("expected strict-union reconciliation");
    }
    expect(reconciliation).toMatchObject({
      strategy: "strict-union",
      precedence: ["main", "nested"],
      source_count: 2,
      precedence_resolution_count: 0,
    });
    expect(reconciliation.target_logical_sha256).toMatch(/^[a-f0-9]{64}$/u);
    const runsTable = requireValue(
      reconciliation.target_tables.find((table) => table.name === "runs"),
      "reconciled runs table"
    );
    expect(runsTable).toMatchObject({ name: "runs", row_count: 2 });
    expect(runsTable.rows_sha256).toMatch(/^[a-f0-9]{64}$/u);
    const planBytes = readFileSync(paths.planPath, "utf8");
    expect(planBytes).not.toContain(primary);
    expect(planBytes).not.toContain(nested);

    await applyStateMigration({
      projectRoot: paths.projectRoot,
      sourceManifestPath: paths.sourceManifest,
      planPath: paths.planPath,
      rootOptions,
    });
    await expect(
      applyStateMigration({
        projectRoot: paths.projectRoot,
        sourceManifestPath: paths.sourceManifest,
        planPath: paths.planPath,
        rootOptions,
      })
    ).resolves.toMatchObject({ phase: "applied", finalized: false });
    const verification = await verifyStateMigration({
      projectRoot: paths.projectRoot,
      planPath: paths.planPath,
      rootOptions,
    });
    expect(
      verification.stores.find((value) => value.id === "orchestration-db")?.reconciliation
    ).toEqual(store?.reconciliation);
    const targetPath = path.join(
      paths.stateRoot,
      "migrations",
      plan.migration_id,
      "staging",
      "project",
      "orchestration",
      "orchestration.db"
    );
    const target = new (requireSqlite(
      sqlite,
      "apps/orchestration/tests/state-reconciliation.test.ts:316"
    ).DatabaseSync)(targetPath, { readOnly: true });
    const runIds = requireRecordArray(
      target.prepare("SELECT run_id FROM runs ORDER BY run_id").all(),
      "reconciled run rows"
    );
    target.close();
    expect(
      runIds.map((row, index) => requireString(row["run_id"], `run rows[${index}].run_id`))
    ).toEqual(["run-nested", "run-primary"]);
  });

  it("refuses divergent orchestration identities instead of choosing by precedence", () => {
    const root = sandbox();
    const paths = reconciliationPaths(root);
    const primary = path.join(root, "primary.db");
    const nested = path.join(root, "nested.db");
    orchestrationSource(primary, [{ runId: "run-collision", status: "running" }]);
    orchestrationSource(nested, [{ runId: "run-collision", status: "complete" }]);
    writeManifest(paths.sourceManifest, {
      schema_version: 1,
      migration_id: "orchestration-collision-001",
      stores: [
        {
          id: "orchestration-db",
          kind: "sqlite",
          sources: [
            { source_id: "main", path: primary },
            { source_id: "nested", path: nested },
          ],
          reconciliation: {
            strategy: "strict-union",
            precedence: ["main", "nested"],
          },
        },
      ],
    });
    expect(() =>
      createStateMigrationPlan({
        projectRoot: paths.projectRoot,
        sourceManifestPath: paths.sourceManifest,
        outputPath: paths.planPath,
        rootOptions: { env: { PENNY_STATE_ROOT: paths.stateRoot } },
      })
    ).toThrow("reconciliation collision in 'runs'");
  });

  it("refuses a reconciled source already bound to another project", () => {
    const root = sandbox();
    const paths = reconciliationPaths(root);
    const primary = path.join(root, "primary.db");
    const nested = path.join(root, "nested.db");
    orchestrationSource(primary, [{ runId: "run-primary", status: "running" }]);
    orchestrationSource(nested, [{ runId: "run-nested", status: "running" }]);
    {
      using _bound = new Checkpointer(primary, undefined, {
        projectId: `prj_${"a".repeat(32)}`,
      });
    }
    writeManifest(paths.sourceManifest, {
      schema_version: 1,
      migration_id: "orchestration-wrong-binding-001",
      stores: [
        {
          id: "orchestration-db",
          kind: "sqlite",
          sources: [
            { source_id: "main", path: primary },
            { source_id: "nested", path: nested },
          ],
          reconciliation: {
            strategy: "strict-union",
            precedence: ["main", "nested"],
          },
        },
      ],
    });
    expect(() =>
      createStateMigrationPlan({
        projectRoot: paths.projectRoot,
        sourceManifestPath: paths.sourceManifest,
        outputPath: paths.planPath,
        rootOptions: { env: { PENNY_STATE_ROOT: paths.stateRoot } },
      })
    ).toThrow("reconciliation source belongs to another Penny project");
  });

  it("refuses when any reconciled candidate changes after planning", async () => {
    const root = sandbox();
    const paths = reconciliationPaths(root);
    const primary = path.join(root, "primary.db");
    const nested = path.join(root, "nested.db");
    orchestrationSource(primary, [{ runId: "run-primary", status: "running" }]);
    orchestrationSource(nested, [{ runId: "run-nested", status: "running" }]);
    writeManifest(paths.sourceManifest, {
      schema_version: 1,
      migration_id: "orchestration-changed-source-001",
      stores: [
        {
          id: "orchestration-db",
          kind: "sqlite",
          sources: [
            { source_id: "main", path: primary },
            { source_id: "nested", path: nested },
          ],
          reconciliation: {
            strategy: "strict-union",
            precedence: ["main", "nested"],
          },
        },
      ],
    });
    const rootOptions = { env: { PENNY_STATE_ROOT: paths.stateRoot } } as const;
    createStateMigrationPlan({
      projectRoot: paths.projectRoot,
      sourceManifestPath: paths.sourceManifest,
      outputPath: paths.planPath,
      rootOptions,
    });
    const changed = new (requireSqlite(
      sqlite,
      "apps/orchestration/tests/state-reconciliation.test.ts:431"
    ).DatabaseSync)(nested);
    changed.prepare("UPDATE runs SET status='complete' WHERE run_id='run-nested'").run();
    changed.close();

    await expect(
      applyStateMigration({
        projectRoot: paths.projectRoot,
        sourceManifestPath: paths.sourceManifest,
        planPath: paths.planPath,
        rootOptions,
      })
    ).rejects.toThrow("source changed after planning");
  });

  it("refuses signed receipt histories that cannot share the selected target authority", () => {
    const root = sandbox();
    const paths = reconciliationPaths(root);
    const primary = path.join(root, "primary.db");
    const nested = path.join(root, "nested.db");
    orchestrationSource(primary, [{ runId: "run-signed", status: "complete" }]);
    orchestrationSource(nested, [{ runId: "run-unsigned", status: "running" }]);
    const primaryKey = path.join(root, "primary-key");
    const nestedKey = path.join(root, "nested-key");
    writeFileSync(primaryKey, Buffer.alloc(32, 0x11), { mode: 0o600 });
    writeFileSync(nestedKey, Buffer.alloc(32, 0x22), { mode: 0o600 });
    addSignedReceipt(primary, primaryKey, "run-signed");
    writeManifest(paths.sourceManifest, {
      schema_version: 1,
      migration_id: "orchestration-authority-conflict-001",
      stores: [
        {
          id: "orchestration-db",
          kind: "sqlite",
          sources: [
            {
              source_id: "main",
              path: primary,
              receipt_key_path: primaryKey,
            },
            {
              source_id: "nested",
              path: nested,
              receipt_key_path: nestedKey,
            },
          ],
          reconciliation: {
            strategy: "strict-union",
            precedence: ["main", "nested"],
          },
        },
        { id: "orchestration-receipt-key", kind: "file", path: nestedKey },
      ],
    });
    expect(() =>
      createStateMigrationPlan({
        projectRoot: paths.projectRoot,
        sourceManifestPath: paths.sourceManifest,
        outputPath: paths.planPath,
      })
    ).toThrow("receipt authority cannot be represented by the target key");
  });

  it("normalizes current and legacy artifact rows and explicitly resolves selection precedence", async () => {
    const root = sandbox();
    const paths = reconciliationPaths(root);
    const currentRoot = path.join(root, "current-artifacts");
    const legacyRoot = path.join(root, "legacy-artifacts");
    mkdirSync(currentRoot, { mode: 0o700 });
    mkdirSync(legacyRoot, { mode: 0o700 });
    let currentRef: ReturnType<ArtifactStore["persist"]>;
    let legacySecondRef: ReturnType<ArtifactStore["persist"]>;
    {
      using artifacts = new ArtifactStore(currentRoot);
      currentRef = artifacts.persist({
        metadata: artifactMetadata({
          operationId: "operation-reconcile",
          version: 1,
          parentRef: null,
        }),
        content: "revision one",
      });
      artifacts.select(currentRef);
    }
    {
      using artifacts = new ArtifactStore(legacyRoot);
      const legacyFirstRef = artifacts.persist({
        metadata: artifactMetadata({
          operationId: "operation-reconcile",
          version: 1,
          parentRef: null,
        }),
        content: "revision one",
      });
      legacySecondRef = artifacts.persist({
        metadata: artifactMetadata({
          operationId: "operation-reconcile",
          version: 2,
          parentRef: legacyFirstRef,
        }),
        content: "revision two",
      });
      artifacts.select(legacySecondRef);
    }
    convertArtifactRowsToLegacy(path.join(legacyRoot, "manifest.db"));
    copyArtifactObject(legacyRoot, currentRoot, legacySecondRef.content_digest);
    const sourceValue = {
      schema_version: 1,
      migration_id: "artifact-reconciliation-001",
      stores: [
        {
          id: "artifact-manifest",
          kind: "sqlite",
          sources: [
            { source_id: "current", path: path.join(currentRoot, "manifest.db") },
            { source_id: "legacy", path: path.join(legacyRoot, "manifest.db") },
          ],
          reconciliation: {
            strategy: "artifact-union",
            precedence: ["current", "legacy"],
            selection_policy: "prefer-precedence",
          },
        },
        {
          id: "artifact-objects",
          kind: "tree",
          path: path.join(currentRoot, "objects"),
        },
      ],
    };
    writeManifest(paths.sourceManifest, {
      ...sourceValue,
      stores: [
        {
          ...sourceValue.stores[0],
          reconciliation: {
            ...requireValue(
              sourceValue.stores[0],
              "apps/orchestration/tests/state-reconciliation.test.ts:566"
            ).reconciliation,
            selection_policy: "require-identical",
          },
        },
        sourceValue.stores[1],
      ],
    });
    expect(() =>
      createStateMigrationPlan({
        projectRoot: paths.projectRoot,
        sourceManifestPath: paths.sourceManifest,
        outputPath: paths.planPath,
        rootOptions: { env: { PENNY_STATE_ROOT: paths.stateRoot } },
      })
    ).toThrow("reconciliation collision in 'artifact_selections'");

    writeManifest(paths.sourceManifest, sourceValue);
    const rootOptions = { env: { PENNY_STATE_ROOT: paths.stateRoot } } as const;
    const plan = createStateMigrationPlan({
      projectRoot: paths.projectRoot,
      sourceManifestPath: paths.sourceManifest,
      outputPath: paths.planPath,
      rootOptions,
    });
    const manifest = requireValue(
      plan.stores.find((store) => store.id === "artifact-manifest"),
      "artifact manifest migration store"
    );
    const reconciliation = requireValue(manifest.reconciliation, "artifact reconciliation");
    expect(reconciliation.strategy).toBe("artifact-union");
    if (reconciliation.strategy !== "artifact-union") {
      throw new Error("expected artifact-union reconciliation");
    }
    expect(reconciliation).toMatchObject({
      strategy: "artifact-union",
      selection_policy: "prefer-precedence",
      precedence_resolution_count: 1,
    });
    expect(reconciliation.precedence_resolution_sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(reconciliation.duplicate_row_count).toBeGreaterThan(0);

    await applyStateMigration({
      projectRoot: paths.projectRoot,
      sourceManifestPath: paths.sourceManifest,
      planPath: paths.planPath,
      rootOptions,
    });
    await expect(
      verifyStateMigration({
        projectRoot: paths.projectRoot,
        planPath: paths.planPath,
        rootOptions,
      })
    ).resolves.toMatchObject({ phase: "verified" });

    const targetRoot = path.join(
      paths.stateRoot,
      "migrations",
      plan.migration_id,
      "staging",
      "project",
      "artifacts"
    );
    using artifacts = new ArtifactStore(targetRoot, { projectId: plan.target_project_id });
    expect(artifacts.refById(currentRef.artifact_id)?.schema_version).toBe(2);
    expect(artifacts.refById(legacySecondRef.artifact_id)?.schema_version).toBe(2);
    expect(artifacts.readById(legacySecondRef.artifact_id).toString("utf8")).toBe("revision two");
    expect(artifacts.selected("run-artifact-reconciliation", "analysis", null)?.artifact_id).toBe(
      currentRef.artifact_id
    );
    const targetDatabase = new (requireSqlite(
      sqlite,
      "apps/orchestration/tests/state-reconciliation.test.ts:628"
    ).DatabaseSync)(path.join(targetRoot, "manifest.db"), {
      readOnly: true,
    });
    const raw = requireRecord(
      targetDatabase
        .prepare("SELECT ref_json,metadata_json FROM artifacts WHERE artifact_id=?")
        .get(legacySecondRef.artifact_id),
      "reconciled artifact row"
    );
    targetDatabase.close();
    expect(
      parseJson(requireString(raw["ref_json"], "reconciled artifact ref_json"))
    ).not.toHaveProperty("consumer_scope");
    expect(
      parseJson(requireString(raw["metadata_json"], "reconciled artifact metadata_json"))
    ).not.toHaveProperty("consumer_scope");
  });

  it("refuses artifact identity collisions and non-explicit selection policy", () => {
    const root = sandbox();
    const paths = reconciliationPaths(root);
    const firstRoot = path.join(root, "first-artifacts");
    const secondRoot = path.join(root, "second-artifacts");
    mkdirSync(firstRoot, { mode: 0o700 });
    mkdirSync(secondRoot, { mode: 0o700 });
    for (const [artifactRoot, content] of [
      [firstRoot, "first bytes"],
      [secondRoot, "different bytes"],
    ] as const) {
      using artifacts = new ArtifactStore(artifactRoot);
      artifacts.persist({
        metadata: artifactMetadata({
          operationId: "operation-collision",
          version: 1,
          parentRef: null,
        }),
        content,
      });
    }
    const base = {
      schema_version: 1,
      migration_id: "artifact-collision-001",
      stores: [
        {
          id: "artifact-manifest",
          kind: "sqlite",
          sources: [
            { source_id: "first", path: path.join(firstRoot, "manifest.db") },
            { source_id: "second", path: path.join(secondRoot, "manifest.db") },
          ],
          reconciliation: {
            strategy: "artifact-union",
            precedence: ["first", "second"],
          },
        },
      ],
    };
    writeManifest(paths.sourceManifest, base);
    expect(() =>
      createStateMigrationPlan({
        projectRoot: paths.projectRoot,
        sourceManifestPath: paths.sourceManifest,
        outputPath: paths.planPath,
      })
    ).toThrow("selection policy is invalid");

    writeManifest(paths.sourceManifest, {
      ...base,
      stores: [
        {
          ...base.stores[0],
          reconciliation: {
            ...requireValue(
              base.stores[0],
              "apps/orchestration/tests/state-reconciliation.test.ts:693"
            ).reconciliation,
            selection_policy: "require-identical",
          },
        },
      ],
    });
    expect(() =>
      createStateMigrationPlan({
        projectRoot: paths.projectRoot,
        sourceManifestPath: paths.sourceManifest,
        outputPath: paths.planPath,
      })
    ).toThrow("reconciliation collision in 'artifacts'");
  });
});
