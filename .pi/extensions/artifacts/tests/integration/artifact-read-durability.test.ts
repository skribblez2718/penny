import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ArtifactStore,
  Checkpointer,
  applyStateMigration,
  createStateMigrationPlan,
  finalizeStateMigration,
  initializePennyState,
  verifyStateMigration,
} from "@penny/orchestration/source";
import { afterEach, describe, expect, it, vi } from "vitest";

import artifactExtension from "../../index.js";
import { executeArtifactRead, loadArtifactRuntimeConfig } from "../../artifact-runtime.js";
import { createTestExtensionApi } from "../../../../lib/tests/test-narrowers.js";

interface SqliteModule {
  readonly DatabaseSync: typeof import("node:sqlite").DatabaseSync;
}

interface ArtifactToolContext {
  readonly cwd: string;
  readonly sessionManager: { getSessionId(): string };
}

interface RegisteredArtifactTool {
  readonly name: string;
  execute(
    toolCallId: string,
    params: { artifact: string },
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    context: ArtifactToolContext
  ): Promise<{ content: Array<{ type: string; text: string }> }>;
}

interface ArtifactReadBody {
  readonly content: string;
  readonly artifact_ref: Record<string, unknown>;
  readonly truncated: boolean;
  readonly next_range: unknown;
}

const PROCESS_CHILD_MODE = process.env.PENNY_ARTIFACT_PROCESS_CHILD === "1";
const roots: string[] = [];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSqliteModule(value: object | undefined): value is SqliteModule {
  return value !== undefined && "DatabaseSync" in value && typeof value.DatabaseSync === "function";
}

function sqliteModule(): SqliteModule {
  const module = process.getBuiltinModule("node:" + "sqlite");
  if (!isSqliteModule(module)) {
    throw new Error("Node.js runtime does not provide node:sqlite");
  }
  return module;
}

function isRegisteredArtifactTool(value: unknown): value is RegisteredArtifactTool {
  return isRecord(value) && value.name === "artifact_read" && typeof value.execute === "function";
}

function registeredArtifactTool(): RegisteredArtifactTool {
  let registered: unknown;
  artifactExtension(
    createTestExtensionApi({
      onRegisterTool(definition) {
        registered = definition;
      },
    })
  );
  if (!isRegisteredArtifactTool(registered)) {
    throw new Error("artifact_read tool was not registered");
  }
  return registered;
}

function parseBody(text: string): ArtifactReadBody {
  const value: unknown = JSON.parse(text);
  if (
    !isRecord(value) ||
    typeof value.content !== "string" ||
    !isRecord(value.artifact_ref) ||
    typeof value.truncated !== "boolean" ||
    !("next_range" in value)
  ) {
    throw new Error("artifact_read returned an invalid success body");
  }
  return {
    content: value.content,
    artifact_ref: value.artifact_ref,
    truncated: value.truncated,
    next_range: value.next_range,
  };
}

function toolBody(
  result: Awaited<ReturnType<RegisteredArtifactTool["execute"]>>
): ArtifactReadBody {
  const first = result.content[0];
  if (first?.type !== "text") throw new Error("artifact_read returned no text result");
  return parseBody(first.text);
}

function runtimeBody(result: Awaited<ReturnType<typeof executeArtifactRead>>): ArtifactReadBody {
  expect(result.code).toBe("OK");
  const first = result.result.content[0];
  if (first?.type !== "text") throw new Error("artifact runtime returned no text result");
  return parseBody(first.text);
}

function artifactFixture(
  content: string,
  operationId: string
): {
  readonly projectRoot: string;
  readonly stateRoot: string;
  readonly artifactId: string;
} {
  const sandbox = mkdtempSync(path.join(tmpdir(), "penny-artifact-durability-"));
  roots.push(sandbox);
  chmodSync(sandbox, 0o700);
  const projectRoot = path.join(sandbox, "project");
  const stateRoot = path.join(sandbox, "state");
  mkdirSync(projectRoot, { mode: 0o700 });
  const state = initializePennyState(projectRoot, { env: { PENNY_STATE_ROOT: stateRoot } });
  let artifactId: string;
  {
    using store = ArtifactStore.openExisting(state.paths.artifacts.root, {
      projectId: state.projectId,
    });
    artifactId = store.persist({
      metadata: {
        schema_version: 2,
        run_id: "producer-session-a",
        phase: "final",
        branch_id: null,
        kind: "agent-output",
        operation_id: operationId,
        version: 1,
        producer: "agent:fixture",
        media_type: "text/plain; charset=utf-8",
        parent_ref: null,
        upstream_refs: [],
      },
      content,
    }).artifact_id;
  }
  return { projectRoot, stateRoot, artifactId };
}

