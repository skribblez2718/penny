import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  validateScaPhaseRoleMap,
  validateScaPolicy,
  validateScaProfile,
  validateScaTarget,
} from "../dist/sca/config.js";
import { requireValue } from "./helpers/narrowing.js";

interface SchemaIdentity {
  readonly schema_id: string;
  readonly schema_version: number;
}

interface FixtureManifestEntry {
  readonly filename: string;
  readonly sha256: string;
  readonly schema_identity: SchemaIdentity;
  readonly expected_outcome: "accepted";
  readonly required_environment: "offline_local";
  readonly negative_oracle: "reject_invalid_or_schema_incompatible_content";
  readonly license_tag: "project-authored";
  readonly safety_tag: "no-external-action";
}

interface FixtureFailureRules {
  readonly missing_fixture: "failure";
  readonly empty_fixture: "failure";
  readonly unreadable_fixture: "failure";
  readonly digest_mismatch: "failure";
  readonly unexpected_extra_fixture: "failure";
  readonly skipped_case_counts_as_pass: false;
}

interface FixtureManifest {
  readonly schema_id: "penny.sca-fixture-manifest.v1";
  readonly schema_version: 1;
  readonly fixtures: readonly FixtureManifestEntry[];
  readonly failure_rules: FixtureFailureRules;
}

interface FixtureSource {
  readonly names: () => readonly string[];
  readonly read: (filename: string) => Buffer;
}

type FixtureValidator = (value: unknown) => unknown;

const FIXTURE_ROOT = new URL("./fixtures/sca/", import.meta.url);
const MANIFEST_FILENAME = "manifest.json";
const EXPECTED_FILENAMES: readonly string[] = [
  "phase-role-map.json",
  "policy.json",
  "profile.json",
  "target.json",
];
const MANIFEST_FIELDS: readonly string[] = [
  "schema_id",
  "schema_version",
  "fixtures",
  "failure_rules",
];
const ENTRY_FIELDS: readonly string[] = [
  "filename",
  "sha256",
  "schema_identity",
  "expected_outcome",
  "required_environment",
  "negative_oracle",
  "license_tag",
  "safety_tag",
];
const SCHEMA_IDENTITY_FIELDS: readonly string[] = ["schema_id", "schema_version"];
const FAILURE_RULE_FIELDS: readonly string[] = [
  "missing_fixture",
  "empty_fixture",
  "unreadable_fixture",
  "digest_mismatch",
  "unexpected_extra_fixture",
  "skipped_case_counts_as_pass",
];

const EXPECTED_SCHEMAS = new Map<string, SchemaIdentity>([
  ["phase-role-map.json", { schema_id: "penny.sca-phase-role-map.v1", schema_version: 1 }],
  ["policy.json", { schema_id: "penny.sca-policy.v1", schema_version: 1 }],
  ["profile.json", { schema_id: "penny.sca-profile.v1", schema_version: 1 }],
  ["target.json", { schema_id: "penny.sca-target.v1", schema_version: 1 }],
]);

