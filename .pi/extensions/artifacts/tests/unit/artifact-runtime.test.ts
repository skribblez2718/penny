import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ArtifactStore, encodeCanonicalPng, initializePennyState } from "@penny/orchestration";
import { afterEach, describe, expect, it } from "vitest";

import { executeArtifactRead, loadArtifactRuntimeConfig } from "../../artifact-runtime.js";
import { outputMetadata } from "../fixtures.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(
  content: string | Uint8Array = "alpha βeta gamma",
  metadataOverrides: Parameters<typeof outputMetadata>[0] = {}
) {
  const sandbox = mkdtempSync(join(tmpdir(), "penny-artifact-runtime-"));
  roots.push(sandbox);
  chmodSync(sandbox, 0o700);
  const projectRoot = join(sandbox, "project");
  mkdirSync(projectRoot, { mode: 0o700 });
  const env = { PENNY_STATE_ROOT: join(sandbox, "state") };
  const state = initializePennyState(projectRoot, { env });
  using store = new ArtifactStore(state.paths.artifacts.root, { projectId: state.projectId });
  const ref = store.persist({ metadata: outputMetadata(metadataOverrides), content });
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

  it("returns exact canonical PNG bytes only in a Pi image block with bounded metadata", async () => {
    const bytes = Buffer.from(
      encodeCanonicalPng({
        width: 1,
        height: 1,
        rgba: Uint8Array.from([12, 34, 56, 255]),
      })
    );
    const item = fixture(bytes, { media_type: "image/png" });
    const events: Array<{ event: string; context: Record<string, unknown> }> = [];
    const execution = await executeArtifactRead(
      item.config,
      { artifact: item.ref.artifact_id },
      {
        telemetry: {
          info: (event, context) => events.push({ event, context }),
          warn: (event, context) => events.push({ event, context }),
        },
      }
    );

    expect(execution.code).toBe("OK");
    expect(execution.result.content).toHaveLength(2);
    const metadata = execution.result.content[0];
    const image = execution.result.content[1];
    if (metadata?.type !== "text" || image?.type !== "image") {
      throw new Error("artifact_read did not return text plus image content");
    }
    expect(JSON.parse(metadata.text)).toMatchObject({
      ok: true,
      type: "artifact_image",
      artifact_ref: { artifact_id: item.ref.artifact_id },
      media_type: "image/png",
      content_digest: item.ref.content_digest,
      image: { width: 1, height: 1, channels: 4, pixel_count: 1, decoded_bytes: 4 },
    });
    expect(metadata.text).not.toContain(bytes.toString("base64"));
    expect(image).toEqual({ type: "image", data: bytes.toString("base64"), mimeType: "image/png" });
    expect(execution.result.details).toBeUndefined();
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain(bytes.toString("base64"));
    expect(JSON.stringify(events)).not.toContain(item.root);
  });

  it("rejects byte ranges for images", async () => {
    const bytes = encodeCanonicalPng({
      width: 1,
      height: 1,
      rgba: Uint8Array.from([0, 0, 0, 255]),
    });
    const item = fixture(bytes, { media_type: "image/png" });
    const execution = await executeArtifactRead(item.config, {
      artifact: item.ref.artifact_id,
      range: { start: 0 },
    });
    expect(execution.code).toBe("ARTIFACT_RANGE_UNSUPPORTED");
  });

  it("fails closed for unsupported binary media and PNG bytes with the wrong manifest media type", async () => {
    const unsupported = fixture(Uint8Array.from([0, 1, 2, 3]), {
      media_type: "application/octet-stream",
    });
    expect(
      (await executeArtifactRead(unsupported.config, { artifact: unsupported.ref.artifact_id }))
        .code
    ).toBe("ARTIFACT_MEDIA_UNSUPPORTED");

    const pngBytes = encodeCanonicalPng({
      width: 1,
      height: 1,
      rgba: Uint8Array.from([0, 0, 0, 255]),
    });
    const wrongMedia = fixture(pngBytes, { media_type: "application/octet-stream" });
    expect(
      (await executeArtifactRead(wrongMedia.config, { artifact: wrongMedia.ref.artifact_id })).code
    ).toBe("ARTIFACT_MEDIA_UNSUPPORTED");
  });

  it("rejects malformed, noncanonical, and over-limit PNG artifacts", async () => {
    const malformed = fixture(Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]), {
      media_type: "image/png",
    });
    expect(
      (await executeArtifactRead(malformed.config, { artifact: malformed.ref.artifact_id })).code
    ).toBe("ARTIFACT_IMAGE_INVALID");

    const canonical = Buffer.from(
      encodeCanonicalPng({
        width: 2,
        height: 1,
        rgba: Uint8Array.from([0, 0, 0, 255, 255, 255, 255, 255]),
      })
    );
    const noncanonical = Buffer.from(canonical);
    // Replace the first scanline filter requires re-compression, so a harmless second IDAT is a
    // simpler structurally valid but deliberately noncanonical artifact fixture.
    const iendOffset = noncanonical.length - 12;
    const emptyIdat = Buffer.from([0, 0, 0, 0, 73, 68, 65, 84, 53, 175, 6, 30]);
    const twoIdat = Buffer.concat([
      noncanonical.subarray(0, iendOffset),
      emptyIdat,
      noncanonical.subarray(iendOffset),
    ]);
    const noncanonicalItem = fixture(twoIdat, { media_type: "image/png" });
    expect(
      (
        await executeArtifactRead(noncanonicalItem.config, {
          artifact: noncanonicalItem.ref.artifact_id,
        })
      ).code
    ).toBe("ARTIFACT_IMAGE_NOT_CANONICAL");

    const overLimit = fixture(canonical, { media_type: "image/png" });
    const execution = await executeArtifactRead(
      { ...overLimit.config, pngLimits: { ...overLimit.config.pngLimits, maxPixels: 1 } },
      { artifact: overLimit.ref.artifact_id }
    );
    expect(execution.code).toBe("ARTIFACT_IMAGE_LIMIT_EXCEEDED");
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

  it("reports database corruption separately from configuration and missing IDs", async () => {
    const item = fixture();
    // All fixture connections have closed; never raw-open a live SQLite file.
    writeFileSync(join(item.root, "manifest.db"), "not a SQLite database", { mode: 0o600 });
    const execution = await executeArtifactRead(item.config, { artifact: item.ref.artifact_id });
    expect(execution.code).toBe("ARTIFACT_STORE_CORRUPT");
  });

  it("reports persisted row/ref mismatch as corruption rather than configuration", async () => {
    const item = fixture();
    const sqlite = process.getBuiltinModule("node:sqlite");
    if (sqlite === undefined) throw new Error("node:sqlite unavailable");
    {
      using db = new sqlite.DatabaseSync(join(item.root, "manifest.db"));
      const trigger = db
        .prepare("SELECT sql FROM sqlite_schema WHERE name='artifacts_no_update'")
        .get();
      if (typeof trigger?.sql !== "string") throw new Error("Missing fixture trigger");
      db.exec("DROP TRIGGER artifacts_no_update");
      db.prepare("UPDATE artifacts SET ref_json=? WHERE artifact_id=?").run(
        JSON.stringify({ ...item.ref, producer: "agent:tampered" }),
        item.ref.artifact_id
      );
      db.exec(trigger.sql);
    }
    const execution = await executeArtifactRead(item.config, { artifact: item.ref.artifact_id });
    expect(execution.code).toBe("ARTIFACT_STORE_CORRUPT");
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
