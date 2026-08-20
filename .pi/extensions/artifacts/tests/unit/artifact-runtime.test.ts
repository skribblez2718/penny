import { access, chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  artifactRefFromEnvelope,
  canonicalArtifactId,
  executeArtifactRead,
  loadArtifactRuntimeConfig,
  parseArtifactInvocation,
  resolveArtifactObjectPath,
} from "../../artifact-runtime.js";
import type { ArtifactRef, ArtifactRuntimeConfig } from "../../types.js";
import { fitsToolResultBudget, measureToolResult } from "../../../lib/tool-result-budget.js";
import {
  CURSOR_KEY_HEX,
  FIXED_NOW,
  createArtifactFixture,
  createCanonicalRef,
  parseToolPayload,
  type ArtifactFixture,
} from "../fixtures.js";

const fixtures: ArtifactFixture[] = [];

async function fixture(
  value: string | Buffer,
  options?: Parameters<typeof createArtifactFixture>[1]
): Promise<ArtifactFixture> {
  const created = await createArtifactFixture(value, options);
  fixtures.push(created);
  return created;
}

function errorCode(payload: Record<string, unknown>): string {
  return (payload.error as Record<string, unknown>).code as string;
}

function continuationCursor(payload: Record<string, unknown>): string {
  return (payload.continuation as Record<string, unknown>).cursor as string;
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((item) => item.cleanup()));
});