function legacyArtifactRows(databasePath: string): void {
  const database = new (sqliteModule().DatabaseSync)(databasePath);
  try {
    database.exec("DROP TRIGGER artifacts_no_update; DROP TRIGGER artifacts_no_delete;");
    const row = database
      .prepare("SELECT artifact_id, ref_json, metadata_json FROM artifacts")
      .get();
    if (!isRecord(row) || typeof row.artifact_id !== "string") {
      throw new Error("legacy artifact fixture row is absent");
    }
    if (typeof row.ref_json !== "string" || typeof row.metadata_json !== "string") {
      throw new Error("legacy artifact fixture JSON is absent");
    }
    const refValue: unknown = JSON.parse(row.ref_json);
    const metadataValue: unknown = JSON.parse(row.metadata_json);
    if (!isRecord(refValue) || !isRecord(metadataValue)) {
      throw new Error("legacy artifact fixture JSON is invalid");
    }
    database
      .prepare("UPDATE artifacts SET ref_json = ?, metadata_json = ? WHERE artifact_id = ?")
      .run(
        JSON.stringify({
          ...refValue,
          schema_version: 1,
          consumer_scope: ["legacy:reader-session"],
        }),
        JSON.stringify({
          ...metadataValue,
          schema_version: 1,
          consumer_scope: ["legacy:reader-session"],
        }),
        row.artifact_id
      );
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
  vi.useRealTimers();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

if (!PROCESS_CHILD_MODE) {
  describe("artifact_read unrestricted exact-ID durability", () => {
    it("reads byte-for-byte from independent session contexts after a century-advanced clock", async () => {
      const content = "session-independent🙂\nexact bytes";
      const fixture = artifactFixture(content, "durable-session-operation");
      vi.stubEnv("PENNY_STATE_ROOT", fixture.stateRoot);

      const first = await registeredArtifactTool().execute(
        "producer-session-read",
        { artifact: fixture.artifactId },
        undefined,
        undefined,
        {
          cwd: fixture.projectRoot,
          sessionManager: { getSessionId: () => "reader-session-b" },
        }
      );
      expect(toolBody(first).content).toBe(content);

      const advanced = new Date("2126-08-25T12:00:00.000Z");
      vi.useFakeTimers();
      vi.setSystemTime(advanced);
      expect(Date.now()).toBe(advanced.getTime());
      const second = await registeredArtifactTool().execute(
        "advanced-session-read",
        { artifact: fixture.artifactId },
        undefined,
        undefined,
        {
          cwd: fixture.projectRoot,
          sessionManager: { getSessionId: () => "reader-session-c" },
        }
      );
      const body = toolBody(second);
      expect(body.content).toBe(content);
      expect(body.artifact_ref.run_id).toBe("producer-session-a");
      expect(body.artifact_ref).not.toHaveProperty("consumer_scope");
      expect(body.truncated).toBe(false);
      expect(body.next_range).toBeNull();
    });

    it("reads the same exact ID after a fresh Node process starts under an advanced clock", () => {
      const content = "restart-safe漢\nbyte-for-byte\u0000payload";
      const fixture = artifactFixture(content, "process-restart-operation");
      const here = path.dirname(fileURLToPath(import.meta.url));
      const vitest = path.resolve(here, "../../node_modules/vitest/vitest.mjs");
      const config = path.resolve(here, "../vitest.integration.config.ts");
      const testFile = fileURLToPath(import.meta.url);
      const child = spawnSync(
        process.execPath,
        [vitest, "run", "--config", config, testFile, "--reporter=basic"],
        {
          cwd: path.resolve(here, "../.."),
          encoding: "utf8",
          env: {
            ...process.env,
            PENNY_ARTIFACT_PROCESS_CHILD: "1",
            PENNY_ARTIFACT_CHILD_ID: fixture.artifactId,
            PENNY_ARTIFACT_CHILD_CONTENT_BASE64: Buffer.from(content, "utf8").toString("base64"),
            PENNY_ARTIFACT_CHILD_PROJECT_ROOT: fixture.projectRoot,
            PENNY_ARTIFACT_CHILD_NOW: String(Date.parse("2226-08-25T12:00:00.000Z")),
            PENNY_STATE_ROOT: fixture.stateRoot,
          },
          maxBuffer: 1024 * 1024,
        }
      );
      expect(
        child.status,
        `fresh-process artifact read failed\nstdout:\n${child.stdout}\nstderr:\n${child.stderr}`
      ).toBe(0);
    }, 15_000);

    it("reads a migrated schema-v1 artifact through the normal schema-v2 runtime", async () => {
      const sandbox = mkdtempSync(path.join(tmpdir(), "penny-artifact-legacy-migration-"));
      roots.push(sandbox);
      chmodSync(sandbox, 0o700);
      const projectRoot = path.join(sandbox, "project");
      const currentRoot = path.join(sandbox, "current-artifacts");
      const legacyRoot = path.join(sandbox, "legacy-artifacts");
      const stateRoot = path.join(sandbox, "state");
      mkdirSync(projectRoot, { mode: 0o700 });
      mkdirSync(currentRoot, { mode: 0o700 });
      mkdirSync(legacyRoot, { mode: 0o700 });

      {
        using _current = ArtifactStore.provision(currentRoot);
      }
      const content = "migrated legacy exact bytes🙂";
      let artifactId: string;
      {
        using legacy = ArtifactStore.provision(legacyRoot);
        artifactId = legacy.persist({
          metadata: {
            schema_version: 2,
            run_id: "legacy-run",
            phase: "legacy-phase",
            branch_id: null,
            kind: "agent-output",
            operation_id: "legacy-operation",
            version: 1,
            producer: "agent:legacy",
            media_type: "text/plain; charset=utf-8",
            parent_ref: null,
            upstream_refs: [],
          },
          content,
        }).artifact_id;
      }
      legacyArtifactRows(path.join(legacyRoot, "manifest.db"));

      const orchestrationDatabase = path.join(sandbox, "orchestration.db");
      {
        using _checkpointer = new Checkpointer(orchestrationDatabase);
      }
      chmodSync(orchestrationDatabase, 0o600);
      const receiptKey = path.join(sandbox, "receipt-key");
      writeFileSync(receiptKey, Buffer.alloc(32, 0x51), { mode: 0o600 });

      const sourceManifestPath = path.join(sandbox, "sources.json");
      const planPath = path.join(sandbox, "plan.json");
      writeFileSync(
        sourceManifestPath,
        `${JSON.stringify({
          schema_version: 1,
          migration_id: "legacy-artifact-read-001",
          stores: [
            {
              id: "orchestration-db",
              kind: "sqlite",
              path: orchestrationDatabase,
            },
            {
              id: "orchestration-receipt-key",
              kind: "file",
              path: receiptKey,
            },
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
                selection_policy: "require-identical",
              },
            },
            {
              id: "artifact-objects",
              kind: "tree",
              path: path.join(legacyRoot, "objects"),
            },
          ],
        })}\n`,
        { mode: 0o600 }
      );
      const rootOptions = { env: { PENNY_STATE_ROOT: stateRoot } } as const;
      createStateMigrationPlan({
        projectRoot,
        sourceManifestPath,
        outputPath: planPath,
        rootOptions,
      });
      await applyStateMigration({ projectRoot, sourceManifestPath, planPath, rootOptions });
      await verifyStateMigration({ projectRoot, planPath, rootOptions });
      await finalizeStateMigration({ projectRoot, planPath, rootOptions });

      const execution = await executeArtifactRead(
        loadArtifactRuntimeConfig(projectRoot, { PENNY_STATE_ROOT: stateRoot }),
        { artifact: artifactId }
      );
      const body = runtimeBody(execution);
      expect(body.content).toBe(content);
      expect(body.artifact_ref.schema_version).toBe(2);
      expect(body.artifact_ref.artifact_id).toBe(artifactId);
      expect(body.artifact_ref).not.toHaveProperty("consumer_scope");
    });
  });
} else {
  describe("artifact_read fresh-process fixture", () => {
    it("reads the parent-persisted ID from a different session after time advances", async () => {
      const artifactId = process.env.PENNY_ARTIFACT_CHILD_ID;
      const encodedContent = process.env.PENNY_ARTIFACT_CHILD_CONTENT_BASE64;
      const projectRoot = process.env.PENNY_ARTIFACT_CHILD_PROJECT_ROOT;
      const nowValue = process.env.PENNY_ARTIFACT_CHILD_NOW;
      if (
        artifactId === undefined ||
        encodedContent === undefined ||
        projectRoot === undefined ||
        nowValue === undefined
      ) {
        throw new Error("fresh-process artifact fixture environment is incomplete");
      }
      const now = Number(nowValue);
      if (!Number.isSafeInteger(now)) throw new Error("fresh-process clock is invalid");
      vi.useFakeTimers();
      vi.setSystemTime(now);
      expect(Date.now()).toBe(now);

      const result = await registeredArtifactTool().execute(
        "fresh-process-reader",
        { artifact: artifactId },
        undefined,
        undefined,
        {
          cwd: projectRoot,
          sessionManager: { getSessionId: () => "reader-session-after-restart" },
        }
      );
      const body = toolBody(result);
      expect(body.content).toBe(Buffer.from(encodedContent, "base64").toString("utf8"));
      expect(body.artifact_ref.run_id).toBe("producer-session-a");
      expect(body.truncated).toBe(false);
    });
  });
}
