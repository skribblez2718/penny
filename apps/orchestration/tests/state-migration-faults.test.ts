import { requireSqlite } from "./helpers/narrowing.js";
import {
  chmodSync,
  copyFileSync,
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
  STATE_MIGRATION_FINALIZED_MARKER,
  applyStateMigration,
  createStateMigrationPlan,
  finalizeStateMigration,
  resolvePennyProjectState,
  verifyStateMigration,
  type StateMigrationFaultEvent,
  type StateMigrationFaultInjector,
  type StateMigrationFaultPoint,
} from "../src/state/index.js";

const sqlite = process.getBuiltinModule("node:sqlite");
const roots: string[] = [];

interface FaultCase {
  readonly point: StateMigrationFaultPoint;
  readonly operation: string;
}

interface FaultFixture {
  readonly projectRoot: string;
  readonly sourceManifest: string;
  readonly planPath: string;
  readonly stateRoot: string;
  readonly database: string;
  readonly key: string;
  readonly sessionFile: string;
  readonly rootOptions: { readonly env: { readonly PENNY_STATE_ROOT: string } };
  readonly plan: ReturnType<typeof createStateMigrationPlan>;
  readonly sourceFiles: readonly string[];
  readonly sourceBytes: readonly Buffer[];
}

function sandbox(label: string): string {
  const root = mkdtempSync(path.join(tmpdir(), `penny-migration-fault-${label}-`));
  roots.push(root);
  return root;
}

function fixture(label: string, options: { readonly reconciled?: boolean } = {}): FaultFixture {
  const root = sandbox(label);
  const projectRoot = path.join(root, "project");
  mkdirSync(projectRoot, { mode: 0o700 });
  const database = path.join(root, "orchestration-source.db");
  {
    using _checkpointer = new Checkpointer(database);
  }
  const sourceDatabase = new (requireSqlite(
    sqlite,
    "apps/orchestration/tests/state-migration-faults.test.ts:66"
  ).DatabaseSync)(database);
  sourceDatabase.exec(`
    DROP TABLE store_metadata;
    PRAGMA user_version=9;
    INSERT INTO runs(
      run_id,session_id,playbook,engine_owner,schema_version,status,
      state_id,context_json,created_at,updated_at
    ) VALUES(
      'run-fault', 'session-fault', 'research', 'typescript', 2, 'running',
      'dispatch', '{}', '2026-08-23T00:00:00.000Z', '2026-08-23T00:00:00.000Z'
    );
  `);
  sourceDatabase.close();
  chmodSync(database, 0o600);

  const key = path.join(root, "receipt-key");
  writeFileSync(key, Buffer.alloc(32, 0x61), { mode: 0o600 });
  const sessions = path.join(root, "subagent-sessions");
  mkdirSync(sessions, { mode: 0o700 });
  const sessionFile = path.join(sessions, "session.jsonl");
  writeFileSync(sessionFile, '{"type":"fixture"}\n', { mode: 0o600 });

  const nestedDatabase = path.join(root, "orchestration-nested.db");
  if (options.reconciled === true) {
    copyFileSync(database, nestedDatabase);
    chmodSync(nestedDatabase, 0o600);
    const nested = new (requireSqlite(
      sqlite,
      "apps/orchestration/tests/state-migration-faults.test.ts:92"
    ).DatabaseSync)(nestedDatabase);
    nested.exec(`
      INSERT INTO runs(
        run_id,session_id,playbook,engine_owner,schema_version,status,
        state_id,context_json,created_at,updated_at
      ) VALUES(
        'run-nested', 'session-nested', 'research', 'typescript', 2, 'running',
        'dispatch', '{}', '2026-08-23T00:00:00.000Z', '2026-08-23T00:00:00.000Z'
      );
    `);
    nested.close();
  }

  const sourceManifest = path.join(root, "sources.json");
  writeFileSync(
    sourceManifest,
    `${JSON.stringify({
      schema_version: 1,
      migration_id: `fault-${label}`,
      stores: [
        options.reconciled === true
          ? {
              id: "orchestration-db",
              kind: "sqlite",
              sources: [
                { source_id: "main", path: database },
                { source_id: "nested", path: nestedDatabase },
              ],
              reconciliation: {
                strategy: "strict-union",
                precedence: ["main", "nested"],
              },
            }
          : { id: "orchestration-db", kind: "sqlite", path: database },
        { id: "orchestration-receipt-key", kind: "file", path: key },
        { id: "subagent-sessions", kind: "tree", path: sessions },
      ],
    })}\n`,
    { mode: 0o600 }
  );
  const planPath = path.join(root, "plan.json");
  const stateRoot = path.join(root, "state");
  const rootOptions = { env: { PENNY_STATE_ROOT: stateRoot } } as const;
  const plan = createStateMigrationPlan({
    projectRoot,
    sourceManifestPath: sourceManifest,
    outputPath: planPath,
    rootOptions,
  });
  const sourceFiles = [
    database,
    ...(options.reconciled === true ? [nestedDatabase] : []),
    key,
    sessionFile,
  ];
  return {
    projectRoot,
    sourceManifest,
    planPath,
    stateRoot,
    database,
    key,
    sessionFile,
    rootOptions,
    plan,
    sourceFiles,
    sourceBytes: sourceFiles.map((file) => readFileSync(file)),
  };
}

