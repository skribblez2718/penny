import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ArtifactStore, initializePennyState } from "@penny/orchestration/source";
import { afterEach, describe, expect, it, vi } from "vitest";

import artifactExtension from "../../index.js";
import {
  createTestExtensionApi,
  parseJson,
  requireArrayElement,
  requireRecord,
} from "../../../../lib/tests/test-narrowers.js";
import { outputMetadata } from "../fixtures.js";

interface RegisteredArtifactTool {
  name: string;
  parameters: { properties: Record<string, unknown> };
  execute(
    toolCallId: string,
    params: { artifact: string },
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    context: { cwd: string }
  ): Promise<{ content: Array<{ type: string; text: string }> }>;
}

function isRegisteredArtifactTool(value: unknown): value is RegisteredArtifactTool {
  if (typeof value !== "object" || value === null) return false;
  if (!("name" in value) || typeof value.name !== "string") return false;
  if (!("execute" in value) || typeof value.execute !== "function") return false;
  if (!("parameters" in value) || typeof value.parameters !== "object" || !value.parameters) {
    return false;
  }
  return "properties" in value.parameters;
}

function requireRegisteredArtifactTool(value: unknown): RegisteredArtifactTool {
  if (!isRegisteredArtifactTool(value)) {
    throw new Error("artifact extension registered an invalid tool fixture");
  }
  return value;
}

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("artifact extension", () => {
  it("registers the simple ID + range surface and reads without grant environment", async () => {
    const root = mkdtempSync(join(tmpdir(), "penny-artifact-extension-"));
    roots.push(root);
    chmodSync(root, 0o700);
    const projectRoot = join(root, "project");
    const stateRoot = join(root, "state");
    mkdirSync(projectRoot, { mode: 0o700 });
    vi.stubEnv("PENNY_STATE_ROOT", stateRoot);
    vi.stubEnv("PENNY_ARTIFACT_ROOT", "");
    vi.stubEnv("PENNY_ARTIFACT_GRANT_ROOT", "");
    const state = initializePennyState(projectRoot, { env: { PENNY_STATE_ROOT: stateRoot } });
    using store = new ArtifactStore(state.paths.artifacts.root, { projectId: state.projectId });
    const ref = store.persist({ metadata: outputMetadata(), content: "hello" });

    let registered: unknown;
    artifactExtension(
      createTestExtensionApi({
        onRegisterTool: (definition) => {
          registered = definition;
        },
      })
    );

    const tool = requireRegisteredArtifactTool(registered);
    expect(tool.name).toBe("artifact_read");
    expect(tool.parameters.properties).toHaveProperty("artifact");
    expect(tool.parameters.properties).toHaveProperty("range");
    expect(tool.parameters.properties).not.toHaveProperty("cursor");
    const result = await tool.execute("call", { artifact: ref.artifact_id }, undefined, undefined, {
      cwd: projectRoot,
    });
    const content = requireArrayElement(result.content, 0, "artifact tool returned no content");
    const body = requireRecord(parseJson(content.text), "artifact tool returned a non-object body");
    expect(body.content).toBe("hello");
    expect(body.next_range).toBeNull();
  });
});