describe("artifact runtime", () => {
  it("reads one exact granted artifact by ID and immutable ref", async () => {
    const item = await fixture("exact artifact content");

    for (const artifact of [item.artifact.artifact_id, artifactRefFromEnvelope(item.artifact)]) {
      const execution = await executeArtifactRead(
        item.config,
        { artifact },
        { now: () => FIXED_NOW }
      );
      const payload = parseToolPayload(execution.result);
      expect(execution.code).toBe("OK");
      expect(payload.content).toBe("exact artifact content");
      expect(payload.total_bytes).toBe(item.content.length);
      expect(payload.returned_range).toEqual({ start: 0, end: item.content.length });
      expect(payload.content_digest).toBe(item.artifact.content_digest);
      expect(payload.artifact_ref).toEqual(artifactRefFromEnvelope(item.artifact));
      expect(payload.truncated).toBe(false);
      expect(fitsToolResultBudget(measureToolResult(execution.result), item.config.budget)).toBe(
        true
      );
    }
  });

  it("resolves the canonical artifact URI to the sharded objects/sha256 path", async () => {
    const item = await fixture("canonical object path");

    expect(resolveArtifactObjectPath(item.root, item.artifact.store_ref)).toBe(item.objectPath);
    const execution = await executeArtifactRead(
      item.config,
      { artifact: item.artifact.artifact_id },
      { now: () => FIXED_NOW }
    );
    expect(execution.code).toBe("OK");
  });

  it("validates explicit UTF-8 byte boundaries", async () => {
    const item = await fixture("A🙂漢B");
    const valid = await executeArtifactRead(
      item.config,
      { artifact: item.artifact.artifact_id, range: { start: 1, end: 8 } },
      { now: () => FIXED_NOW }
    );
    expect(parseToolPayload(valid.result).content).toBe("🙂漢");
    expect(parseToolPayload(valid.result).returned_range).toEqual({ start: 1, end: 8 });

    const invalid = await executeArtifactRead(
      item.config,
      { artifact: item.artifact.artifact_id, range: { start: 2, end: 8 } },
      { now: () => FIXED_NOW }
    );
    expect(errorCode(parseToolPayload(invalid.result))).toBe("ARTIFACT_RANGE_INVALID");
  });

  it("continues multibyte content within final-envelope caps and reassembles exactly", async () => {
    const item = await fixture("🙂漢字é/".repeat(1_000), {
      env: {
        PENNY_TOOL_RESULT_MAX_BYTES: "4096",
        PENNY_TOOL_RESULT_MAX_CHARACTERS: "4096",
        PENNY_TOOL_RESULT_MAX_TOKENS: "4096",
      },
    });
    const returned: Buffer[] = [];
    let cursor: string | undefined;
    let expectedStart = 0;
    let pages = 0;

    do {
      const execution = await executeArtifactRead(
        item.config,
        {
          artifact: item.artifact.artifact_id,
          ...(cursor ? { cursor } : {}),
        },
        { now: () => FIXED_NOW }
      );
      const payload = parseToolPayload(execution.result);
      expect(execution.code).toBe("OK");
      expect(fitsToolResultBudget(measureToolResult(execution.result), item.config.budget)).toBe(
        true
      );
      const range = payload.returned_range as { start: number; end: number };
      expect(range.start).toBe(expectedStart);
      const pageBytes = Buffer.from(payload.content as string, "utf8");
      expect(pageBytes.equals(item.content.subarray(range.start, range.end))).toBe(true);
      returned.push(pageBytes);
      expectedStart = range.end;
      cursor = payload.truncated ? continuationCursor(payload) : undefined;
      pages += 1;
      expect(pages).toBeLessThan(100);
    } while (cursor);

    expect(pages).toBeGreaterThan(1);
    expect(Buffer.concat(returned).equals(item.content)).toBe(true);
  });

  it.each([
    ["wrong run", { artifactRunId: "run:other", callerRunId: "run:test" }, "ARTIFACT_WRONG_RUN"],
    [
      "wrong consumer",
      { callerConsumer: "worker:caller", consumerScope: ["worker:other"] },
      "ARTIFACT_WRONG_CONSUMER",
    ],
    ["stale grant", { expiresAt: "2026-08-15T11:59:59.000Z" }, "ARTIFACT_STALE"],
  ])("returns a typed %s failure", async (_name, options, expected) => {
    const item = await fixture("protected", options);
    const execution = await executeArtifactRead(
      item.config,
      { artifact: item.artifact.artifact_id },
      { now: () => FIXED_NOW }
    );
    expect(errorCode(parseToolPayload(execution.result))).toBe(expected);
  });

  it("returns typed stale, missing, digest, and encoding failures", async () => {
    const stale = await fixture("stale");
    const staleResult = await executeArtifactRead(
      stale.config,
      {
        artifact: {
          ...artifactRefFromEnvelope(stale.artifact),
          content_digest: "b".repeat(64),
          store_ref: `artifact://sha256/${"b".repeat(64)}`,
        },
      },
      { now: () => FIXED_NOW }
    );
    expect(errorCode(parseToolPayload(staleResult.result))).toBe("ARTIFACT_STALE");

    const missing = await fixture("missing", { createObject: false });
    const missingResult = await executeArtifactRead(
      missing.config,
      { artifact: missing.artifact.artifact_id },
      { now: () => FIXED_NOW }
    );
    expect(errorCode(parseToolPayload(missingResult.result))).toBe("ARTIFACT_MISSING");

    const digest = await fixture("digest", { objectContent: Buffer.from("xxxxxx") });
    const digestResult = await executeArtifactRead(
      digest.config,
      { artifact: digest.artifact.artifact_id },
      { now: () => FIXED_NOW }
    );
    expect(errorCode(parseToolPayload(digestResult.result))).toBe("ARTIFACT_DIGEST_MISMATCH");

    const invalidUtf8 = Buffer.from([0xff, 0xfe]);
    const encoding = await fixture(invalidUtf8);
    const encodingResult = await executeArtifactRead(
      encoding.config,
      { artifact: encoding.artifact.artifact_id },
      { now: () => FIXED_NOW }
    );
    expect(errorCode(parseToolPayload(encodingResult.result))).toBe("ARTIFACT_ENCODING_INVALID");
  });

  it("does not enumerate or reveal whether ungranted artifact IDs exist", async () => {
    const item = await fixture("granted");
    const first = await executeArtifactRead(
      item.config,
      { artifact: `art_${"b".repeat(64)}` },
      { now: () => FIXED_NOW }
    );
    const second = await executeArtifactRead(
      item.config,
      { artifact: `art_${"c".repeat(64)}` },
      { now: () => FIXED_NOW }
    );
    expect(parseToolPayload(first.result)).toEqual(parseToolPayload(second.result));
    expect(errorCode(parseToolPayload(first.result))).toBe("ARTIFACT_NOT_GRANTED");

    const noGrantConfig: ArtifactRuntimeConfig = {
      ...item.config,
      invocationJson: JSON.stringify({ ...item.invocation, grants: [] }),
    };
    const noGrant = await executeArtifactRead(
      noGrantConfig,
      { artifact: item.artifact.artifact_id },
      { now: () => FIXED_NOW }
    );
    expect(errorCode(parseToolPayload(noGrant.result))).toBe("ARTIFACT_NOT_GRANTED");
  });

  it("rejects cursor tampering, expiry, query rebinding, and caller rebinding", async () => {
    const item = await fixture("cursor payload ".repeat(1_000), {
      consumerScope: ["worker:consumer", "worker:second"],
      env: {
        PENNY_TOOL_RESULT_MAX_BYTES: "4096",
        PENNY_TOOL_RESULT_MAX_CHARACTERS: "4096",
        PENNY_TOOL_RESULT_MAX_TOKENS: "4096",
        PENNY_ARTIFACT_CURSOR_TTL_SECONDS: "30",
      },
    });
    const first = await executeArtifactRead(
      item.config,
      { artifact: item.artifact.artifact_id },
      { now: () => FIXED_NOW }
    );
    const cursor = continuationCursor(parseToolPayload(first.result));

    const tampered = `${cursor.slice(0, -1)}${cursor.endsWith("A") ? "B" : "A"}`;
    const tamperedResult = await executeArtifactRead(
      item.config,
      { artifact: item.artifact.artifact_id, cursor: tampered },
      { now: () => FIXED_NOW }
    );
    expect(errorCode(parseToolPayload(tamperedResult.result))).toBe("ARTIFACT_CURSOR_INVALID");

    const expiredResult = await executeArtifactRead(
      item.config,
      { artifact: item.artifact.artifact_id, cursor },
      { now: () => FIXED_NOW + 30_001 }
    );
    expect(errorCode(parseToolPayload(expiredResult.result))).toBe("ARTIFACT_CURSOR_EXPIRED");

    const refBound = await executeArtifactRead(
      item.config,
      {
        artifact: artifactRefFromEnvelope(item.artifact),
        cursor,
      },
      { now: () => FIXED_NOW }
    );
    expect(errorCode(parseToolPayload(refBound.result))).toBe("ARTIFACT_CURSOR_INVALID");

    const changedConsumerInvocation = structuredClone(item.invocation);
    changedConsumerInvocation.caller.consumer_ref = "worker:second";
    const changedConsumerConfig: ArtifactRuntimeConfig = {
      ...item.config,
      invocationJson: JSON.stringify(changedConsumerInvocation),
    };
    const consumerRebound = await executeArtifactRead(
      changedConsumerConfig,
      { artifact: item.artifact.artifact_id, cursor },
      { now: () => FIXED_NOW }
    );
    expect(errorCode(parseToolPayload(consumerRebound.result))).toBe("ARTIFACT_WRONG_CONSUMER");

    const changedRunInvocation = structuredClone(item.invocation);
    changedRunInvocation.caller.run_id = "run:second";
    const changedRunConfig: ArtifactRuntimeConfig = {
      ...item.config,
      invocationJson: JSON.stringify(changedRunInvocation),
    };
    const runRebound = await executeArtifactRead(
      changedRunConfig,
      { artifact: item.artifact.artifact_id, cursor },
      { now: () => FIXED_NOW }
    );
    expect(errorCode(parseToolPayload(runRebound.result))).toBe("ARTIFACT_WRONG_RUN");
  });

  it("binds cursors to the immutable source revision", async () => {
    const item = await fixture("revision ".repeat(2_000), {
      env: {
        PENNY_TOOL_RESULT_MAX_BYTES: "4096",
        PENNY_TOOL_RESULT_MAX_CHARACTERS: "4096",
        PENNY_TOOL_RESULT_MAX_TOKENS: "4096",
      },
    });
    const first = await executeArtifactRead(
      item.config,
      { artifact: item.artifact.artifact_id },
      { now: () => FIXED_NOW }
    );
    const cursor = continuationCursor(parseToolPayload(first.result));
    const changedInvocation = structuredClone(item.invocation);
    changedInvocation.grants[0]!.artifact.content_digest = "b".repeat(64);
    changedInvocation.grants[0]!.artifact.store_ref = `artifact://sha256/${"b".repeat(64)}`;
    const changedConfig: ArtifactRuntimeConfig = {
      ...item.config,
      invocationJson: JSON.stringify(changedInvocation),
    };
    const result = await executeArtifactRead(
      changedConfig,
      { artifact: item.artifact.artifact_id, cursor },
      { now: () => FIXED_NOW }
    );
    expect(errorCode(parseToolPayload(result.result))).toBe("ARTIFACT_STALE");
  });

  it("creates an owner-only protected materialization over one MiB when configured", async () => {
    const item = await fixture(Buffer.alloc(1_048_577, 0x61), {
      env: { PENNY_ARTIFACT_MATERIALIZATION_ENABLED: "true" },
    });
    const materializationDirectory = join(item.root, "materialized");
    await mkdir(materializationDirectory, { mode: 0o700 });
    const expiredPath = join(
      materializationDirectory,
      `${FIXED_NOW - 1}-${"a".repeat(32)}.artifact`
    );
    await writeFile(expiredPath, "expired", { mode: 0o600 });

    const execution = await executeArtifactRead(
      item.config,
      { artifact: item.artifact.artifact_id },
      { now: () => FIXED_NOW }
    );
    const payload = parseToolPayload(execution.result);
    const materialization = payload.materialization as Record<string, unknown>;
    const path = fileURLToPath(materialization.ref as string);

    expect(payload.type).toBe("artifact_materialization");
    expect(payload.artifact_ref).toEqual(artifactRefFromEnvelope(item.artifact));
    expect(payload.content).toBeUndefined();
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await readFile(path)).equals(item.content)).toBe(true);
    expect(path.startsWith(item.root)).toBe(true);
    expect(materialization.content_digest).toBe(item.artifact.content_digest);
    expect(fitsToolResultBudget(measureToolResult(execution.result), item.config.budget)).toBe(
      true
    );
    await expect(access(expiredPath)).rejects.toThrow();
  });

  it("emits metadata-only telemetry without content, cursors, or grant material", async () => {
    const secretContent = "CONTENT-MUST-NOT-ENTER-TELEMETRY-7f62";
    const item = await fixture(secretContent.repeat(500), {
      env: {
        PENNY_TOOL_RESULT_MAX_BYTES: "4096",
        PENNY_TOOL_RESULT_MAX_CHARACTERS: "4096",
        PENNY_TOOL_RESULT_MAX_TOKENS: "4096",
      },
    });
    const events: Array<{ event: string; context: Record<string, unknown> }> = [];
    const execution = await executeArtifactRead(
      item.config,
      { artifact: item.artifact.artifact_id },
      {
        now: () => FIXED_NOW,
        telemetry: {
          info: (event, context) => events.push({ event, context }),
          warn: (event, context) => events.push({ event, context }),
        },
      }
    );
    const cursor = continuationCursor(parseToolPayload(execution.result));
    const serialized = JSON.stringify(events);

    expect(serialized).not.toContain(secretContent);
    expect(serialized).not.toContain(cursor);
    expect(serialized).not.toContain(CURSOR_KEY_HEX);
    expect(serialized).not.toContain("consumer_scope");
    expect(events[0]!.context).toHaveProperty("serializedBytes");
    expect(events[0]!.context.compactionCorrelation).toEqual({
      status: "not_evaluated",
      keys: ["run:run:test"],
    });
    expect(
      (events[0]!.context.releaseHeadroom as { invariantPreserved: boolean }).invariantPreserved
    ).toBe(true);
  });
});