function oneShotFault(testCase: FaultCase): {
  readonly injector: StateMigrationFaultInjector;
  readonly observed: () => boolean;
} {
  let observed = false;
  return {
    injector: (event: StateMigrationFaultEvent) => {
      if (!observed && event.point === testCase.point && event.operation === testCase.operation) {
        observed = true;
        throw new Error(`fault:${testCase.point}:${testCase.operation}`);
      }
    },
    observed: () => observed,
  };
}

function expectSourcesUnchanged(input: FaultFixture): void {
  for (const [index, file] of input.sourceFiles.entries()) {
    expect(readFileSync(file)).toEqual(input.sourceBytes[index]);
  }
}

async function apply(input: FaultFixture, faultInjector?: StateMigrationFaultInjector) {
  return applyStateMigration({
    projectRoot: input.projectRoot,
    sourceManifestPath: input.sourceManifest,
    planPath: input.planPath,
    rootOptions: input.rootOptions,
    ...(faultInjector === undefined ? {} : { faultInjector }),
  });
}

async function verify(input: FaultFixture, faultInjector?: StateMigrationFaultInjector) {
  return verifyStateMigration({
    projectRoot: input.projectRoot,
    planPath: input.planPath,
    rootOptions: input.rootOptions,
    ...(faultInjector === undefined ? {} : { faultInjector }),
  });
}

