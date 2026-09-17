import { Type, type Static } from "typebox";

import { canonicalJson, sha256 } from "../../../orchestration/src/canonical-json.js";
import { validateContract } from "../../../orchestration/src/contracts.js";
import { Sha256Schema } from "../../../orchestration/src/skill-contracts/common.js";

const MAX_FILES = 100_000;
const MAX_TOTAL_BYTES = 1_073_741_824;
const MAX_FILE_BYTES = 16_777_216;
const MAX_PATH_BYTES = 4_096;
const MAX_TOOL_TEXT = 256;

export const SCA_SOURCE_CENSUS_INPUT_SCHEMA = "penny.sca-source-census-input.v1";
export const SCA_SOURCE_CENSUS_RESULT_SCHEMA = "penny.sca-source-census-result.v1";

const ScaCensusToolIdentityV1Schema = Type.Object(
  {
    name: Type.Literal("penny-source-census"),
    version: Type.String({ minLength: 1, maxLength: MAX_TOOL_TEXT }),
    implementation_sha256: Sha256Schema,
  },
  { additionalProperties: false }
);

const ScaCensusFileV1Schema = Type.Object(
  {
    path: Type.String({ minLength: 1, maxLength: MAX_PATH_BYTES }),
    byte_length: Type.Integer({ minimum: 0, maximum: MAX_FILE_BYTES }),
    sha256: Sha256Schema,
    content_kind: Type.Union([Type.Literal("text"), Type.Literal("binary")]),
    generated: Type.Boolean(),
  },
  { additionalProperties: false }
);

export const ScaSourceCensusInputV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_SOURCE_CENSUS_INPUT_SCHEMA),
    schema_version: Type.Literal(1),
    source_snapshot_sha256: Sha256Schema,
    tool: ScaCensusToolIdentityV1Schema,
    files: Type.Array(ScaCensusFileV1Schema, { minItems: 1, maxItems: MAX_FILES }),
    limits: Type.Object(
      {
        max_files: Type.Integer({ minimum: 1, maximum: MAX_FILES }),
        max_total_bytes: Type.Integer({ minimum: 1, maximum: MAX_TOTAL_BYTES }),
      },
      { additionalProperties: false }
    ),
  },
  { additionalProperties: false }
);

export const ScaSourceLanguageV1Schema = Type.Union([
  Type.Literal("php"),
  Type.Literal("javascript"),
  Type.Literal("typescript"),
  Type.Literal("other"),
]);

const ScaSourceCensusEntryV1Schema = Type.Object(
  {
    path: Type.String({ minLength: 1, maxLength: MAX_PATH_BYTES }),
    byte_length: Type.Integer({ minimum: 0, maximum: MAX_FILE_BYTES }),
    sha256: Sha256Schema,
    content_kind: Type.Union([Type.Literal("text"), Type.Literal("binary")]),
    generated: Type.Boolean(),
    language: ScaSourceLanguageV1Schema,
  },
  { additionalProperties: false }
);

export const ScaSourceCensusResultV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_SOURCE_CENSUS_RESULT_SCHEMA),
    schema_version: Type.Literal(1),
    source_snapshot_sha256: Sha256Schema,
    tool: ScaCensusToolIdentityV1Schema,
    entries: Type.Array(ScaSourceCensusEntryV1Schema, { minItems: 1, maxItems: MAX_FILES }),
    counts: Type.Object(
      {
        files: Type.Integer({ minimum: 1, maximum: MAX_FILES }),
        bytes: Type.Integer({ minimum: 0, maximum: MAX_TOTAL_BYTES }),
        text: Type.Integer({ minimum: 0, maximum: MAX_FILES }),
        binary: Type.Integer({ minimum: 0, maximum: MAX_FILES }),
        generated: Type.Integer({ minimum: 0, maximum: MAX_FILES }),
        php: Type.Integer({ minimum: 0, maximum: MAX_FILES }),
        javascript: Type.Integer({ minimum: 0, maximum: MAX_FILES }),
        typescript: Type.Integer({ minimum: 0, maximum: MAX_FILES }),
        other: Type.Integer({ minimum: 0, maximum: MAX_FILES }),
      },
      { additionalProperties: false }
    ),
    census_sha256: Sha256Schema,
  },
  { additionalProperties: false }
);

export type ScaSourceCensusInputV1 = Static<typeof ScaSourceCensusInputV1Schema>;
export type ScaSourceLanguageV1 = Static<typeof ScaSourceLanguageV1Schema>;
export type ScaSourceCensusResultV1 = Static<typeof ScaSourceCensusResultV1Schema>;

