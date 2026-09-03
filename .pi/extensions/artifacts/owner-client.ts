import { createHash } from "node:crypto";

import { ArtifactStore, currentArtifactRef, resolvePennyRuntimeState } from "@penny/orchestration";
import type {
  CurrentArtifactRef as TypeScriptArtifactRef,
  OutputArtifactMetadata as TypeScriptArtifactMetadata,
} from "@penny/orchestration";

export const OUTPUT_ARTIFACT_SCHEMA_VERSION = 2 as const;
export const RESULT_PROTOCOL_VERSION = 2 as const;
export const MAX_ARTIFACT_METADATA_BYTES = 64 * 1024;

const KIND = /^[a-z][a-z0-9-]*$/;

export type ArtifactRef = TypeScriptArtifactRef;
export type OutputArtifactMetadata = Extract<TypeScriptArtifactMetadata, { schema_version: 2 }>;

export interface OutputArtifactExpectation {
  runId: string;
  phase: string;
  branchId: string | null;
  producer: string;
  kind?: string;
}

export type ArtifactClientErrorCode =
  | "ARTIFACT_CONFIG_INVALID"
  | "ARTIFACT_CONTRACT_INVALID"
  | "ARTIFACT_DIGEST_MISMATCH"
  | "ARTIFACT_MISSING"
  | "ARTIFACT_PERSIST_FAILED"
  | "ARTIFACT_PERSIST_TIMEOUT"
  | "ARTIFACT_REF_INVALID";

export class ArtifactClientError extends Error {
  constructor(
    readonly code: ArtifactClientErrorCode,
    message: string,
    readonly metadata: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = "ArtifactClientError";
  }
}

function contractError(message: string): never {
  throw new ArtifactClientError("ARTIFACT_CONTRACT_INVALID", message);
}

function refError(message: string): never {
  throw new ArtifactClientError("ARTIFACT_REF_INVALID", message);
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (!isUnknownRecord(value)) {
    if (label === "ArtifactRef") refError(`${label} must be an object`);
    contractError(`${label} must be an object`);
  }
  return value;
}

function canonicalString(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    Array.from(value).some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 || code === 127;
    })
  ) {
    contractError(`${field} must be a non-empty canonical string`);
  }
  return value;
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function positiveInteger(value: unknown, field: string): number {
  if (!isSafeInteger(value) || value < 1) {
    contractError(`${field} must be a positive integer`);
  }
  return value;
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (isUnknownRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortJson(child)])
    );
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    contractError("artifact metadata cannot contain a non-finite number");
  }
  return value;
}

export function canonicalArtifactJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function artifactIdentity(value: {
  run_id: string;
  phase: string;
  branch_id: string | null;
  kind: string;
  operation_id: string;
  version: number;
}): Record<string, unknown> {
  return {
    branch_id: value.branch_id,
    kind: value.kind,
    operation_id: value.operation_id,
    phase: value.phase,
    run_id: value.run_id,
    version: value.version,
  };
}

export function artifactIdFor(value: {
  run_id: string;
  phase: string;
  branch_id: string | null;
  kind: string;
  operation_id: string;
  version: number;
}): string {
  return `art_${createHash("sha256")
    .update(canonicalArtifactJson(artifactIdentity(value)), "utf8")
    .digest("hex")}`;
}

/** Validate one canonical schema-v2 artifact communication address. */
export function parseArtifactRef(value: unknown): ArtifactRef {
  try {
    return currentArtifactRef(value, "ArtifactRef");
  } catch (error) {
    refError(error instanceof Error ? error.message : "ArtifactRef is invalid");
  }
}

