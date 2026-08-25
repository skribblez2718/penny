import {
  parseJson,
  requireNumber,
  requireRecord,
  requireString,
  requireSqlite,
} from "./helpers/narrowing.js";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ArtifactStore } from "../src/artifact-store.js";
import { Checkpointer } from "../src/checkpointer.js";
import {
  STATE_MIGRATION_FINALIZED_MARKER,
  applyStateMigration,
  createStateMigrationPlan,
  finalizeStateMigration,
  resolvePennyProjectState,
  verifyStateMigration,
} from "../src/state/index.js";

const sqlite = process.getBuiltinModule("node:sqlite");
const roots: string[] = [];

function sandbox(): string {
  const root = mkdtempSync(path.join(tmpdir(), "penny-state-migration-test-"));
  roots.push(root);
  return root;
}

function fixture(root: string): {
  readonly projectRoot: string;
  readonly sourceManifest: string;
  readonly planPath: string;
  readonly stateRoot: string;
  readonly database: string;
  readonly key: string;
  readonly chains: string;
} {
  const projectRoot = path.join(root, "private-project");
  mkdirSync(projectRoot, { mode: 0o700 });
  const database = path.join(root, "orchestration-v2.db");
  const initialized = new Checkpointer(database);
  initialized.close();
  const sourceDatabase = new (requireSqlite(
    sqlite,
    "apps/orchestration/tests/state-migration.test.ts:52"
  ).DatabaseSync)(database);
  sourceDatabase.exec(`
    DROP TABLE store_metadata;
    PRAGMA user_version=9;
    INSERT INTO runs(
      run_id, session_id, playbook, engine_owner, schema_version, status,
      state_id, context_json, created_at, updated_at
    ) VALUES
      ('run-running', 'session-a', 'research', 'typescript', 2, 'running',
       'dispatch', '{}', '2026-08-22T00:00:00.000Z', '2026-08-22T00:00:00.000Z'),
      ('run-complete', 'session-b', 'research', 'typescript', 2, 'complete',
       'terminal', '{}', '2026-08-22T00:00:00.000Z', '2026-08-22T00:00:00.000Z');
  `);
  sourceDatabase.close();
  chmodSync(database, 0o600);

  const key = path.join(root, "orchestration-v2.db.receipt-key");
  writeFileSync(key, Buffer.alloc(32, 0x5a), { mode: 0o600 });
  const chains = path.join(root, "skill-chains");
  mkdirSync(chains, { mode: 0o700 });
  writeFileSync(
    path.join(chains, "chain.json"),
    `${JSON.stringify({
      schema_version: 1,
      chain_session_id: "chain",
      chain_run_id: "chain",
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
      migration_id: "fixture-migration-001",
      stores: [
        { id: "orchestration-db", kind: "sqlite", path: database },
        { id: "orchestration-receipt-key", kind: "file", path: key },
        { id: "skill-chains", kind: "tree", path: chains },
      ],
    })}\n`,
    { mode: 0o600 }
  );
  return {
    projectRoot,
    sourceManifest,
    planPath: path.join(root, "migration-plan.json"),
    stateRoot: path.join(root, "state"),
    database,
    key,
    chains,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("explicit state migration apply/verify/finalize", () => {
  it("publishes one verified project atomically and activates its catalog binding", async () => {
    const root = sandbox();
    const input = fixture(root);
    const rootOptions = { env: { PENNY_STATE_ROOT: input.stateRoot } } as const;
    const plan = createStateMigrationPlan({
      projectRoot: input.projectRoot,
      sourceManifestPath: input.sourceManifest,
      outputPath: input.planPath,
      rootOptions,
    });
    const finalProjectRoot = path.join(input.stateRoot, "projects", plan.target_project_id);

    const applied = await applyStateMigration({
      projectRoot: input.projectRoot,
      sourceManifestPath: input.sourceManifest,
      planPath: input.planPath,
      rootOptions,
    });
    expect(applied.phase).toBe("applied");
    expect(applied.completed_stores).toEqual([
      "orchestration-db",
      "orchestration-receipt-key",
      "skill-chains",
    ]);
    expect(existsSync(finalProjectRoot)).toBe(false);
    const journalBytes = readFileSync(
      path.join(input.stateRoot, "migrations", plan.migration_id, "journal.json"),
      "utf8"
    );
    expect(journalBytes).not.toContain(input.projectRoot);
    expect(journalBytes).not.toContain(input.database);
    expect(journalBytes).not.toContain(input.key);
    expect(() => resolvePennyProjectState(input.projectRoot, rootOptions)).toThrow(
      "relink_pending"
    );

    const verified = await verifyStateMigration({
      projectRoot: input.projectRoot,
      planPath: input.planPath,
      rootOptions,
    });
    expect(verified.phase).toBe("verified");
    expect(verified.stores).toHaveLength(3);

    const finalized = await finalizeStateMigration({
      projectRoot: input.projectRoot,
      planPath: input.planPath,
      rootOptions,
    });
    expect(finalized.phase).toBe("finalized");

    const resolved = resolvePennyProjectState(input.projectRoot, rootOptions);
    expect(resolved.projectId).toBe(plan.target_project_id);
    expect(readFileSync(resolved.paths.orchestration.receiptKey)).toEqual(readFileSync(input.key));
    const migratedChain = requireRecord(
      parseJson(readFileSync(path.join(resolved.paths.skillChains, "chain.json"), "utf8")),
      "migrated chain fixture"
    );
    expect(migratedChain).toMatchObject({
      project_id: plan.target_project_id,
      state_layout_version: 1,
      chain_status: "failed",
    });
    const markerPath = path.join(resolved.paths.root, STATE_MIGRATION_FINALIZED_MARKER);
    expect(existsSync(markerPath)).toBe(true);
    expect(readFileSync(markerPath, "utf8")).not.toContain(input.projectRoot);

    const targetDatabase = new (requireSqlite(
      sqlite,
      "apps/orchestration/tests/state-migration.test.ts:186"
    ).DatabaseSync)(resolved.paths.orchestration.database, {
      readOnly: true,
    });
    const version = requireRecord(
      targetDatabase.prepare("PRAGMA user_version").get(),
      "migrated schema version"
    );
    const binding = requireRecord(
      targetDatabase.prepare("SELECT project_id FROM store_metadata").get(),
      "migrated store binding"
    );
    const runCount = requireRecord(
      targetDatabase.prepare("SELECT COUNT(*) AS count FROM runs").get(),
      "migrated run count"
    );
    targetDatabase.close();
    expect(requireNumber(version["user_version"], "migrated user_version")).toBe(10);
    expect(requireString(binding["project_id"], "migrated project_id")).toBe(
      plan.target_project_id
    );
    expect(requireNumber(runCount["count"], "migrated run count")).toBe(2);

    await expect(
      applyStateMigration({
        projectRoot: input.projectRoot,
        sourceManifestPath: input.sourceManifest,
        planPath: input.planPath,
        rootOptions,
      })
    ).resolves.toMatchObject({ phase: "finalized", finalized: true });
    await expect(
      finalizeStateMigration({
        projectRoot: input.projectRoot,
        planPath: input.planPath,
        rootOptions,
      })
    ).resolves.toMatchObject({ phase: "finalized", finalized: true });
  });

  it("adopts an exact post-rename crash only after activating the reserved catalog row", async () => {
    const root = sandbox();
    const input = fixture(root);
    const rootOptions = { env: { PENNY_STATE_ROOT: input.stateRoot } } as const;
    const plan = createStateMigrationPlan({
      projectRoot: input.projectRoot,
      sourceManifestPath: input.sourceManifest,
      outputPath: input.planPath,
      rootOptions,
    });
    await applyStateMigration({
      projectRoot: input.projectRoot,
      sourceManifestPath: input.sourceManifest,
      planPath: input.planPath,
      rootOptions,
    });
    await verifyStateMigration({
      projectRoot: input.projectRoot,
      planPath: input.planPath,
      rootOptions,
    });
    const staged = path.join(
      input.stateRoot,
      "migrations",
      plan.migration_id,
      "staging",
      "project"
    );
    const marker = path.join(staged, STATE_MIGRATION_FINALIZED_MARKER);
    writeFileSync(
      marker,
      `${JSON.stringify({
        schema_version: 1,
        migration_id: plan.migration_id,
        plan_sha256: plan.plan_sha256,
        project_id: plan.target_project_id,
        state_layout_version: 1,
        finalized_at: "2026-08-23T00:00:00.000Z",
      })}\n`,
      { mode: 0o600 }
    );
    const published = path.join(input.stateRoot, "projects", plan.target_project_id);
    renameSync(staged, published);
    expect(() => resolvePennyProjectState(input.projectRoot, rootOptions)).toThrow(
      "relink_pending"
    );

    await expect(
      finalizeStateMigration({
        projectRoot: input.projectRoot,
        planPath: input.planPath,
        rootOptions,
      })
    ).resolves.toMatchObject({ phase: "finalized", finalized: true });
    expect(resolvePennyProjectState(input.projectRoot, rootOptions).projectId).toBe(
      plan.target_project_id
    );
  });

  it("resumes an interrupted noncompleted staged copy without exposing it", async () => {
    const root = sandbox();
    const input = fixture(root);
    const rootOptions = { env: { PENNY_STATE_ROOT: input.stateRoot } } as const;
    const plan = createStateMigrationPlan({
      projectRoot: input.projectRoot,
      sourceManifestPath: input.sourceManifest,
      outputPath: input.planPath,
      rootOptions,
    });
    await applyStateMigration({
      projectRoot: input.projectRoot,
      sourceManifestPath: input.sourceManifest,
      planPath: input.planPath,
      rootOptions,
    });
    const work = path.join(input.stateRoot, "migrations", plan.migration_id);
    const journalPath = path.join(work, "journal.json");
    const journal = requireRecord(
      parseJson(readFileSync(journalPath, "utf8")),
      "apps/orchestration/tests/state-migration.test.ts:296"
    );
    writeFileSync(
      journalPath,
      `${JSON.stringify({
        ...journal,
        phase: "applying",
        completed_stores: [],
        updated_at: "2026-08-23T00:00:00.000Z",
      })}\n`,
      { mode: 0o600 }
    );
    const stagedKey = path.join(work, "staging", "project", "orchestration", "receipt-key");
    writeFileSync(stagedKey, "partial", { mode: 0o600 });

    const resumed = await applyStateMigration({
      projectRoot: input.projectRoot,
      sourceManifestPath: input.sourceManifest,
      planPath: input.planPath,
      rootOptions,
    });
    expect(resumed.phase).toBe("applied");
    expect(readFileSync(stagedKey)).toEqual(readFileSync(input.key));
    expect(existsSync(path.join(input.stateRoot, "projects", plan.target_project_id))).toBe(false);
  });

  it("backs up committed WAL content without adopting source sidecars", async () => {
    const root = sandbox();
    const projectRoot = path.join(root, "wal-project");
    mkdirSync(projectRoot, { mode: 0o700 });
    const sourcePath = path.join(root, "wal-source.db");
    const initialized = new Checkpointer(sourcePath);
    initialized.close();
    const sourceDatabase = new (requireSqlite(
      sqlite,
      "apps/orchestration/tests/state-migration.test.ts:329"
    ).DatabaseSync)(sourcePath);
    try {
      sourceDatabase.exec(`
        PRAGMA journal_mode=WAL;
        PRAGMA wal_autocheckpoint=0;
        DROP TABLE store_metadata;
        PRAGMA user_version=9;
        INSERT INTO runs(
          run_id, session_id, playbook, engine_owner, schema_version, status,
          state_id, context_json, created_at, updated_at
        ) VALUES(
          'wal-only-run', 'session-wal', 'research', 'typescript', 2, 'running',
          'dispatch', '{}', '2026-08-22T00:00:00.000Z', '2026-08-22T00:00:00.000Z'
        );
      `);
      for (const candidate of [sourcePath, `${sourcePath}-wal`, `${sourcePath}-shm`]) {
        if (existsSync(candidate)) chmodSync(candidate, 0o600);
      }
      expect(existsSync(`${sourcePath}-wal`)).toBe(true);

      const sourceManifest = path.join(root, "wal-sources.json");
      writeFileSync(
        sourceManifest,
        `${JSON.stringify({
          schema_version: 1,
          migration_id: "wal-migration-001",
          stores: [{ id: "orchestration-db", kind: "sqlite", path: sourcePath }],
        })}\n`,
        { mode: 0o600 }
      );
      const planPath = path.join(root, "wal-plan.json");
      const stateRoot = path.join(root, "wal-state");
      const rootOptions = { env: { PENNY_STATE_ROOT: stateRoot } } as const;
      const plan = createStateMigrationPlan({
        projectRoot,
        sourceManifestPath: sourceManifest,
        outputPath: planPath,
        rootOptions,
      });
      expect(plan.stores[0]?.source_snapshot.kind).toBe("sqlite");
      if (plan.stores[0]?.source_snapshot.kind !== "sqlite") {
        throw new Error("expected SQLite plan store");
      }
      expect(plan.stores[0].source_snapshot.wal?.size).toBeGreaterThan(0);

      await applyStateMigration({
        projectRoot,
        sourceManifestPath: sourceManifest,
        planPath,
        rootOptions,
      });
      const stagedDatabase = path.join(
        stateRoot,
        "migrations",
        plan.migration_id,
        "staging",
        "project",
        "orchestration",
        "orchestration.db"
      );
      const target = new (requireSqlite(
        sqlite,
        "apps/orchestration/tests/state-migration.test.ts:389"
      ).DatabaseSync)(stagedDatabase, { readOnly: true });
      const row = requireRecord(
        target.prepare("SELECT run_id FROM runs WHERE run_id = 'wal-only-run'").get(),
        "WAL-only migrated run"
      );
      target.close();
      expect(requireString(row["run_id"], "WAL-only run_id")).toBe("wal-only-run");
    } finally {
      sourceDatabase.close();
    }
  });

  it("blocks verify when a historical execution receipt cannot verify under the exact key", async () => {
    const root = sandbox();
    const input = fixture(root);
    const source = new (requireSqlite(
      sqlite,
      "apps/orchestration/tests/state-migration.test.ts:403"
    ).DatabaseSync)(input.database);
    source
      .prepare(
        "INSERT INTO receipts(" +
          "receipt_id, run_id, state_id, branch_id, agent, attempt, worker_id, " +
          "output_digest, result_json, created_at" +
          ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(
        `receipt_${"a".repeat(64)}`,
        "run-running",
        "dispatch",
        "main",
        "annie",
        1,
        "worker-a",
        "0".repeat(64),
        "{}",
        "2026-08-23T00:00:00.000Z"
      );
    source.close();
    const rootOptions = { env: { PENNY_STATE_ROOT: input.stateRoot } } as const;
    createStateMigrationPlan({
      projectRoot: input.projectRoot,
      sourceManifestPath: input.sourceManifest,
      outputPath: input.planPath,
      rootOptions,
    });
    await applyStateMigration({
      projectRoot: input.projectRoot,
      sourceManifestPath: input.sourceManifest,
      planPath: input.planPath,
      rootOptions,
    });

    await expect(
      verifyStateMigration({
        projectRoot: input.projectRoot,
        planPath: input.planPath,
        rootOptions,
      })
    ).rejects.toThrow("execution receipt");
  });

  it("transforms retained chains and verifies every referenced artifact", async () => {
    const root = sandbox();
    const projectRoot = path.join(root, "chain-project");
    mkdirSync(projectRoot, { mode: 0o700 });
    const artifactRoot = path.join(root, "chain-artifacts");
    mkdirSync(artifactRoot, { mode: 0o700 });
    let artifactRef: ReturnType<ArtifactStore["persist"]>;
    {
      using artifacts = new ArtifactStore(artifactRoot);
      artifactRef = artifacts.persist({
        metadata: {
          schema_version: 2,
          run_id: "run-chain-artifact",
          phase: "analysis",
          branch_id: null,
          kind: "agent-output",
          operation_id: "operation-chain-artifact",
          version: 1,
          producer: "agent:annie",
          media_type: "text/plain",
          parent_ref: null,
          upstream_refs: [],
        },
        content: "chain artifact bytes",
      });
    }
    const chains = path.join(root, "source-chains");
    mkdirSync(chains, { mode: 0o700 });
    writeFileSync(
      path.join(chains, "chain-ref.json"),
      `${JSON.stringify({
        schema_version: 1,
        chain_session_id: "chain-ref",
        chain_run_id: "chain-ref",
        chain_goal_summary: "retain exact ref",
        steps: [
          {
            index: 0,
            skill_name: "research",
            goal: "fixture",
            input_artifacts: [artifactRef.artifact_id],
            session_id: "run-chain-artifact",
            status: "complete",
            output_artifact_ref: artifactRef,
          },
        ],
        current_step: 1,
        total_steps: 1,
        chain_status: "complete",
        pending_steps: [],
        created_at: "2026-08-22T00:00:00.000Z",
        updated_at: "2026-08-22T00:00:00.000Z",
      })}\n`,
      { mode: 0o600 }
    );
    const sourceManifest = path.join(root, "chain-sources.json");
    writeFileSync(
      sourceManifest,
      `${JSON.stringify({
        schema_version: 1,
        migration_id: "chain-migration-001",
        stores: [
          {
            id: "artifact-manifest",
            kind: "sqlite",
            path: path.join(artifactRoot, "manifest.db"),
          },
          {
            id: "artifact-objects",
            kind: "tree",
            path: path.join(artifactRoot, "objects"),
          },
          { id: "skill-chains", kind: "tree", path: chains },
        ],
      })}\n`,
      { mode: 0o600 }
    );
    const planPath = path.join(root, "chain-plan.json");
    const stateRoot = path.join(root, "chain-state");
    const rootOptions = { env: { PENNY_STATE_ROOT: stateRoot } } as const;
    const plan = createStateMigrationPlan({
      projectRoot,
      sourceManifestPath: sourceManifest,
      outputPath: planPath,
      rootOptions,
    });
    await applyStateMigration({
      projectRoot,
      sourceManifestPath: sourceManifest,
      planPath,
      rootOptions,
    });
    await expect(
      verifyStateMigration({ projectRoot, planPath, rootOptions })
    ).resolves.toMatchObject({ phase: "verified" });
    const targetChain = requireRecord(
      parseJson(
        readFileSync(
          path.join(
            stateRoot,
            "migrations",
            plan.migration_id,
            "staging",
            "project",
            "skill-chains",
            "chain-ref.json"
          ),
          "utf8"
        )
      ),
      "migrated referenced chain"
    );
    expect(targetChain).toMatchObject({
      project_id: plan.target_project_id,
      state_layout_version: 1,
    });
  });

  it("blocks verify when a manifest row has no exact artifact object", async () => {
    const root = sandbox();
    const projectRoot = path.join(root, "artifact-project");
    mkdirSync(projectRoot, { mode: 0o700 });
    const artifactRoot = path.join(root, "source-artifacts");
    mkdirSync(artifactRoot, { mode: 0o700 });
    let digest = "";
    {
      using artifacts = new ArtifactStore(artifactRoot);
      const ref = artifacts.persist({
        metadata: {
          schema_version: 2,
          run_id: "run-artifact",
          phase: "analysis",
          branch_id: null,
          kind: "agent-output",
          operation_id: "operation-artifact",
          version: 1,
          producer: "agent:annie",
          media_type: "text/plain",
          parent_ref: null,
          upstream_refs: [],
        },
        content: "exact artifact bytes",
      });
      digest = ref.content_digest;
    }
    const objectPath = path.join(
      artifactRoot,
      "objects",
      "sha256",
      digest.slice(0, 2),
      digest.slice(2)
    );
    unlinkSync(objectPath);
    const sourceManifest = path.join(root, "artifact-sources.json");
    writeFileSync(
      sourceManifest,
      `${JSON.stringify({
        schema_version: 1,
        migration_id: "artifact-migration-001",
        stores: [
          {
            id: "artifact-manifest",
            kind: "sqlite",
            path: path.join(artifactRoot, "manifest.db"),
          },
          {
            id: "artifact-objects",
            kind: "tree",
            path: path.join(artifactRoot, "objects"),
          },
        ],
      })}\n`,
      { mode: 0o600 }
    );
    const planPath = path.join(root, "artifact-plan.json");
    const stateRoot = path.join(root, "artifact-state");
    const rootOptions = { env: { PENNY_STATE_ROOT: stateRoot } } as const;
    createStateMigrationPlan({
      projectRoot,
      sourceManifestPath: sourceManifest,
      outputPath: planPath,
      rootOptions,
    });
    await applyStateMigration({
      projectRoot,
      sourceManifestPath: sourceManifest,
      planPath,
      rootOptions,
    });

    await expect(verifyStateMigration({ projectRoot, planPath, rootOptions })).rejects.toThrow(
      "object is missing"
    );
  });

  it("refuses when any source changes after planning", async () => {
    const root = sandbox();
    const input = fixture(root);
    const rootOptions = { env: { PENNY_STATE_ROOT: input.stateRoot } } as const;
    createStateMigrationPlan({
      projectRoot: input.projectRoot,
      sourceManifestPath: input.sourceManifest,
      outputPath: input.planPath,
      rootOptions,
    });
    writeFileSync(input.key, Buffer.alloc(33, 0x5a), { mode: 0o600 });

    await expect(
      applyStateMigration({
        projectRoot: input.projectRoot,
        sourceManifestPath: input.sourceManifest,
        planPath: input.planPath,
        rootOptions,
      })
    ).rejects.toThrow("source changed after planning");
    expect(existsSync(input.stateRoot)).toBe(false);
  });

  it("refuses an embedded SQLite tree member that the private source manifest omits", () => {
    const root = sandbox();
    const input = fixture(root);
    const embedded = path.join(input.chains, "unexpected.sqlite");
    const database = new (requireSqlite(
      sqlite,
      "apps/orchestration/tests/state-migration.test.ts:666"
    ).DatabaseSync)(embedded);
    database.exec("CREATE TABLE hidden(value TEXT) STRICT;");
    database.close();
    chmodSync(embedded, 0o600);
    const rootOptions = { env: { PENNY_STATE_ROOT: input.stateRoot } } as const;

    expect(() =>
      createStateMigrationPlan({
        projectRoot: input.projectRoot,
        sourceManifestPath: input.sourceManifest,
        outputPath: input.planPath,
        rootOptions,
      })
    ).toThrow("SQLite state not listed in the source manifest");
    expect(existsSync(input.stateRoot)).toBe(false);
  });

  it("backs up explicitly enumerated SQLite members inside dynamic KB-style trees", async () => {
    const root = sandbox();
    const input = fixture(root);
    const embedded = path.join(input.chains, "nested", "claims.sqlite");
    mkdirSync(path.dirname(embedded), { mode: 0o700 });
    const database = new (requireSqlite(
      sqlite,
      "apps/orchestration/tests/state-migration.test.ts:688"
    ).DatabaseSync)(embedded);
    database.exec(`
      PRAGMA user_version=4;
      CREATE TABLE claims(id TEXT PRIMARY KEY, state TEXT NOT NULL) STRICT;
      INSERT INTO claims VALUES('claim-a', 'available');
    `);
    database.close();
    chmodSync(embedded, 0o600);
    writeFileSync(
      input.sourceManifest,
      `${JSON.stringify({
        schema_version: 1,
        migration_id: "fixture-migration-001",
        stores: [
          {
            id: "skill-chains",
            kind: "tree",
            path: input.chains,
            sqlite_files: ["nested/claims.sqlite"],
          },
        ],
      })}\n`,
      { mode: 0o600 }
    );
    const rootOptions = { env: { PENNY_STATE_ROOT: input.stateRoot } } as const;
    const plan = createStateMigrationPlan({
      projectRoot: input.projectRoot,
      sourceManifestPath: input.sourceManifest,
      outputPath: input.planPath,
      rootOptions,
    });
    expect(plan.stores[0]?.source_snapshot.kind).toBe("tree");
    if (plan.stores[0]?.source_snapshot.kind !== "tree") {
      throw new Error("expected tree migration plan");
    }
    expect(plan.stores[0].source_snapshot.files.some((file) => file.kind === "sqlite")).toBe(true);
    expect(readFileSync(input.planPath, "utf8")).not.toContain("nested/claims.sqlite");

    await applyStateMigration({
      projectRoot: input.projectRoot,
      sourceManifestPath: input.sourceManifest,
      planPath: input.planPath,
      rootOptions,
    });
    const target = path.join(
      input.stateRoot,
      "migrations",
      plan.migration_id,
      "staging",
      "project",
      "skill-chains",
      "nested",
      "claims.sqlite"
    );
    const migrated = new (requireSqlite(
      sqlite,
      "apps/orchestration/tests/state-migration.test.ts:742"
    ).DatabaseSync)(target, { readOnly: true });
    const row = requireRecord(
      migrated.prepare("SELECT state FROM claims WHERE id = 'claim-a'").get(),
      "nested migrated claim"
    );
    const version = requireRecord(
      migrated.prepare("PRAGMA user_version").get(),
      "nested migrated schema version"
    );
    migrated.close();
    expect(requireString(row["state"], "nested claim state")).toBe("available");
    expect(requireNumber(version["user_version"], "nested user_version")).toBe(4);
  });
});
