import { describe, expect, it } from "vitest";

import {
  ScaSourceCensusError,
  buildScaSourceCensusV1,
  validateScaSourceCensusResultV1,
} from "../src/adapters/source-census.js";

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const DIGEST_C = "c".repeat(64);
const DIGEST_D = "d".repeat(64);

function censusInput() {
  return {
    schema_id: "penny.sca-source-census-input.v1",
    schema_version: 1,
    source_snapshot_sha256: DIGEST_A,
    tool: {
      name: "penny-source-census",
      version: "1.0.0",
      implementation_sha256: DIGEST_B,
    },
    files: [
      {
        path: "web/client.tsx",
        byte_length: 30,
        sha256: DIGEST_C,
        content_kind: "text",
        generated: false,
      },
      {
        path: "composer.lock",
        byte_length: 20,
        sha256: DIGEST_D,
        content_kind: "text",
        generated: true,
      },
      {
        path: "assets/logo.bin",
        byte_length: 10,
        sha256: DIGEST_B,
        content_kind: "binary",
        generated: false,
      },
      {
        path: "src/plugin.php",
        byte_length: 40,
        sha256: DIGEST_A,
        content_kind: "text",
        generated: false,
      },
      {
        path: "web/runtime.js",
        byte_length: 50,
        sha256: DIGEST_D,
        content_kind: "text",
        generated: false,
      },
    ],
    limits: { max_files: 10, max_total_bytes: 1_000 },
  };
}

function expectCensusError(run: () => unknown, code: ScaSourceCensusError["code"]): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ScaSourceCensusError);
    if (error instanceof ScaSourceCensusError) expect(error.code).toBe(code);
    return;
  }
  throw new Error(`expected source census error '${code}'`);
}

describe("S-04-T1 deterministic source census", () => {
  it("sorts entries and records exact PHP, JavaScript, TypeScript, binary, and generated counts", () => {
    const input = censusInput();
    const before = JSON.stringify(input);
    const result = buildScaSourceCensusV1(input);

    expect(JSON.stringify(input)).toBe(before);
    expect(result.entries.map((entry) => entry.path)).toEqual([
      "assets/logo.bin",
      "composer.lock",
      "src/plugin.php",
      "web/client.tsx",
      "web/runtime.js",
    ]);
    expect(result.counts).toEqual({
      files: 5,
      bytes: 150,
      text: 4,
      binary: 1,
      generated: 1,
      php: 2,
      javascript: 1,
      typescript: 1,
      other: 1,
    });
    expect(validateScaSourceCensusResultV1(result)).toEqual(result);
  });

  it("is deterministic across declaration order", () => {
    const input = censusInput();
    const reversed = { ...input, files: [...input.files].reverse() };
    expect(buildScaSourceCensusV1(reversed)).toEqual(buildScaSourceCensusV1(input));
  });

  it("rejects unknown fields, unsafe paths, folded collisions, and quotas", () => {
    const input = censusInput();
    expectCensusError(
      () => buildScaSourceCensusV1({ ...input, unexpected: true }),
      "invalid_input"
    );
    expectCensusError(
      () =>
        buildScaSourceCensusV1({
          ...input,
          files: [{ ...input.files[0], path: "../escape.ts" }],
        }),
      "unsafe_path"
    );
    expectCensusError(
      () =>
        buildScaSourceCensusV1({
          ...input,
          files: [
            { ...input.files[0], path: "SRC/File.ts" },
            { ...input.files[1], path: "src/file.ts" },
          ],
        }),
      "path_collision"
    );
    expectCensusError(
      () => buildScaSourceCensusV1({ ...input, limits: { ...input.limits, max_files: 1 } }),
      "quota_exceeded"
    );
    expectCensusError(
      () =>
        buildScaSourceCensusV1({
          ...input,
          limits: { ...input.limits, max_total_bytes: 1 },
        }),
      "quota_exceeded"
    );
  });

  it("rejects a result whose canonical digest was changed", () => {
    const result = buildScaSourceCensusV1(censusInput());
    expectCensusError(
      () => validateScaSourceCensusResultV1({ ...result, census_sha256: DIGEST_A }),
      "invalid_input"
    );
  });
});
