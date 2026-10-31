import { Type, type Static } from "typebox";

import { canonicalJson, sha256 } from "../../../orchestration/dist/canonical-json.js";
import { validateContract } from "../../../orchestration/dist/contracts.js";
import { Sha256Schema } from "../../../orchestration/dist/skill-contracts/common.js";

const MAX_FILES = 100_000;
const MAX_PATH_BYTES = 4_096;
const MAX_DIAGNOSTICS_PER_FILE = 64;
const MAX_DIAGNOSTIC_TEXT = 1_024;
const MAX_NODES_PER_FILE = 10_000_000;
const MAX_DEPTH = 10_000;
const MAX_TOOL_TEXT = 256;

export const SCA_SYNTAX_INVENTORY_INPUT_SCHEMA = "penny.sca-syntax-inventory-input.v1";
export const SCA_SYNTAX_INVENTORY_RESULT_SCHEMA = "penny.sca-syntax-inventory-result.v1";
export const SCA_TREE_SITTER_INDEXER_NAME = "penny-tree-sitter-indexer";
export const SCA_SEMGREP_PARSER_NAME = "semgrep-parser";
const SCA_SUPPORTED_SYNTAX_TOOLS = new Set([SCA_TREE_SITTER_INDEXER_NAME, SCA_SEMGREP_PARSER_NAME]);

const ScaSyntaxToolStateV1Schema = Type.Union([
  Type.Literal("available"),
  Type.Literal("unavailable"),
]);

const ScaSyntaxUnavailableReasonV1Schema = Type.Union([
  Type.Literal("missing_runtime"),
  Type.Literal("unsupported_tool"),
  Type.Literal("incompatible_version"),
]);

const ScaSyntaxToolIdentityV1Schema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: MAX_TOOL_TEXT }),
    version: Type.Union([Type.String({ minLength: 1, maxLength: MAX_TOOL_TEXT }), Type.Null()]),
    implementation_sha256: Type.Union([Sha256Schema, Type.Null()]),
    grammar_bundle_sha256: Type.Union([Sha256Schema, Type.Null()]),
    state: ScaSyntaxToolStateV1Schema,
    unavailable_reason: Type.Union([ScaSyntaxUnavailableReasonV1Schema, Type.Null()]),
  },
  { additionalProperties: false }
);

const ScaSyntaxLanguageV1Schema = Type.Union([
  Type.Literal("php"),
  Type.Literal("javascript"),
  Type.Literal("typescript"),
  Type.Literal("tsx"),
]);

const ScaSyntaxFileStatusV1Schema = Type.Union([
  Type.Literal("parsed"),
  Type.Literal("parse_gap"),
  Type.Literal("unsupported"),
  Type.Literal("limit_exceeded"),
  Type.Literal("failed"),
]);

const ScaSyntaxDiagnosticV1Schema = Type.Object(
  {
    code: Type.String({ minLength: 1, maxLength: 128, pattern: "^[a-z][a-z0-9_]*$" }),
    message: Type.String({ minLength: 1, maxLength: MAX_DIAGNOSTIC_TEXT }),
    line: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
    column: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  },
  { additionalProperties: false }
);

const ScaSyntaxFileObservationV1Schema = Type.Object(
  {
    path: Type.String({ minLength: 1, maxLength: MAX_PATH_BYTES }),
    source_sha256: Sha256Schema,
    language: ScaSyntaxLanguageV1Schema,
    status: ScaSyntaxFileStatusV1Schema,
    named_nodes: Type.Integer({ minimum: 0, maximum: MAX_NODES_PER_FILE }),
    error_nodes: Type.Integer({ minimum: 0, maximum: MAX_NODES_PER_FILE }),
    max_depth: Type.Integer({ minimum: 0, maximum: MAX_DEPTH }),
    truncated: Type.Boolean(),
    diagnostics: Type.Array(ScaSyntaxDiagnosticV1Schema, {
      maxItems: MAX_DIAGNOSTICS_PER_FILE,
    }),
  },
  { additionalProperties: false }
);