async function finalize(input: FaultFixture, faultInjector?: StateMigrationFaultInjector) {
  return finalizeStateMigration({
    projectRoot: input.projectRoot,
    planPath: input.planPath,
    rootOptions: input.rootOptions,
    ...(faultInjector === undefined ? {} : { faultInjector }),
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("migration durable-boundary fault injection", () => {
  it("recovers apply across catalog, journal, SQLite, file, tree, verification, and fsync boundaries", async () => {
    const cases: readonly FaultCase[] = [
      { point: "apply-start", operation: "apply" },
      { point: "file-fsync.after", operation: "migration-lock" },
      { point: "catalog-reservation.after", operation: "catalog-reservation" },
      { point: "file-fsync.after", operation: "journal:initial" },
      { point: "metadata-rename.after", operation: "journal:initial" },
      { point: "metadata-write.after", operation: "journal:initial" },
      { point: "sqlite-backup.after", operation: "orchestration-db" },
      { point: "file-fsync.after", operation: "orchestration-db" },
      { point: "directory-fsync.after", operation: "orchestration-db" },
      { point: "file-copy.after", operation: "orchestration-receipt-key" },
      { point: "tree-copy.after", operation: "subagent-sessions" },
      { point: "store-verification.after", operation: "subagent-sessions" },
      { point: "metadata-write.after", operation: "journal:store:subagent-sessions" },
      { point: "directory-fsync.after", operation: "staged-project" },
      { point: "metadata-write.after", operation: "journal:applied" },
    ];

    for (const [index, testCase] of cases.entries()) {
      const input = fixture(`apply-${index}`);
      const fault = oneShotFault(testCase);
      await expect(apply(input, fault.injector), JSON.stringify(testCase)).rejects.toThrow(
        `fault:${testCase.point}:${testCase.operation}`
      );
      expect(fault.observed(), JSON.stringify(testCase)).toBe(true);
      await expect(apply(input), JSON.stringify(testCase)).resolves.toMatchObject({
        phase: "applied",
        finalized: false,
      });
      expectSourcesUnchanged(input);
      expect(existsSync(path.join(input.stateRoot, "projects", input.plan.target_project_id))).toBe(
        false
      );
      expect(() => resolvePennyProjectState(input.projectRoot, input.rootOptions)).toThrow(
        "relink_pending"
      );
    }
  });

  it("recovers checksum-bound SQLite reconciliation boundaries", async () => {
    const cases: readonly FaultCase[] = [
      { point: "sqlite-reconciliation.before", operation: "orchestration-db" },
      { point: "file-fsync.after", operation: "orchestration-db" },
      { point: "sqlite-reconciliation.after", operation: "orchestration-db" },
    ];

    for (const [index, testCase] of cases.entries()) {
      const input = fixture(`reconcile-${index}`, { reconciled: true });
      const fault = oneShotFault(testCase);
      await expect(apply(input, fault.injector), JSON.stringify(testCase)).rejects.toThrow(
        `fault:${testCase.point}:${testCase.operation}`
      );
      expect(fault.observed(), JSON.stringify(testCase)).toBe(true);
      await expect(apply(input), JSON.stringify(testCase)).resolves.toMatchObject({
        phase: "applied",
        finalized: false,
      });
      expectSourcesUnchanged(input);
    }
  });

  it("recovers verification and its durable journal transition", async () => {
    const cases: readonly FaultCase[] = [
      { point: "store-verification.after", operation: "orchestration-db" },
      { point: "store-verification.after", operation: "cross-store" },
      { point: "file-fsync.after", operation: "journal:verified" },
      { point: "metadata-rename.after", operation: "journal:verified" },
      { point: "metadata-write.after", operation: "journal:verified" },
    ];

    for (const [index, testCase] of cases.entries()) {
      const input = fixture(`verify-${index}`);
      await apply(input);
      const fault = oneShotFault(testCase);
      await expect(verify(input, fault.injector), JSON.stringify(testCase)).rejects.toThrow(
        `fault:${testCase.point}:${testCase.operation}`
      );
      expect(fault.observed(), JSON.stringify(testCase)).toBe(true);
      await expect(verify(input), JSON.stringify(testCase)).resolves.toMatchObject({
        phase: "verified",
        finalized: false,
      });
      expectSourcesUnchanged(input);
      expect(existsSync(path.join(input.stateRoot, "projects", input.plan.target_project_id))).toBe(
        false
      );
    }
  });

  it("recovers finalize across marker, rename, directory fsync, activation, and journal boundaries", async () => {
    const cases: readonly FaultCase[] = [
      { point: "store-verification.after", operation: "cross-store" },
      { point: "file-fsync.after", operation: "finalized-marker" },
      { point: "metadata-rename.after", operation: "finalized-marker" },
      { point: "directory-fsync.after", operation: "finalized-marker" },
      { point: "finalized-marker.after", operation: "finalized-marker" },
      { point: "project-rename.before", operation: "project-publication" },
      { point: "project-rename.after", operation: "project-publication" },
      { point: "directory-fsync.after", operation: "project-publication" },
      { point: "catalog-activation.before", operation: "catalog-activation" },
      { point: "catalog-activation.after", operation: "catalog-activation" },
      { point: "file-fsync.after", operation: "journal:finalized" },
      { point: "metadata-rename.after", operation: "journal:finalized" },
      { point: "metadata-write.after", operation: "journal:finalized" },
    ];

    for (const [index, testCase] of cases.entries()) {
      const input = fixture(`finalize-${index}`);
      await apply(input);
      await verify(input);
      const fault = oneShotFault(testCase);
      await expect(finalize(input, fault.injector), JSON.stringify(testCase)).rejects.toThrow(
        `fault:${testCase.point}:${testCase.operation}`
      );
      expect(fault.observed(), JSON.stringify(testCase)).toBe(true);
      await expect(finalize(input), JSON.stringify(testCase)).resolves.toMatchObject({
        phase: "finalized",
        finalized: true,
      });
      const resolved = resolvePennyProjectState(input.projectRoot, input.rootOptions);
      expect(resolved.projectId).toBe(input.plan.target_project_id);
      expect(existsSync(path.join(resolved.paths.root, STATE_MIGRATION_FINALIZED_MARKER))).toBe(
        true
      );
      expectSourcesUnchanged(input);
    }
  });
});