export function parseOutputArtifactMetadata(
  value: unknown,
  expected?: OutputArtifactExpectation
): OutputArtifactMetadata {
  const record = asObject(value, "output_artifact");
  if (record.schema_version !== OUTPUT_ARTIFACT_SCHEMA_VERSION) {
    contractError("unsupported output_artifact schema version");
  }
  const expectedFields = [
    "schema_version",
    "run_id",
    "phase",
    "branch_id",
    "kind",
    "operation_id",
    "version",
    "producer",
    "media_type",
    "parent_ref",
    "upstream_refs",
  ];
  const keys = Object.keys(record);
  const missing = expectedFields.filter((field) => !Object.hasOwn(record, field));
  const unknown = keys.filter((field) => !expectedFields.includes(field));
  if (missing.length > 0) {
    contractError(`output_artifact missing required fields: ${missing.sort().join(", ")}`);
  }
  if (unknown.length > 0) {
    contractError(`output_artifact has unknown fields: ${unknown.sort().join(", ")}`);
  }
  const runId = canonicalString(record.run_id, "output_artifact.run_id");
  const phase = canonicalString(record.phase, "output_artifact.phase");
  const branchId =
    record.branch_id === null
      ? null
      : canonicalString(record.branch_id, "output_artifact.branch_id");
  const kind = canonicalString(record.kind, "output_artifact.kind");
  if (!KIND.test(kind) || kind !== "agent-output") {
    contractError("output_artifact.kind must be agent-output");
  }
  const operationId = canonicalString(record.operation_id, "output_artifact.operation_id");
  const version = positiveInteger(record.version, "output_artifact.version");
  const producer = canonicalString(record.producer, "output_artifact.producer");
  const mediaType = canonicalString(record.media_type, "output_artifact.media_type");
  const parentRef = record.parent_ref === null ? null : parseArtifactRef(record.parent_ref);
  if (!Array.isArray(record.upstream_refs)) {
    contractError("output_artifact.upstream_refs must be an array");
  }
  const upstreamRefs = record.upstream_refs.map(parseArtifactRef);
  if (new Set(upstreamRefs.map((ref) => ref.artifact_id)).size !== upstreamRefs.length) {
    contractError("output_artifact.upstream_refs must not contain duplicates");
  }
  if ((version === 1 && parentRef !== null) || (version > 1 && parentRef === null)) {
    contractError("output_artifact.parent_ref is invalid for its version");
  }
  if (
    parentRef &&
    (parentRef.run_id !== runId ||
      parentRef.phase !== phase ||
      parentRef.branch_id !== branchId ||
      parentRef.kind !== kind ||
      parentRef.operation_id !== operationId ||
      parentRef.version !== version - 1)
  ) {
    contractError("output_artifact.parent_ref is not the immediately preceding version");
  }
  if (
    expected &&
    (runId !== expected.runId ||
      phase !== expected.phase ||
      branchId !== expected.branchId ||
      producer !== expected.producer ||
      (expected.kind !== undefined && kind !== expected.kind))
  ) {
    contractError("output_artifact does not match the trusted action identity");
  }
  const metadata: OutputArtifactMetadata = {
    schema_version: OUTPUT_ARTIFACT_SCHEMA_VERSION,
    run_id: runId,
    phase,
    branch_id: branchId,
    kind: "agent-output",
    operation_id: operationId,
    version,
    producer,
    media_type: mediaType,
    parent_ref: parentRef,
    upstream_refs: upstreamRefs,
  };
  if (Buffer.byteLength(canonicalArtifactJson(metadata), "utf8") > MAX_ARTIFACT_METADATA_BYTES) {
    contractError(`output_artifact metadata exceeds ${MAX_ARTIFACT_METADATA_BYTES} UTF-8 bytes`);
  }
  return metadata;
}

export function expectedArtifactRef(
  metadataValue: OutputArtifactMetadata | unknown,
  output: string | Buffer
): ArtifactRef {
  const metadata = parseOutputArtifactMetadata(metadataValue);
  const bytes = Buffer.isBuffer(output) ? Buffer.from(output) : Buffer.from(output, "utf8");
  const digest = createHash("sha256").update(bytes).digest("hex");
  return parseArtifactRef({
    schema_version: OUTPUT_ARTIFACT_SCHEMA_VERSION,
    artifact_id: artifactIdFor(metadata),
    run_id: metadata.run_id,
    phase: metadata.phase,
    branch_id: metadata.branch_id,
    kind: metadata.kind,
    operation_id: metadata.operation_id,
    version: metadata.version,
    producer: metadata.producer,
    media_type: metadata.media_type,
    byte_length: bytes.length,
    content_digest: digest,
    store_ref: `artifact://sha256/${digest}`,
  });
}

export function stableArtifactReceiptId(metadataValue: OutputArtifactMetadata | unknown): string {
  const metadata = parseOutputArtifactMetadata(metadataValue);
  const digest = createHash("sha256")
    .update(canonicalArtifactJson(artifactIdentity(metadata)), "utf8")
    .digest("hex");
  return `artifact-receipt:${digest}`;
}

export function resolveArtifactRoot(
  projectRoot: string,
  env: Readonly<Record<string, string | undefined>> = process.env
): string {
  for (const name of ["PENNY_ARTIFACT_ROOT", "PENNY_ARTIFACT_GRANT_ROOT"] as const) {
    if (env[name]?.trim()) {
      throw new ArtifactClientError(
        "ARTIFACT_CONFIG_INVALID",
        `${name} is retired; artifacts are bound to the Pi-native Penny project partition`
      );
    }
  }
  try {
    return resolvePennyRuntimeState(projectRoot, { env }).paths.artifacts.root;
  } catch (error) {
    throw new ArtifactClientError(
      "ARTIFACT_CONFIG_INVALID",
      error instanceof Error ? error.message : "Penny project state is unavailable"
    );
  }
}