export const ScaSyntaxInventoryInputV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_SYNTAX_INVENTORY_INPUT_SCHEMA),
    schema_version: Type.Literal(1),
    source_snapshot_sha256: Sha256Schema,
    tool: ScaSyntaxToolIdentityV1Schema,
    expected_files: Type.Integer({ minimum: 0, maximum: MAX_FILES }),
    files: Type.Array(ScaSyntaxFileObservationV1Schema, { maxItems: MAX_FILES }),
  },
  { additionalProperties: false }
);

const ScaSyntaxInventoryStatusV1Schema = Type.Union([
  Type.Literal("succeeded"),
  Type.Literal("partial"),
  Type.Literal("unsupported"),
  Type.Literal("unavailable"),
  Type.Literal("failed"),
]);

export const ScaSyntaxInventoryResultV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_SYNTAX_INVENTORY_RESULT_SCHEMA),
    schema_version: Type.Literal(1),
    source_snapshot_sha256: Sha256Schema,
    tool: ScaSyntaxToolIdentityV1Schema,
    status: ScaSyntaxInventoryStatusV1Schema,
    files: Type.Array(ScaSyntaxFileObservationV1Schema, { maxItems: MAX_FILES }),
    counts: Type.Object(
      {
        expected: Type.Integer({ minimum: 0, maximum: MAX_FILES }),
        observed: Type.Integer({ minimum: 0, maximum: MAX_FILES }),
        parsed: Type.Integer({ minimum: 0, maximum: MAX_FILES }),
        parse_gap: Type.Integer({ minimum: 0, maximum: MAX_FILES }),
        unsupported: Type.Integer({ minimum: 0, maximum: MAX_FILES }),
        limit_exceeded: Type.Integer({ minimum: 0, maximum: MAX_FILES }),
        failed: Type.Integer({ minimum: 0, maximum: MAX_FILES }),
        truncated: Type.Integer({ minimum: 0, maximum: MAX_FILES }),
        named_nodes: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
        error_nodes: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
      },
      { additionalProperties: false }
    ),
    inventory_sha256: Sha256Schema,
  },
  { additionalProperties: false }
);

export type ScaSyntaxInventoryInputV1 = Static<typeof ScaSyntaxInventoryInputV1Schema>;
export type ScaSyntaxInventoryResultV1 = Static<typeof ScaSyntaxInventoryResultV1Schema>;

type ScaSyntaxInventoryUnsignedV1 = Omit<ScaSyntaxInventoryResultV1, "inventory_sha256">;