type ScaSourceCensusUnsignedV1 = Omit<ScaSourceCensusResultV1, "census_sha256">;

export class ScaSourceCensusError extends Error {
  constructor(
    readonly code: "invalid_input" | "unsafe_path" | "path_collision" | "quota_exceeded",
    message: string
  ) {
    super(message);
    this.name = "ScaSourceCensusError";
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
    throw new ScaSourceCensusError("unsafe_path", "source census path is not canonical");
  }
}

function languageForPath(candidate: string): ScaSourceLanguageV1 {
  const basename = candidate.slice(candidate.lastIndexOf("/") + 1).toLowerCase();
  if (basename.endsWith(".php") || basename === "composer.json" || basename === "composer.lock") {
    return "php";
  }
  if (
    basename.endsWith(".ts") ||
    basename.endsWith(".tsx") ||
    basename.endsWith(".mts") ||
    basename.endsWith(".cts")
  ) {
    return "typescript";
  }
  if (
    basename.endsWith(".js") ||
    basename.endsWith(".jsx") ||
    basename.endsWith(".mjs") ||
    basename.endsWith(".cjs") ||
    basename === "package.json" ||
    basename.endsWith("lock.json") ||
    basename === "yarn.lock" ||
    basename === "pnpm-lock.yaml"
  ) {
    return "javascript";
  }
  return "other";
}

function checkedTotal(values: readonly number[]): number {
  let total = 0;
  for (const value of values) {
    total += value;
    if (!Number.isSafeInteger(total)) {
      throw new ScaSourceCensusError("quota_exceeded", "source census byte total is unsafe");
    }
  }
  return total;
}

function digestCensus(value: ScaSourceCensusUnsignedV1): string {
  return sha256(canonicalJson(value));
}

export function buildScaSourceCensusV1(value: unknown): ScaSourceCensusResultV1 {
  let input: ScaSourceCensusInputV1;
  try {
    input = validateContract(ScaSourceCensusInputV1Schema, value, "SCA source census input");
  } catch (error) {
    throw new ScaSourceCensusError(
      "invalid_input",
      error instanceof Error ? error.message : "source census input is invalid"
    );
  }
  if (input.files.length > input.limits.max_files) {
    throw new ScaSourceCensusError("quota_exceeded", "source census exceeds max_files");
  }

  const exactPaths = new Set<string>();
  const foldedPaths = new Set<string>();
  for (const file of input.files) {
    validatePath(file.path);
    const folded = file.path.normalize("NFKC").toLocaleLowerCase("en-US");
    if (exactPaths.has(file.path) || foldedPaths.has(folded)) {
      throw new ScaSourceCensusError("path_collision", "source census paths collide");
    }
    exactPaths.add(file.path);
    foldedPaths.add(folded);
  }

  const entries = input.files
    .map((file) => ({ ...file, language: languageForPath(file.path) }))
    .sort((left, right) => compareUtf8(left.path, right.path));
  const bytes = checkedTotal(entries.map((entry) => entry.byte_length));
  if (bytes > input.limits.max_total_bytes) {
    throw new ScaSourceCensusError("quota_exceeded", "source census exceeds max_total_bytes");
  }

  const unsigned: ScaSourceCensusUnsignedV1 = {
    schema_id: SCA_SOURCE_CENSUS_RESULT_SCHEMA,
    schema_version: 1,
    source_snapshot_sha256: input.source_snapshot_sha256,
    tool: input.tool,
    entries,
    counts: {
      files: entries.length,
      bytes,
      text: entries.filter((entry) => entry.content_kind === "text").length,
      binary: entries.filter((entry) => entry.content_kind === "binary").length,
      generated: entries.filter((entry) => entry.generated).length,
      php: entries.filter((entry) => entry.language === "php").length,
      javascript: entries.filter((entry) => entry.language === "javascript").length,
      typescript: entries.filter((entry) => entry.language === "typescript").length,
      other: entries.filter((entry) => entry.language === "other").length,
    },
  };
  return validateContract(
    ScaSourceCensusResultV1Schema,
    { ...unsigned, census_sha256: digestCensus(unsigned) },
    "SCA source census result"
  );
}

export function validateScaSourceCensusResultV1(value: unknown): ScaSourceCensusResultV1 {
  const result = validateContract(ScaSourceCensusResultV1Schema, value, "SCA source census result");
  const { census_sha256: observedDigest, ...unsigned } = result;
  if (digestCensus(unsigned) !== observedDigest) {
    throw new ScaSourceCensusError("invalid_input", "source census digest does not match");
  }
  return result;
}
