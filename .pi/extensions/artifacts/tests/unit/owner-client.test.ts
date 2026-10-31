import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initializePennyState, resolvePennyProjectState } from "@penny/orchestration";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ArtifactClientError,
  canonicalArtifactJson,
  expectedArtifactRef,
  parseArtifactRef,
  parseOutputArtifactMetadata,
  persistArtifactOutput,
  resolveArtifactRoot,
  readArtifactById,
  readArtifactOutput,
} from "../../owner-client.js";
import { outputMetadata } from "../fixtures.js";

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): { projectRoot: string; env: NodeJS.ProcessEnv } {
  const root = mkdtempSync(join(tmpdir(), "penny-owner-client-"));
  roots.push(root);
  chmodSync(root, 0o700);
  const projectRoot = join(root, "project");
  mkdirSync(projectRoot, { mode: 0o700 });
  const env = { PENNY_STATE_ROOT: join(root, "state") };
  initializePennyState(projectRoot, { env });
  return { projectRoot, env };
}

function isReaderFunction(value: unknown): value is (input: unknown) => Promise<unknown> {
  return typeof value === "function";
}

describe("artifact owner client", () => {
  it("persists, re-reads, and resolves by exact ID", async () => {
    const { projectRoot, env } = fixture();
    const ref = await persistArtifactOutput({
      metadata: outputMetadata(),
      output: "exact bytes",
      cwd: projectRoot,
      env,
    });
    expect(ref.schema_version).toBe(2);
    expect(ref).not.toHaveProperty("consumer_scope");
    expect((await readArtifactOutput({ ref, projectRoot, env })).toString()).toBe("exact bytes");
    const direct = await readArtifactById({ artifactId: ref.artifact_id, projectRoot, env });
    expect(direct.ref).toEqual(ref);
    expect(direct.content.toString()).toBe("exact bytes");
  });

  it("reads exact artifacts independently of an unrelated stale checkpoint schema", async () => {
    const { projectRoot, env } = fixture();
    const ref = await persistArtifactOutput({
      metadata: outputMetadata(),
      output: "still readable",
      cwd: projectRoot,
      env,
    });
    const state = resolvePennyProjectState(projectRoot, { env });
    const sqlite = process.getBuiltinModule("node:sqlite");
    if (sqlite === undefined) throw new Error("node:sqlite unavailable");
    using database = new sqlite.DatabaseSync(state.paths.orchestration.database);
    database.exec(
      "DROP TABLE host_operation_calls; DROP TABLE child_workflow_calls; PRAGMA user_version=10;"
    );
    expect(resolveArtifactRoot(projectRoot, env)).toBe(state.paths.artifacts.root);
    expect(
      (await readArtifactById({ artifactId: ref.artifact_id, projectRoot, env })).content.toString()
    ).toBe("still readable");
  });

  it("rejects a retired schema-v1 ref", () => {
    expect(() =>
      parseArtifactRef({
        schema_version: 1,
        artifact_id: "art_0526090a3d11649ef309c47abb6b890a802b9412d299ac0baeff6fef1aaf2e5a",
        run_id: "legacy-run",
        phase: "legacy-phase",
        branch_id: null,
        kind: "agent-output",
        operation_id: "legacy-operation",
        version: 1,
        producer: "agent:legacy",
        consumer_scope: ["ignored"],
        media_type: "text/plain",
        byte_length: 0,
        content_digest: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        store_ref:
          "artifact://sha256/e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      })
    ).toThrow(/schema_version|consumer_scope/);
  });

  it("rejects retired schema-v1 output metadata", () => {
    expect(() =>
      parseOutputArtifactMetadata({
        ...outputMetadata(),
        schema_version: 1,
        consumer_scope: ["state:any"],
      })
    ).toThrow(/unsupported output_artifact schema version/);
  });
  it.each([false, true])(
    "forwards real reader call options with env present=%s",
    async (present) => {
      // Module-local calls cannot be intercepted by ESM export spies. Compile the actual
      // two function declarations with only the downstream reader boundary substituted.
      const filename = fileURLToPath(new URL("../../owner-client.ts", import.meta.url));
      const source = readFileSync(filename, "utf8");
      const parsed = ts.createSourceFile(filename, source, ts.ScriptTarget.ES2022, true);
      for (const name of ["readArtifactById", "readArtifactOutput"]) {
        const declaration = parsed.statements.find(
          (statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === name
        );
        if (declaration === undefined) throw new Error(`missing real reader ${name}`);
        const javascript = ts.transpileModule(declaration.getText(parsed).replace(/^export /, ""), {
          compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
        }).outputText;
        const calls: unknown[] = [];
        const ref = expectedArtifactRef(outputMetadata(), "call bytes");
        const read = { ref, content: Buffer.from("call bytes") };
        const invoke: unknown = runInNewContext(`${javascript}; ${name}`, {
          readArtifactsById: (options: unknown) => {
            calls.push(options);
            return Promise.resolve([read]);
          },
          readArtifactById: (options: unknown) => {
            calls.push(options);
            return Promise.resolve(read);
          },
          parseArtifactRef,
          canonicalArtifactJson,
          ArtifactClientError,
        });
        if (!isReaderFunction(invoke)) throw new Error("compiled reader is not callable");
        const env = { PENNY_STATE_ROOT: "isolated-test-state" };
        const projectRoot = "isolated-test-project";
        const result = await invoke({
          artifactId: ref.artifact_id,
          ref,
          projectRoot,
          ...(present ? { env } : {}),
        });
        expect(result).toEqual(name === "readArtifactById" ? read : read.content);
        expect(calls).toEqual([
          {
            ...(name === "readArtifactById"
              ? { artifactIds: [ref.artifact_id] }
              : { artifactId: ref.artifact_id }),
            projectRoot,
            ...(present ? { env } : {}),
          },
        ]);
        if (present) {
          const options = calls[0];
          if (options === null || typeof options !== "object" || !("env" in options))
            throw new Error("forwarded env missing");
          expect(options.env).toBe(env);
        }
      }
    }
  );

  it("uses the default environment when omitted and still rejects substituted ref metadata", async () => {
    const { projectRoot, env } = fixture();
    vi.stubEnv("PENNY_STATE_ROOT", env.PENNY_STATE_ROOT);
    const ref = await persistArtifactOutput({
      metadata: outputMetadata(),
      output: "default env bytes",
      cwd: projectRoot,
    });
    expect((await readArtifactById({ artifactId: ref.artifact_id, projectRoot })).ref).toEqual(ref);
    expect((await readArtifactOutput({ ref, projectRoot })).toString()).toBe("default env bytes");
    await expect(
      readArtifactOutput({ ref: { ...ref, producer: "agent:foreign" }, projectRoot })
    ).rejects.toMatchObject({ code: "ARTIFACT_REF_INVALID" });
  });
});
