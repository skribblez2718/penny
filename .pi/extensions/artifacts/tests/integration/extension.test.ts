import { afterEach, describe, expect, it, vi } from "vitest";

import artifactExtension from "../../index.js";
import { artifactRefFromEnvelope } from "../../artifact-runtime.js";
import {
  HARD_MAX_ESTIMATED_TOKENS,
  HARD_MAX_RESULT_BYTES,
  HARD_MAX_RESULT_CHARACTERS,
  RELEASE_MINIMUM_CONTEXT_HEADROOM_TOKENS,
  fitsToolResultBudget,
  measureToolResult,
  resolveToolResultBudget,
  type TextToolResult,
} from "../../../lib/tool-result-budget.js";
import { CURSOR_KEY_HEX, createArtifactFixture, parseToolPayload } from "../fixtures.js";
import type { ArtifactFixture } from "../fixtures.js";

interface RegisteredTool {
  name: string;
  parameters: {
    properties: Record<string, unknown>;
  };
  execute(toolCallId: string, params: unknown): Promise<TextToolResult>;
}

const fixtures: ArtifactFixture[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(fixtures.splice(0).map((item) => item.cleanup()));
});

describe("artifacts extension integration", () => {
  it("registers only constrained artifact_read and accepts no grant-bearing model fields", async () => {
    const item = await createArtifactFixture("integration artifact", {
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    fixtures.push(item);
    vi.stubEnv("PENNY_ARTIFACT_ROOT", item.root);
    vi.stubEnv("PENNY_ARTIFACT_INVOCATION_JSON", JSON.stringify(item.invocation));
    vi.stubEnv("PENNY_ARTIFACT_INVOCATION_FILE", "");
    vi.stubEnv("PENNY_ARTIFACT_CURSOR_HMAC_KEY", CURSOR_KEY_HEX);

    const tools: RegisteredTool[] = [];
    artifactExtension({
      registerTool(tool: RegisteredTool) {
        tools.push(tool);
      },
    });

    expect(tools.map((tool) => tool.name)).toEqual(["artifact_read"]);
    expect(Object.keys(tools[0]!.parameters.properties).sort()).toEqual([
      "artifact",
      "cursor",
      "range",
    ]);
    expect(tools[0]!.parameters.properties).not.toHaveProperty("grants");
    expect(tools[0]!.parameters.properties).not.toHaveProperty("caller");
    const artifactParameterSchema = JSON.stringify(tools[0]!.parameters.properties.artifact);
    for (const field of [
      "branch_id",
      "operation_id",
      "consumer_scope",
      "media_type",
      "byte_length",
      "store_ref",
    ]) {
      expect(artifactParameterSchema).toContain(field);
    }
    expect(artifactParameterSchema).toContain('"type":"integer"');
    expect(artifactParameterSchema).toContain("^art_[a-f0-9]{64}$");

    const result = await tools[0]!.execute("call-1", {
      artifact: artifactRefFromEnvelope(item.artifact),
    });
    const payload = parseToolPayload(result);
    expect(payload.ok).toBe(true);
    expect(payload.content).toBe("integration artifact");
    expect(payload.artifact_ref).toEqual(artifactRefFromEnvelope(item.artifact));
  });

  it("bounds and exactly reassembles a giant multibyte artifact through registered artifact_read", async () => {
    const content = 'registered-envelope-🙂漢字-"-\\/'.repeat(5_000);
    const item = await createArtifactFixture(content, {
      expiresAt: "2099-01-01T00:00:00.000Z",
      env: {
        PENNY_TOOL_RESULT_MAX_BYTES: String(HARD_MAX_RESULT_BYTES),
        PENNY_TOOL_RESULT_MAX_CHARACTERS: String(HARD_MAX_RESULT_CHARACTERS),
        PENNY_TOOL_RESULT_MAX_TOKENS: String(HARD_MAX_ESTIMATED_TOKENS),
      },
    });
    fixtures.push(item);
    vi.stubEnv("PENNY_ARTIFACT_ROOT", item.root);
    vi.stubEnv("PENNY_ARTIFACT_INVOCATION_JSON", JSON.stringify(item.invocation));
    vi.stubEnv("PENNY_ARTIFACT_INVOCATION_FILE", "");
    vi.stubEnv("PENNY_ARTIFACT_CURSOR_HMAC_KEY", CURSOR_KEY_HEX);
    vi.stubEnv("PENNY_TOOL_RESULT_MAX_BYTES", String(HARD_MAX_RESULT_BYTES));
    vi.stubEnv("PENNY_TOOL_RESULT_MAX_CHARACTERS", String(HARD_MAX_RESULT_CHARACTERS));
    vi.stubEnv("PENNY_TOOL_RESULT_MAX_TOKENS", String(HARD_MAX_ESTIMATED_TOKENS));

    const tools: RegisteredTool[] = [];
    artifactExtension({
      registerTool(tool: RegisteredTool) {
        tools.push(tool);
      },
    });
    const budget = resolveToolResultBudget(process.env);
    const returned: Buffer[] = [];
    let cursor: string | undefined;
    let expectedStart = 0;

    for (let pageNumber = 1; pageNumber <= 256; pageNumber += 1) {
      const result = await tools[0]!.execute(`giant-${pageNumber}`, {
        artifact: item.artifact.artifact_id,
        ...(cursor ? { cursor } : {}),
      });
      const measurement = measureToolResult(result);
      expect(fitsToolResultBudget(measurement, budget)).toBe(true);
      expect(measurement.bytes).toBeLessThanOrEqual(HARD_MAX_RESULT_BYTES);
      expect(measurement.characters).toBeLessThanOrEqual(HARD_MAX_RESULT_CHARACTERS);
      expect(measurement.estimatedTokens).toBeLessThanOrEqual(HARD_MAX_ESTIMATED_TOKENS);
      expect(measurement.estimatedTokens * 2).toBeLessThanOrEqual(
        RELEASE_MINIMUM_CONTEXT_HEADROOM_TOKENS
      );

      const payload = parseToolPayload(result);
      const range = payload.returned_range as { start: number; end: number };
      expect(range.start).toBe(expectedStart);
      const pageBytes = Buffer.from(payload.content as string, "utf8");
      expect(pageBytes.equals(item.content.subarray(range.start, range.end))).toBe(true);
      returned.push(pageBytes);
      expectedStart = range.end;
      if (!payload.truncated) break;
      cursor = (payload.continuation as { cursor: string }).cursor;
    }

    expect(returned.length).toBeGreaterThan(1);
    expect(Buffer.concat(returned).equals(item.content)).toBe(true);
  });

  it("fails closed with a typed configuration error instead of exposing a discovery surface", async () => {
    vi.stubEnv("PENNY_ARTIFACT_INVOCATION_JSON", "");
    vi.stubEnv("PENNY_ARTIFACT_INVOCATION_FILE", "");
    vi.stubEnv("PENNY_ARTIFACT_CURSOR_HMAC_KEY", "");

    const tools: RegisteredTool[] = [];
    artifactExtension({
      registerTool(tool: RegisteredTool) {
        tools.push(tool);
      },
    });
    const result = await tools[0]!.execute("call-2", { artifact: "artifact-unknown" });
    const payload = parseToolPayload(result);

    expect((payload.error as Record<string, unknown>).code).toBe("ARTIFACT_CONFIG_INVALID");
    expect(tools).toHaveLength(1);
  });
});
