import { Type, type Static, type TSchema, type TString } from "typebox";
import { Value } from "typebox/value";

const SCHEMA_ID_PATTERN = "^penny\\.[a-z0-9-]+\\.v[1-9][0-9]*$";
const OPAQUE_ID_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$";
const SHA256_PATTERN = "^[a-f0-9]{64}$";
const ARTIFACT_ID_PATTERN = "^art_[a-f0-9]{64}$";
const RFC3339_UTC_PATTERN =
  "^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]{1,9})?Z$";
const PROTOTYPE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const C0_BEFORE_LF_END = 0x09;
const C0_AFTER_LF_START = 0x0b;
const C0_END = 0x1f;
const C1_START = 0x7f;
const C1_END = 0x9f;

function hasDisallowedTextControl(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return (
      codePoint !== undefined &&
      ((codePoint >= 0 && codePoint <= C0_BEFORE_LF_END) ||
        (codePoint >= C0_AFTER_LF_START && codePoint <= C0_END) ||
        (codePoint >= C1_START && codePoint <= C1_END))
    );
  });
}

export const SchemaIdSchema = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: SCHEMA_ID_PATTERN,
});
export type SchemaId = Static<typeof SchemaIdSchema>;

export const OpaqueIdSchema = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: OPAQUE_ID_PATTERN,
});
export type OpaqueId = Static<typeof OpaqueIdSchema>;

export const Sha256Schema = Type.String({ pattern: SHA256_PATTERN });
export type Sha256 = Static<typeof Sha256Schema>;

export const ArtifactIdSchema = Type.String({ pattern: ARTIFACT_ID_PATTERN });
export const Rfc3339UtcSchema = Type.String({
  minLength: 20,
  maxLength: 40,
  pattern: RFC3339_UTC_PATTERN,
});

export function TextSchema(options: {
  readonly minBytes?: number;
  readonly maxBytes: number;
  readonly multiline?: boolean;
}): TString {
  return Type.String({
    minLength: options.minBytes === undefined ? 0 : Math.min(1, options.minBytes),
    maxLength: options.maxBytes,
  });
}

export const ContentSchemaIdentityV1Schema = Type.Object(
  {
    schema_id: SchemaIdSchema,
    schema_version: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false }
);
export type ContentSchemaIdentityV1 = Static<typeof ContentSchemaIdentityV1Schema>;

export class SkillSchemaValidationError extends Error {
  readonly issues: readonly string[];

  constructor(label: string, issues: readonly string[]) {
    super(`${label} failed validation: ${issues.join("; ")}`);
    this.name = "SkillSchemaValidationError";
    this.issues = issues;
  }
}

export function validateSkillSchema<TSchemaValue extends TSchema>(
  schema: TSchemaValue,
  value: unknown,
  label: string
): Static<TSchemaValue> {
  if (Value.Check(schema, value)) return value as Static<TSchemaValue>;
  const issues = [...Value.Errors(schema, value)].map(
    (issue) => `${issue.instancePath || "/"}: ${issue.message}`
  );
  throw new SkillSchemaValidationError(label, issues);
}

export function assertOpaqueId(value: string, label: string): void {
  if (value.includes("..") || PROTOTYPE_KEYS.has(value)) {
    throw new SkillSchemaValidationError(label, ["opaque ID is unsafe"]);
  }
}

export function assertText(
  value: string,
  label: string,
  options: {
    readonly minBytes?: number;
    readonly maxBytes: number;
    readonly multiline?: boolean;
    readonly trimmedNonEmpty?: boolean;
  }
): void {
  const bytes = Buffer.byteLength(value, "utf8");
  if (
    value !== value.normalize("NFC") ||
    value.includes("\r") ||
    hasDisallowedTextControl(value) ||
    (!options.multiline && value.includes("\n")) ||
    bytes < (options.minBytes ?? 0) ||
    bytes > options.maxBytes ||
    (options.trimmedNonEmpty === true && value.trim().length === 0)
  ) {
    throw new SkillSchemaValidationError(label, [
      `text must be NFC, control-free, ${options.multiline === true ? "LF-only" : "single-line"}, and ${options.minBytes ?? 0}..${options.maxBytes} UTF-8 bytes`,
    ]);
  }
}

export function assertRfc3339Utc(value: string, label: string): void {
  if (!new RegExp(RFC3339_UTC_PATTERN, "u").test(value)) {
    throw new SkillSchemaValidationError(label, ["timestamp must be RFC 3339 UTC with Z"]);
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/u.exec(value);
  if (match === null) {
    throw new SkillSchemaValidationError(label, ["timestamp is malformed"]);
  }
  const [, yearText, monthText, dayText] = match;
  if (yearText === undefined || monthText === undefined || dayText === undefined) {
    throw new SkillSchemaValidationError(label, ["timestamp is malformed"]);
  }
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day > daysInMonth || !Number.isFinite(Date.parse(value))) {
    throw new SkillSchemaValidationError(label, ["timestamp is not a real UTC instant"]);
  }
}

export function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new SkillSchemaValidationError(label, ["values must be unique"]);
  }
}

export function assertDerivedId(
  value: string,
  prefix: "prc_" | "penv_" | "rrpt_" | "dpir_" | "dpenv_" | "eadm_" | "dgvr_" | "dgir_" | "dgenv_",
  canonicalBodySha256: string,
  label: string
): void {
  if (value !== `${prefix}${canonicalBodySha256}`) {
    throw new SkillSchemaValidationError(label, ["derived ID does not match canonical body"]);
  }
}
