import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ArtifactStore, initializePennyState } from "@penny/orchestration/source";
import { afterEach, describe, expect, it } from "vitest";

import { executeArtifactRead, loadArtifactRuntimeConfig } from "../../artifact-runtime.js";
import { outputMetadata } from "../fixtures.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(content = "alpha βeta gamma") {
  const sandbox = mkdtempSync(join(tmpdir(), "penny-artifact-runtime-"));
  roots.push(sandbox);
  chmodSync(sandbox, 0o700);
  const projectRoot = join(sandbox, "project");
  mkdirSync(projectRoot, { mode: 0o700 });
  const env = { PENNY_STATE_ROOT: join(sandbox, "state") };
  const state = initializePennyState(projectRoot, { env });
  using store = new ArtifactStore(state.paths.artifacts.root, { projectId: state.projectId });
  const ref = store.persist({ metadata: outputMetadata(), content });
  const config = loadArtifactRuntimeConfig(projectRoot, env);
  return { root: state.paths.artifacts.root, ref, config, content };
}

interface ArtifactReadPayload {
  content: string;
  artifact_ref: { schema_version: number };
  next_range: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function payload(result: Awaited<ReturnType<typeof executeArtifactRead>>): ArtifactReadPayload {
  const text = result.result.content[0]?.type === "text" ? result.result.content[0].text : "{}";
  const parsed: unknown = JSON.parse(text);
  if (
    !isRecord(parsed) ||
    typeof parsed.content !== "string" ||
    !isRecord(parsed.artifact_ref) ||
    typeof parsed.artifact_ref.schema_version !== "number" ||
    !("next_range" in parsed)
  ) {
    throw new Error("artifact_read returned an invalid test payload");
  }
  return {
    content: parsed.content,
    artifact_ref: { schema_version: parsed.artifact_ref.schema_version },
    next_range: parsed.next_range,
  };
}

describe("artifact_read direct ID communication", () => {
  it("reads an existing ID without invocation, grant, caller, or clock state", async () => {
    const item = fixture();
    const execution = await executeArtifactRead(item.config, { artifact: item.ref.artifact_id });
    expect(execution.code).toBe("OK");
    const body = payload(execution);
    expect(body.content).toBe(item.content);
    expect(body.artifact_ref.schema_version).toBe(2);
    expect(body.artifact_ref).not.toHaveProperty("consumer_scope");
    expect(body.next_range).toBeNull();
  });

  it("continues with non-expiring explicit UTF-8 ranges", async () => {
    const item = fixture("aβcdef");
    const first = await executeArtifactRead(item.config, {
      artifact: item.ref.artifact_id,
      range: { start: 0, end: 3 },
    });
    expect(payload(first).content).toBe("aβ");
    const second = await executeArtifactRead(item.config, {
      artifact: item.ref.artifact_id,
      range: { start: 3 },
    });
    expect(payload(second).content).toBe("cdef");
  });

  it("returns bounded invalid-id and missing errors", async () => {
    const item = fixture();
    const invalid = await executeArtifactRead(item.config, { artifact: "bad" });
    expect(invalid.code).toBe("ARTIFACT_INVALID_ID");
    const missing = await executeArtifactRead(item.config, {
      artifact: `art_${"0".repeat(64)}`,
    });
    expect(missing.code).toBe("ARTIFACT_MISSING");
  });

  it("detects corrupt immutable bytes", async () => {
    const item = fixture();
    const objectPath = join(
      item.root,
      "objects",
      "sha256",
      item.ref.content_digest.slice(0, 2),
      item.ref.content_digest.slice(2)
    );
    writeFileSync(objectPath, "corrupt", { mode: 0o600 });
    const execution = await executeArtifactRead(item.config, { artifact: item.ref.artifact_id });
    expect(execution.code).toBe("ARTIFACT_DIGEST_MISMATCH");
  });

  it("rejects ranges that split a UTF-8 code point", async () => {
    const item = fixture("aβc");
    const execution = await executeArtifactRead(item.config, {
      artifact: item.ref.artifact_id,
      range: { start: 2 },
    });
    expect(execution.code).toBe("ARTIFACT_RANGE_INVALID");
  });
});