const VALIDATORS = new Map<string, FixtureValidator>([
  ["phase-role-map.json", validateScaPhaseRoleMap],
  ["policy.json", validateScaPolicy],
  ["profile.json", validateScaProfile],
  ["target.json", validateScaTarget],
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordValue(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function exactFields(
  value: Record<string, unknown>,
  expectedFields: readonly string[],
  label: string
): void {
  const expected = new Set(expectedFields);
  const actual = Object.keys(value);
  const missing = expectedFields.filter((field) => !(field in value));
  const unknown = actual.filter((field) => !expected.has(field));

  if (missing.length > 0) {
    throw new Error(`${label} is missing field(s): ${missing.join(", ")}`);
  }
  if (unknown.length > 0) {
    throw new Error(`${label} has unknown field(s): ${unknown.join(", ")}`);
  }
}

function field(value: Record<string, unknown>, name: string, label: string): unknown {
  if (!(name in value)) {
    throw new Error(`${label} is missing field: ${name}`);
  }
  return value[name];
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a nonempty string`);
  }
  return value;
}

function integerValue(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`${label} must be a safe integer`);
  }
  return value;
}

function literalString<Value extends string>(
  value: unknown,
  expected: Value,
  label: string
): Value {
  if (value !== expected) {
    throw new Error(`${label} must equal ${expected}`);
  }
  return expected;
}

function literalNumber<Value extends number>(
  value: unknown,
  expected: Value,
  label: string
): Value {
  if (value !== expected) {
    throw new Error(`${label} must equal ${expected}`);
  }
  return expected;
}

function literalFalse(value: unknown, label: string): false {
  if (value !== false) {
    throw new Error(`${label} must be false`);
  }
  return false;
}

function sha256Value(value: unknown, label: string): string {
  const digest = stringValue(value, label);
  if (!/^[a-f0-9]{64}$/u.test(digest)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
  return digest;
}

function parseSchemaIdentity(value: unknown, label: string): SchemaIdentity {
  const record = recordValue(value, label);
  exactFields(record, SCHEMA_IDENTITY_FIELDS, label);
  return {
    schema_id: stringValue(field(record, "schema_id", label), `${label}.schema_id`),
    schema_version: integerValue(field(record, "schema_version", label), `${label}.schema_version`),
  };
}

function parseManifestEntry(value: unknown, index: number): FixtureManifestEntry {
  const label = `manifest.fixtures[${index}]`;
  const record = recordValue(value, label);
  exactFields(record, ENTRY_FIELDS, label);

  return {
    filename: stringValue(field(record, "filename", label), `${label}.filename`),
    sha256: sha256Value(field(record, "sha256", label), `${label}.sha256`),
    schema_identity: parseSchemaIdentity(
      field(record, "schema_identity", label),
      `${label}.schema_identity`
    ),
    expected_outcome: literalString(
      field(record, "expected_outcome", label),
      "accepted",
      `${label}.expected_outcome`
    ),
    required_environment: literalString(
      field(record, "required_environment", label),
      "offline_local",
      `${label}.required_environment`
    ),
    negative_oracle: literalString(
      field(record, "negative_oracle", label),
      "reject_invalid_or_schema_incompatible_content",
      `${label}.negative_oracle`
    ),
    license_tag: literalString(
      field(record, "license_tag", label),
      "project-authored",
      `${label}.license_tag`
    ),
    safety_tag: literalString(
      field(record, "safety_tag", label),
      "no-external-action",
      `${label}.safety_tag`
    ),
  };
}

function parseFailureRules(value: unknown): FixtureFailureRules {
  const label = "manifest.failure_rules";
  const record = recordValue(value, label);
  exactFields(record, FAILURE_RULE_FIELDS, label);

  return {
    missing_fixture: literalString(
      field(record, "missing_fixture", label),
      "failure",
      `${label}.missing_fixture`
    ),
    empty_fixture: literalString(
      field(record, "empty_fixture", label),
      "failure",
      `${label}.empty_fixture`
    ),
    unreadable_fixture: literalString(
      field(record, "unreadable_fixture", label),
      "failure",
      `${label}.unreadable_fixture`
    ),
    digest_mismatch: literalString(
      field(record, "digest_mismatch", label),
      "failure",
      `${label}.digest_mismatch`
    ),
    unexpected_extra_fixture: literalString(
      field(record, "unexpected_extra_fixture", label),
      "failure",
      `${label}.unexpected_extra_fixture`
    ),
    skipped_case_counts_as_pass: literalFalse(
      field(record, "skipped_case_counts_as_pass", label),
      `${label}.skipped_case_counts_as_pass`
    ),
  };
}

function parseFixtureManifest(value: unknown): FixtureManifest {
  const label = "manifest";
  const record = recordValue(value, label);
  exactFields(record, MANIFEST_FIELDS, label);
  const fixturesValue = field(record, "fixtures", label);
  if (!Array.isArray(fixturesValue)) {
    throw new Error("manifest.fixtures must be an array");
  }

  return {
    schema_id: literalString(
      field(record, "schema_id", label),
      "penny.sca-fixture-manifest.v1",
      "manifest.schema_id"
    ),
    schema_version: literalNumber(
      field(record, "schema_version", label),
      1,
      "manifest.schema_version"
    ),
    fixtures: fixturesValue.map((entry, index) => parseManifestEntry(entry, index)),
    failure_rules: parseFailureRules(field(record, "failure_rules", label)),
  };
}

function parseFixtureManifestText(text: string): FixtureManifest {
  const parsed: unknown = JSON.parse(text);
  return parseFixtureManifest(parsed);
}

function exactNameSet(
  actualNames: readonly string[],
  expectedNames: readonly string[],
  label: string
): void {
  const actual = [...actualNames].sort();
  const expected = [...expectedNames].sort();
  if (actual.length !== expected.length) {
    throw new Error(`${label} does not match the exact fixture filename set`);
  }
  for (let index = 0; index < expected.length; index += 1) {
    if (actual[index] !== expected[index]) {
      throw new Error(`${label} does not match the exact fixture filename set`);
    }
  }
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function readFixture(source: FixtureSource, filename: string): Buffer {
  try {
    return source.read(filename);
  } catch (error) {
    throw new Error(`Fixture is unreadable: ${filename}`, { cause: error });
  }
}

function parseNonemptyFixture(bytes: Buffer, filename: string): Record<string, unknown> {
  if (bytes.length === 0) {
    throw new Error(`Fixture is empty: ${filename}`);
  }
  const parsed: unknown = JSON.parse(bytes.toString("utf8"));
  const record = recordValue(parsed, `fixture ${filename}`);
  if (Object.keys(record).length === 0) {
    throw new Error(`Fixture JSON is empty: ${filename}`);
  }
  return record;
}

function verifyFixtureManifest(manifest: FixtureManifest, source: FixtureSource): void {
  const manifestNames = manifest.fixtures.map((entry) => entry.filename);
  exactNameSet(manifestNames, EXPECTED_FILENAMES, "Manifest");
  exactNameSet(source.names(), EXPECTED_FILENAMES, "Fixture directory");

  for (const entry of manifest.fixtures) {
    const bytes = readFixture(source, entry.filename);
    if (bytes.length === 0) {
      throw new Error(`Fixture is empty: ${entry.filename}`);
    }
    if (sha256(bytes) !== entry.sha256) {
      throw new Error(`Fixture digest mismatch: ${entry.filename}`);
    }

    const fixture = parseNonemptyFixture(bytes, entry.filename);
    const expectedSchema = requireValue(
      EXPECTED_SCHEMAS.get(entry.filename),
      `expected schema for ${entry.filename}`
    );
    const actualSchema: SchemaIdentity = {
      schema_id: stringValue(
        field(fixture, "schema_id", `fixture ${entry.filename}`),
        `${entry.filename}.schema_id`
      ),
      schema_version: integerValue(
        field(fixture, "schema_version", `fixture ${entry.filename}`),
        `${entry.filename}.schema_version`
      ),
    };

    if (
      entry.schema_identity.schema_id !== expectedSchema.schema_id ||
      entry.schema_identity.schema_version !== expectedSchema.schema_version ||
      actualSchema.schema_id !== expectedSchema.schema_id ||
      actualSchema.schema_version !== expectedSchema.schema_version
    ) {
      throw new Error(`Fixture schema identity mismatch: ${entry.filename}`);
    }

    const validator = requireValue(
      VALIDATORS.get(entry.filename),
      `validator for ${entry.filename}`
    );
    validator(fixture);
  }
}

function realFixtureSource(): FixtureSource {
  return {
    names: () => readdirSync(FIXTURE_ROOT).filter((name) => name !== MANIFEST_FILENAME),
    read: (filename) => readFileSync(new URL(filename, FIXTURE_ROOT)),
  };
}

function canonicalManifest(): FixtureManifest {
  return parseFixtureManifestText(readFileSync(new URL(MANIFEST_FILENAME, FIXTURE_ROOT), "utf8"));
}

function canonicalFixtureBytes(): ReadonlyMap<string, Buffer> {
  return new Map(
    EXPECTED_FILENAMES.map((filename) => [filename, readFileSync(new URL(filename, FIXTURE_ROOT))])
  );
}

function memoryFixtureSource(
  files: ReadonlyMap<string, Buffer>,
  unreadable: ReadonlySet<string> = new Set<string>()
): FixtureSource {
  return {
    names: () => [...files.keys()],
    read: (filename) => {
      if (unreadable.has(filename)) {
        throw new Error(`Simulated unreadable fixture: ${filename}`);
      }
      return requireValue(files.get(filename), `in-memory fixture ${filename}`);
    },
  };
}

describe("S-00-T3 SCA fixture manifest", () => {
  it("accepts exactly four digest-bound, offline-local, project-authored safe fixtures", () => {
    const manifest = canonicalManifest();

    expect(manifest.fixtures.map((entry) => entry.filename).sort()).toEqual(EXPECTED_FILENAMES);
    expect(manifest.fixtures).toHaveLength(4);
    for (const entry of manifest.fixtures) {
      expect(entry).toMatchObject({
        expected_outcome: "accepted",
        required_environment: "offline_local",
        negative_oracle: "reject_invalid_or_schema_incompatible_content",
        license_tag: "project-authored",
        safety_tag: "no-external-action",
      });
    }
    expect(manifest.failure_rules).toEqual({
      missing_fixture: "failure",
      empty_fixture: "failure",
      unreadable_fixture: "failure",
      digest_mismatch: "failure",
      unexpected_extra_fixture: "failure",
      skipped_case_counts_as_pass: false,
    });
    expect(() => verifyFixtureManifest(manifest, realFixtureSource())).not.toThrow();
  });

  it("rejects malformed JSON plus unknown or missing manifest fields", () => {
    const manifest = canonicalManifest();
    const first = requireValue(manifest.fixtures[0], "first manifest fixture");
    const { fixtures: _fixtures, ...missingFixtures } = manifest;
    const { license_tag: _licenseTag, ...missingLicenseTag } = first;

    expect(() => parseFixtureManifestText('{"schema_id":')).toThrow();
    expect(() => parseFixtureManifest({ ...manifest, unknown: true })).toThrow(/unknown field/u);
    expect(() => parseFixtureManifest(missingFixtures)).toThrow(/missing field.*fixtures/u);
    expect(() =>
      parseFixtureManifest({
        ...manifest,
        fixtures: [{ ...first, unknown: true }, ...manifest.fixtures.slice(1)],
      })
    ).toThrow(/unknown field/u);
    expect(() =>
      parseFixtureManifest({
        ...manifest,
        fixtures: [missingLicenseTag, ...manifest.fixtures.slice(1)],
      })
    ).toThrow(/missing field.*license_tag/u);
    expect(() =>
      parseFixtureManifest({
        ...manifest,
        failure_rules: {
          ...manifest.failure_rules,
          skipped_case_counts_as_pass: true,
        },
      })
    ).toThrow(/must be false/u);
  });

  it("fails closed for missing, empty, unreadable, drifted, or unexpected fixture bytes", () => {
    const manifest = canonicalManifest();
    const files = canonicalFixtureBytes();
    const filename = requireValue(EXPECTED_FILENAMES[0], "first expected fixture filename");
    const original = requireValue(files.get(filename), `canonical fixture ${filename}`);

    const missing = new Map(files);
    missing.delete(filename);
    expect(() => verifyFixtureManifest(manifest, memoryFixtureSource(missing))).toThrow(
      /exact fixture filename set/u
    );

    const empty = new Map(files);
    empty.set(filename, Buffer.alloc(0));
    expect(() => verifyFixtureManifest(manifest, memoryFixtureSource(empty))).toThrow(/empty/u);

    expect(() =>
      verifyFixtureManifest(manifest, memoryFixtureSource(files, new Set([filename])))
    ).toThrow(/unreadable/u);

    const drifted = new Map(files);
    drifted.set(filename, Buffer.concat([original, Buffer.from("\n", "utf8")]));
    expect(() => verifyFixtureManifest(manifest, memoryFixtureSource(drifted))).toThrow(
      /digest mismatch/u
    );

    const unexpected = new Map(files);
    unexpected.set("unexpected.json", Buffer.from("{}\n", "utf8"));
    expect(() => verifyFixtureManifest(manifest, memoryFixtureSource(unexpected))).toThrow(
      /exact fixture filename set/u
    );
  });
});
