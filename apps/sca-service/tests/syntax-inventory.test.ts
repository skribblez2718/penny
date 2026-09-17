import { describe, expect, it } from "vitest";

import {
  ScaSyntaxInventoryError,
  buildScaSyntaxInventoryV1,
  validateScaSyntaxInventoryResultV1,
} from "../src/adapters/syntax-inventory.js";

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const DIGEST_C = "c".repeat(64);
const DIGEST_D = "d".repeat(64);

function availableInput() {
  return {
    schema_id: "penny.sca-syntax-inventory-input.v1",
    schema_version: 1,
    source_snapshot_sha256: DIGEST_A,
    tool: {
      name: "penny-tree-sitter-indexer",
      version: "web-tree-sitter/0.27.0",
      implementation_sha256: DIGEST_B,
      grammar_bundle_sha256: DIGEST_C,
      state: "available",
      unavailable_reason: null,
    },
    expected_files: 3,
    files: [
      {
        path: "web/client.tsx",
        source_sha256: DIGEST_D,
        language: "tsx",
        status: "parsed",
        named_nodes: 15,
        error_nodes: 0,
        max_depth: 6,
        truncated: false,
        diagnostics: [],
      },
      {
        path: "src/plugin.php",
        source_sha256: DIGEST_B,
        language: "php",
        status: "parse_gap",
        named_nodes: 11,
        error_nodes: 1,
        max_depth: 5,
        truncated: false,
        diagnostics: [{ code: "parse_error", message: "unexpected token", line: 4, column: 7 }],
      },
      {
        path: "web/large.js",
        source_sha256: DIGEST_C,
        language: "javascript",
        status: "limit_exceeded",
        named_nodes: 100,
        error_nodes: 0,
        max_depth: 8,
        truncated: true,
        diagnostics: [
          { code: "node_limit", message: "named node limit reached", line: null, column: null },
        ],
      },
    ],
  };
}

function expectInventoryError(run: () => unknown, code: ScaSyntaxInventoryError["code"]): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ScaSyntaxInventoryError);
    if (error instanceof ScaSyntaxInventoryError) expect(error.code).toBe(code);
    return;
  }
  throw new Error(`expected syntax inventory error '${code}'`);
}

describe("S-04-T1 syntax inventory normalization", () => {
  it("retains exact tool/source provenance, parse gaps, limits, and deterministic ordering", () => {
    const input = availableInput();
    const before = JSON.stringify(input);
    const result = buildScaSyntaxInventoryV1(input);

    expect(JSON.stringify(input)).toBe(before);
    expect(result.status).toBe("partial");
    expect(result.files.map((file) => file.path)).toEqual([
      "src/plugin.php",
      "web/client.tsx",
      "web/large.js",
    ]);
    expect(result.counts).toEqual({
      expected: 3,
      observed: 3,
      parsed: 1,
      parse_gap: 1,
      unsupported: 0,
      limit_exceeded: 1,
      failed: 0,
      truncated: 1,
      named_nodes: 126,
      error_nodes: 1,
    });
    expect(validateScaSyntaxInventoryResultV1(result)).toEqual(result);
  });

  it("classifies a complete clean index as succeeded", () => {
    const input = availableInput();
    const files = input.files.map((file) => ({
      ...file,
      status: "parsed",
      error_nodes: 0,
      truncated: false,
      diagnostics: [],
    }));
    const result = buildScaSyntaxInventoryV1({ ...input, files });
    expect(result.status).toBe("succeeded");
    expect(result.counts.parsed).toBe(3);
  });

  it("returns typed unavailable for missing, unsupported, or incompatible tooling", () => {
    for (const unavailable_reason of [
      "missing_runtime",
      "unsupported_tool",
      "incompatible_version",
    ]) {
      const result = buildScaSyntaxInventoryV1({
        schema_id: "penny.sca-syntax-inventory-input.v1",
        schema_version: 1,
        source_snapshot_sha256: DIGEST_A,
        tool: {
          name:
            unavailable_reason === "unsupported_tool"
              ? "other-indexer"
              : "penny-tree-sitter-indexer",
          version: null,
          implementation_sha256: null,
          grammar_bundle_sha256: null,
          state: "unavailable",
          unavailable_reason,
        },
        expected_files: 2,
        files: [],
      });
      expect(result.status).toBe("unavailable");
      expect(result.tool.unavailable_reason).toBe(unavailable_reason);
    }
  });

  it("retains an all-unsupported language result instead of treating it as clean", () => {
    const input = availableInput();
    const files = input.files.map((file) => ({
      ...file,
      status: "unsupported",
      named_nodes: 0,
      error_nodes: 0,
      truncated: false,
      diagnostics: [],
    }));
    expect(buildScaSyntaxInventoryV1({ ...input, files }).status).toBe("unsupported");
  });

  it("rejects unknown fields, inconsistent tool state, collisions, and unexplained gaps", () => {
    const input = availableInput();
    expectInventoryError(
      () => buildScaSyntaxInventoryV1({ ...input, unexpected: true }),
      "invalid_input"
    );
    expectInventoryError(
      () =>
        buildScaSyntaxInventoryV1({
          ...input,
          tool: { ...input.tool, implementation_sha256: null },
        }),
      "invalid_tool_state"
    );
    expectInventoryError(
      () =>
        buildScaSyntaxInventoryV1({
          ...input,
          files: [
            { ...input.files[0], path: "SRC/File.tsx" },
            { ...input.files[1], path: "src/file.tsx" },
          ],
        }),
      "path_collision"
    );
    expectInventoryError(
      () =>
        buildScaSyntaxInventoryV1({
          ...input,
          files: [{ ...input.files[1], diagnostics: [] }],
          expected_files: 1,
        }),
      "summary_mismatch"
    );
  });

  it("rejects a result whose canonical digest was changed", () => {
    const result = buildScaSyntaxInventoryV1(availableInput());
    expectInventoryError(
      () => validateScaSyntaxInventoryResultV1({ ...result, inventory_sha256: DIGEST_A }),
      "invalid_input"
    );
  });
});