describe("trusted configuration contract", () => {
  it("rejects malformed or extra invocation fields", () => {
    expect(() =>
      parseArtifactInvocation('{"schema_version":1,"caller":{},"grants":[],"extra":true}')
    ).toThrow();
  });

  it("matches the canonical identity and accepts exact ArtifactRef grants", () => {
    expect(
      canonicalArtifactId({
        run_id: "run-1",
        phase: "observing",
        branch_id: null,
        kind: "agent-output",
        operation_id: "observe-1",
        version: 1,
      })
    ).toBe("art_aecc9e8a5d7e711c58ae2dda9d5b7a8673ba77bc93414d65f48ad17c8d85e927");

    const ref = createCanonicalRef({
      run_id: "run-1",
      phase: "implementation",
      branch_id: "branch-a",
      kind: "agent-output",
      operation_id: "produce-v2",
      version: 2,
      consumer_scope: ["worker:consumer"],
    });
    const invocation = {
      schema_version: 1,
      caller: {
        run_id: "run-1",
        consumer_ref: "worker:consumer",
        invocation_id: "invocation-1",
      },
      grants: [{ artifact: ref, expires_at: "2026-08-15T13:00:00.000000Z" }],
    };

    expect(parseArtifactInvocation(JSON.stringify(invocation)).grants[0]!.artifact).toEqual(ref);
    expect(() =>
      parseArtifactInvocation(
        JSON.stringify({
          ...invocation,
          grants: [
            {
              artifact: {
                ...ref,
                created_at: "2026-08-15T12:00:00.000000Z",
                parent_ref: null,
                upstream_refs: [],
              },
              expires_at: invocation.grants[0]!.expires_at,
            },
          ],
        })
      )
    ).toThrow();
  });

  it("rejects every noncanonical ArtifactRef grant shape", async () => {
    const item = await fixture("strict invocation");
    const base = item.invocation;
    const withArtifact = (artifact: unknown) => ({
      ...base,
      grants: [{ artifact, expires_at: base.grants[0]!.expires_at }],
    });
    const ref = base.grants[0]!.artifact;
    const missingBranch = { ...ref } as Partial<ArtifactRef>;
    delete missingBranch.branch_id;
    const wrongIdentity = { ...ref, artifact_id: `art_${"f".repeat(64)}` };
    const stringVersion = { ...ref, version: "1" };
    const relativeStoreRef = {
      ...ref,
      store_ref: `objects/sha256/${ref.content_digest.slice(0, 2)}/${ref.content_digest.slice(2)}`,
    };
    const unsortedScope = {
      ...ref,
      consumer_scope: ["worker:z", "worker:a"],
    };
    const extraRefField: ArtifactRef & { unexpected: boolean } = {
      ...ref,
      unexpected: true,
    };

    for (const invalid of [
      missingBranch,
      wrongIdentity,
      stringVersion,
      relativeStoreRef,
      unsortedScope,
      extraRefField,
    ]) {
      expect(() => parseArtifactInvocation(JSON.stringify(withArtifact(invalid)))).toThrow();
    }
  });

  it("accepts only an owner-only invocation file", async () => {
    const item = await fixture("invocation file");
    const invocationPath = join(item.root, "invocation.json");
    await writeFile(invocationPath, JSON.stringify(item.invocation), { mode: 0o644 });
    const fileConfig: ArtifactRuntimeConfig = {
      ...item.config,
      invocationJson: undefined,
      invocationFile: invocationPath,
    };

    const rejected = await executeArtifactRead(
      fileConfig,
      { artifact: item.artifact.artifact_id },
      { now: () => FIXED_NOW }
    );
    expect(errorCode(parseToolPayload(rejected.result))).toBe("ARTIFACT_CONFIG_INVALID");

    await chmod(invocationPath, 0o600);
    const accepted = await executeArtifactRead(
      fileConfig,
      { artifact: item.artifact.artifact_id },
      { now: () => FIXED_NOW }
    );
    expect(accepted.code).toBe("OK");
  });

  it("keeps the hard 32768-byte and 8192-token final-envelope budget", () => {
    const config = loadArtifactRuntimeConfig({
      PENNY_ARTIFACT_ROOT: "/tmp/example",
      PENNY_ARTIFACT_INVOCATION_JSON: "{}",
      PENNY_ARTIFACT_CURSOR_HMAC_KEY: CURSOR_KEY_HEX,
    });

    expect(config.budget).toEqual({
      maxBytes: 32_768,
      maxCharacters: 32_768,
      maxEstimatedTokens: 8_192,
    });
  });

  it("rejects two invocation sources and a weak cursor key", () => {
    expect(() =>
      loadArtifactRuntimeConfig({
        PENNY_ARTIFACT_ROOT: "/tmp/example",
        PENNY_ARTIFACT_INVOCATION_JSON: "{}",
        PENNY_ARTIFACT_INVOCATION_FILE: "/tmp/example/invocation.json",
        PENNY_ARTIFACT_CURSOR_HMAC_KEY: CURSOR_KEY_HEX,
      })
    ).toThrow();
    expect(() =>
      loadArtifactRuntimeConfig({
        PENNY_ARTIFACT_ROOT: "/tmp/example",
        PENNY_ARTIFACT_INVOCATION_JSON: "{}",
        PENNY_ARTIFACT_CURSOR_HMAC_KEY: "short",
      })
    ).toThrow();
  });

  it("generates a per-process cursor key only when the owner supplies none", () => {
    const generated = loadArtifactRuntimeConfig({
      PENNY_ARTIFACT_ROOT: "/tmp/example",
      PENNY_ARTIFACT_INVOCATION_JSON: "{}",
    });
    expect(generated.cursorKey.length).toBeGreaterThanOrEqual(32);

    const supplied = loadArtifactRuntimeConfig({
      PENNY_ARTIFACT_ROOT: "/tmp/example",
      PENNY_ARTIFACT_INVOCATION_JSON: "{}",
      PENNY_ARTIFACT_CURSOR_HMAC_KEY: CURSOR_KEY_HEX,
    });
    expect(supplied.cursorKey.toString("hex")).toBe(CURSOR_KEY_HEX);
  });

  it("fails closed when no invocation source and no owner resolver exist", async () => {
    const config = loadArtifactRuntimeConfig({
      PENNY_ARTIFACT_ROOT: "/tmp/example",
      PENNY_ARTIFACT_CURSOR_HMAC_KEY: CURSOR_KEY_HEX,
    });
    const execution = await executeArtifactRead(
      config,
      { artifact: `art_${"a".repeat(64)}` },
      { now: () => FIXED_NOW }
    );
    expect(execution.code).toBe("ARTIFACT_CONFIG_INVALID");
  });
});