export class ScaSyntaxInventoryError extends Error {
  constructor(
    readonly code:
      | "invalid_input"
      | "invalid_tool_state"
      | "unsafe_path"
      | "path_collision"
      | "summary_mismatch",
    message: string
  ) {
    super(message);
    this.name = "ScaSyntaxInventoryError";
  }
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function validatePath(candidate: string): void {
  const segments = candidate.split("/");
  if (
    candidate.includes("\\") ||
    candidate.includes("\0") ||
    candidate.startsWith("/") ||
    /^[A-Za-z]:/u.test(candidate) ||
    candidate !== candidate.normalize("NFC") ||
    Buffer.byteLength(candidate, "utf8") > MAX_PATH_BYTES ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new ScaSyntaxInventoryError("unsafe_path", "syntax inventory path is not canonical");
  }
}

function checkedTotal(values: readonly number[], label: string): number {
  let total = 0;
  for (const value of values) {
    total += value;
    if (!Number.isSafeInteger(total)) {
      throw new ScaSyntaxInventoryError("summary_mismatch", `${label} is not a safe integer`);
    }
  }
  return total;
}

function resultStatus(input: ScaSyntaxInventoryInputV1): ScaSyntaxInventoryResultV1["status"] {
  if (input.tool.state === "unavailable") return "unavailable";
  if (input.files.length === 0 && input.expected_files > 0) return "failed";
  if (input.files.length === 0) return "succeeded";
  if (input.files.every((file) => file.status === "unsupported")) return "unsupported";
  if (input.files.every((file) => file.status === "failed")) return "failed";
  if (
    input.files.length !== input.expected_files ||
    input.files.some((file) => file.status !== "parsed" || file.truncated)
  ) {
    return "partial";
  }
  return "succeeded";
}

function digestInventory(value: ScaSyntaxInventoryUnsignedV1): string {
  return sha256(canonicalJson(value));
}

export function buildScaSyntaxInventoryV1(value: unknown): ScaSyntaxInventoryResultV1 {
  let input: ScaSyntaxInventoryInputV1;
  try {
    input = validateContract(ScaSyntaxInventoryInputV1Schema, value, "SCA syntax inventory input");
  } catch (error) {
    throw new ScaSyntaxInventoryError(
      "invalid_input",
      error instanceof Error ? error.message : "syntax inventory input is invalid"
    );
  }

  const expectedAvailable = input.tool.state === "available";
  const completeIdentity =
    SCA_SUPPORTED_SYNTAX_TOOLS.has(input.tool.name) &&
    input.tool.version !== null &&
    input.tool.implementation_sha256 !== null &&
    input.tool.grammar_bundle_sha256 !== null;
  if (
    (expectedAvailable && (!completeIdentity || input.tool.unavailable_reason !== null)) ||
    (!expectedAvailable &&
      (input.tool.unavailable_reason === null ||
        input.tool.version !== null ||
        input.tool.implementation_sha256 !== null ||
        input.tool.grammar_bundle_sha256 !== null ||
        input.files.length !== 0))
  ) {
    throw new ScaSyntaxInventoryError(
      "invalid_tool_state",
      "syntax inventory tool state and identity are inconsistent"
    );
  }

  const exactPaths = new Set<string>();
  const foldedPaths = new Set<string>();
  for (const file of input.files) {
    validatePath(file.path);
    const folded = file.path.normalize("NFKC").toLocaleLowerCase("en-US");
    if (exactPaths.has(file.path) || foldedPaths.has(folded)) {
      throw new ScaSyntaxInventoryError("path_collision", "syntax inventory paths collide");
    }
    exactPaths.add(file.path);
    foldedPaths.add(folded);
    if (file.status === "parsed" && (file.error_nodes !== 0 || file.diagnostics.length !== 0)) {
      throw new ScaSyntaxInventoryError(
        "summary_mismatch",
        "a parsed file cannot contain parse errors or diagnostics"
      );
    }
    if (
      file.status !== "parsed" &&
      file.diagnostics.length === 0 &&
      file.status !== "unsupported"
    ) {
      throw new ScaSyntaxInventoryError(
        "summary_mismatch",
        "a non-parsed file must explain its result"
      );
    }
  }

  const files = [...input.files].sort((left, right) => compareUtf8(left.path, right.path));
  const counts = {
    expected: input.expected_files,
    observed: files.length,
    parsed: files.filter((file) => file.status === "parsed").length,
    parse_gap: files.filter((file) => file.status === "parse_gap").length,
    unsupported: files.filter((file) => file.status === "unsupported").length,
    limit_exceeded: files.filter((file) => file.status === "limit_exceeded").length,
    failed: files.filter((file) => file.status === "failed").length,
    truncated: files.filter((file) => file.truncated).length,
    named_nodes: checkedTotal(
      files.map((file) => file.named_nodes),
      "syntax inventory named-node total"
    ),
    error_nodes: checkedTotal(
      files.map((file) => file.error_nodes),
      "syntax inventory error-node total"
    ),
  };
  const unsigned: ScaSyntaxInventoryUnsignedV1 = {
    schema_id: SCA_SYNTAX_INVENTORY_RESULT_SCHEMA,
    schema_version: 1,
    source_snapshot_sha256: input.source_snapshot_sha256,
    tool: input.tool,
    status: resultStatus(input),
    files,
    counts,
  };
  return validateContract(
    ScaSyntaxInventoryResultV1Schema,
    { ...unsigned, inventory_sha256: digestInventory(unsigned) },
    "SCA syntax inventory result"
  );
}

export function validateScaSyntaxInventoryResultV1(value: unknown): ScaSyntaxInventoryResultV1 {
  const result = validateContract(
    ScaSyntaxInventoryResultV1Schema,
    value,
    "SCA syntax inventory result"
  );
  const { inventory_sha256: observedDigest, ...unsigned } = result;
  if (digestInventory(unsigned) !== observedDigest) {
    throw new ScaSyntaxInventoryError("invalid_input", "syntax inventory digest does not match");
  }
  return result;
}
