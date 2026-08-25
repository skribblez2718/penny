import { currentArtifactRef, currentOutputArtifactMetadata } from "../artifact-store.js";
import type { CurrentArtifactRef, OutputArtifactMetadata } from "../contracts.js";

const REF_V1_FIELDS = [
  "schema_version",
  "artifact_id",
  "run_id",
  "phase",
  "branch_id",
  "kind",
  "operation_id",
  "version",
  "producer",
  "consumer_scope",
  "media_type",
  "byte_length",
  "content_digest",
  "store_ref",
] as const;
const METADATA_V1_FIELDS = [
  "schema_version",
  "run_id",
  "phase",
  "branch_id",
  "kind",
  "operation_id",
  "version",
  "producer",
  "consumer_scope",
  "media_type",
  "parent_ref",
  "upstream_refs",
] as const;

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!isUnknownRecord(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function exactFields(
  value: Record<string, unknown>,
  fields: readonly string[],
  label: string
): void {
  const actual = Object.keys(value);
  const missing = fields.filter((field) => !Object.hasOwn(value, field));
  const unknown = actual.filter((field) => !fields.includes(field));
  if (missing.length > 0 || unknown.length > 0) {
    throw new Error(`${label} has an invalid schema-v1 field set`);
  }
}

function consumerScope(value: unknown, label: string): void {
  if (
    !Array.isArray(value) ||
    value.length > 128 ||
    value.some((entry) => typeof entry !== "string" || entry.length === 0) ||
    new Set(value).size !== value.length
  ) {
    throw new Error(`${label}.consumer_scope is invalid`);
  }
}

/** Migration-only schema-v1 ref decoder; ordinary runtime never imports it. */
export function migrationArtifactRef(value: unknown, label = "artifact ref"): CurrentArtifactRef {
  const record = object(value, label);
  if (record.schema_version !== 1) return currentArtifactRef(value, label);
  exactFields(record, REF_V1_FIELDS, label);
  consumerScope(record.consumer_scope, label);
  return currentArtifactRef(
    {
      schema_version: 2,
      artifact_id: record.artifact_id,
      run_id: record.run_id,
      phase: record.phase,
      branch_id: record.branch_id,
      kind: record.kind,
      operation_id: record.operation_id,
      version: record.version,
      producer: record.producer,
      media_type: record.media_type,
      byte_length: record.byte_length,
      content_digest: record.content_digest,
      store_ref: record.store_ref,
    },
    label
  );
}

/** Migration-only schema-v1 metadata decoder; ordinary runtime accepts v2 only. */
export function migrationOutputArtifactMetadata(value: unknown): OutputArtifactMetadata {
  const record = object(value, "output artifact metadata");
  if (record.schema_version !== 1) return currentOutputArtifactMetadata(value);
  exactFields(record, METADATA_V1_FIELDS, "output artifact metadata");
  consumerScope(record.consumer_scope, "output artifact metadata");
  if (!Array.isArray(record.upstream_refs)) {
    throw new Error("output artifact metadata upstream_refs must be an array");
  }
  return currentOutputArtifactMetadata({
    schema_version: 2,
    run_id: record.run_id,
    phase: record.phase,
    branch_id: record.branch_id,
    kind: record.kind,
    operation_id: record.operation_id,
    version: record.version,
    producer: record.producer,
    media_type: record.media_type,
    parent_ref:
      record.parent_ref === null
        ? null
        : migrationArtifactRef(record.parent_ref, "output artifact metadata parent_ref"),
    upstream_refs: record.upstream_refs.map((ref, index) =>
      migrationArtifactRef(ref, `output artifact metadata upstream_refs[${index}]`)
    ),
  });
}