export async function refArtifactById(input: {
  artifactId: string;
  projectRoot: string;
  env?: Readonly<Record<string, string | undefined>>;
}): Promise<ArtifactRef | undefined> {
  try {
    const artifactRoot = resolveArtifactRoot(input.projectRoot, input.env);
    const state = resolvePennyRuntimeState(input.projectRoot, { env: input.env });
    using store = ArtifactStore.openExisting(artifactRoot, { projectId: state.projectId });
    return store.refById(input.artifactId);
  } catch (error) {
    if (error instanceof ArtifactClientError) throw error;
    throw new ArtifactClientError(
      "ARTIFACT_CONFIG_INVALID",
      error instanceof Error ? error.message : "artifact manifest lookup failed"
    );
  }
}

export async function readArtifactsById(input: {
  artifactIds: readonly string[];
  projectRoot: string;
  env?: Readonly<Record<string, string | undefined>>;
}): Promise<Array<{ ref: ArtifactRef; content: Buffer }>> {
  try {
    const artifactRoot = resolveArtifactRoot(input.projectRoot, input.env);
    const state = resolvePennyRuntimeState(input.projectRoot, { env: input.env });
    using store = ArtifactStore.openExisting(artifactRoot, { projectId: state.projectId });
    return input.artifactIds.map((artifactId) => {
      const ref = store.refById(artifactId);
      if (ref === undefined) {
        throw new ArtifactClientError("ARTIFACT_MISSING", "artifact is absent from the manifest", {
          artifactId,
        });
      }
      return { ref, content: store.readById(artifactId) };
    });
  } catch (error) {
    if (error instanceof ArtifactClientError) throw error;
    const message = error instanceof Error ? error.message : "artifact read failed";
    const code = /verification|digest|byte/i.test(message)
      ? "ARTIFACT_DIGEST_MISMATCH"
      : /absent|missing/i.test(message)
        ? "ARTIFACT_MISSING"
        : "ARTIFACT_CONFIG_INVALID";
    throw new ArtifactClientError(code, message);
  }
}

export async function readArtifactById(input: {
  artifactId: string;
  projectRoot: string;
  env?: Readonly<Record<string, string | undefined>>;
}): Promise<{ ref: ArtifactRef; content: Buffer }> {
  const [read] = await readArtifactsById({
    artifactIds: [input.artifactId],
    projectRoot: input.projectRoot,
    env: input.env,
  });
  if (read === undefined) {
    throw new ArtifactClientError("ARTIFACT_MISSING", "artifact is absent from the manifest");
  }
  return read;
}

/** Read and independently verify exact artifact bytes as the execution owner. */
export async function readArtifactOutput(input: {
  ref: ArtifactRef | unknown;
  projectRoot: string;
  env?: Readonly<Record<string, string | undefined>>;
}): Promise<Buffer> {
  const supplied = parseArtifactRef(input.ref);
  const read = await readArtifactById({
    artifactId: supplied.artifact_id,
    projectRoot: input.projectRoot,
    env: input.env,
  });
  if (canonicalArtifactJson(read.ref) !== canonicalArtifactJson(supplied)) {
    throw new ArtifactClientError("ARTIFACT_REF_INVALID", "artifact ref does not match manifest", {
      artifactId: supplied.artifact_id,
    });
  }
  return read.content;
}

/** Persist output and prove the returned ID is immediately readable byte-for-byte. */
export async function persistArtifactOutput(input: {
  metadata: OutputArtifactMetadata | unknown;
  output: string | Buffer;
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): Promise<ArtifactRef> {
  const metadata = parseOutputArtifactMetadata(input.metadata);
  const outputBytes = Buffer.isBuffer(input.output)
    ? Buffer.from(input.output)
    : Buffer.from(input.output, "utf8");
  try {
    const artifactRoot = resolveArtifactRoot(input.cwd, input.env);
    const state = resolvePennyRuntimeState(input.cwd, { env: input.env });
    using store = ArtifactStore.openExisting(artifactRoot, { projectId: state.projectId });
    const ref = parseArtifactRef(
      store.persist({
        metadata,
        content: outputBytes,
      })
    );
    const expected = expectedArtifactRef(metadata, outputBytes);
    if (canonicalArtifactJson(ref) !== canonicalArtifactJson(expected)) {
      refError("TypeScript artifact owner returned a ref that does not match exact output bytes");
    }
    const verified = store.readById(ref.artifact_id);
    if (!verified.equals(outputBytes)) {
      throw new ArtifactClientError(
        "ARTIFACT_DIGEST_MISMATCH",
        "persisted artifact re-read did not match exact output bytes",
        { artifactId: ref.artifact_id }
      );
    }
    return ref;
  } catch (error) {
    if (error instanceof ArtifactClientError) throw error;
    throw new ArtifactClientError(
      "ARTIFACT_PERSIST_FAILED",
      error instanceof Error ? error.message : "TypeScript artifact persistence failed",
      { operationId: metadata.operation_id, version: metadata.version }
    );
  }
}
