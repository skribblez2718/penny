import { createHash } from "crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  ArtifactStore,
  type OutputArtifactMetadata as TypeScriptOutputArtifactMetadata,
} from "@penny/orchestration/source";

export const OUTPUT_ARTIFACT_SCHEMA_VERSION = 1 as const;
export const RESULT_PROTOCOL_VERSION = 2 as const;
export const MAX_ARTIFACT_METADATA_BYTES = 64 * 1024;

const ARTIFACT_ID = /^art_[0-9a-f]{64}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const KIND = /^[a-z][a-z0-9-]*$/;
const STORE_REF = /^artifact:\/\/sha256\/[0-9a-f]{64}$/;

const OUTPUT_ARTIFACT_FIELDS = [
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

const ARTIFACT_REF_FIELDS = [
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

export interface ArtifactRef {
  schema_version: 1;
  artifact_id: string;
  run_id: string;
  phase: string;
  branch_id: string | null;
  kind: string;
  operation_id: string;
  version: number;
  producer: string;
  consumer_scope: string[];
  media_type: string;
  byte_length: number;
  content_digest: string;
  store_ref: string;
}

export interface OutputArtifactMetadata {
  schema_version: 1;
  run_id: string;
  phase: string;
  branch_id: string | null;
  kind: string;
  operation_id: string;
  version: number;
  producer: string;
  consumer_scope: string[];
  media_type: string;
  parent_ref: ArtifactRef | null;
  upstream_refs: ArtifactRef[];
}

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

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    if (label === "ArtifactRef") refError(`${label} must be an object`);
    contractError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  record: Record<string, unknown>,
  expected: readonly string[],
  label: string,
  invalid: (message: string) => never
): void {
  const keys = Object.keys(record);
  const missing = expected.filter((key) => !Object.prototype.hasOwnProperty.call(record, key));
  const unknown = keys.filter((key) => !expected.includes(key));
  if (missing.length) invalid(`${label} missing required fields: ${missing.sort().join(", ")}`);
  if (unknown.length) invalid(`${label} has unknown fields: ${unknown.sort().join(", ")}`);
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function canonicalString(
  value: unknown,
  field: string,
  invalid: (message: string) => never
): string {
  if (
    typeof value !== "string" ||
    !value ||
    value !== value.trim() ||
    hasUnpairedSurrogate(value) ||
    Array.from(value).some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 || code === 127;
    })
  ) {
    invalid(`${field} must be a non-empty canonical string`);
  }
  return value;
}

function positiveInteger(
  value: unknown,
  field: string,
  invalid: (message: string) => never
): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    invalid(`${field} must be a positive integer`);
  }
  return value as number;
}

function nonnegativeInteger(
  value: unknown,
  field: string,
  invalid: (message: string) => never
): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    invalid(`${field} must be a non-negative integer`);
  }
  return value as number;
}

function compareUnicode(left: string, right: string): number {
  const leftPoints = Array.from(left, (character) => character.codePointAt(0) ?? -1);
  const rightPoints = Array.from(right, (character) => character.codePointAt(0) ?? -1);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const leftPoint = leftPoints[index] ?? -1;
    const rightPoint = rightPoints[index] ?? -1;
    if (leftPoint < rightPoint) return -1;
    if (leftPoint > rightPoint) return 1;
  }
  return leftPoints.length - rightPoints.length;
}

function canonicalStringArray(
  value: unknown,
  field: string,
  invalid: (message: string) => never
): string[] {
  if (!Array.isArray(value)) invalid(`${field} must be an array`);
  const items = value.map((item, index) => canonicalString(item, `${field}[${index}]`, invalid));
  if (new Set(items).size !== items.length) invalid(`${field} must not contain duplicates`);
  if (items.some((item, index) => index > 0 && compareUnicode(items[index - 1], item) > 0)) {
    invalid(`${field} must use canonical sorted order`);
  }
  return items;
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
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

export function parseArtifactRef(value: unknown): ArtifactRef {
  const record = asObject(value, "ArtifactRef");
  exactKeys(record, ARTIFACT_REF_FIELDS, "ArtifactRef", refError);
  if (record.schema_version !== OUTPUT_ARTIFACT_SCHEMA_VERSION) {
    refError("unsupported ArtifactRef schema version");
  }
  const artifactId = canonicalString(record.artifact_id, "artifact_id", refError);
  const runId = canonicalString(record.run_id, "run_id", refError);
  const phase = canonicalString(record.phase, "phase", refError);
  const branchId =
    record.branch_id === null ? null : canonicalString(record.branch_id, "branch_id", refError);
  const kind = canonicalString(record.kind, "kind", refError);
  if (!KIND.test(kind)) refError("kind must use lowercase kebab-case");
  const operationId = canonicalString(record.operation_id, "operation_id", refError);
  const version = positiveInteger(record.version, "version", refError);
  const producer = canonicalString(record.producer, "producer", refError);
  const consumerScope = canonicalStringArray(record.consumer_scope, "consumer_scope", refError);
  const mediaType = canonicalString(record.media_type, "media_type", refError);
  const byteLength = nonnegativeInteger(record.byte_length, "byte_length", refError);
  const contentDigest = canonicalString(record.content_digest, "content_digest", refError);
  const storeRef = canonicalString(record.store_ref, "store_ref", refError);

  if (!ARTIFACT_ID.test(artifactId)) refError("artifact_id is not canonical");
  if (!DIGEST.test(contentDigest)) refError("content_digest is not canonical lowercase SHA-256");
  if (!STORE_REF.test(storeRef) || storeRef !== `artifact://sha256/${contentDigest}`) {
    refError("store_ref does not match content_digest");
  }

  const ref: ArtifactRef = {
    schema_version: 1,
    artifact_id: artifactId,
    run_id: runId,
    phase,
    branch_id: branchId,
    kind,
    operation_id: operationId,
    version,
    producer,
    consumer_scope: consumerScope,
    media_type: mediaType,
    byte_length: byteLength,
    content_digest: contentDigest,
    store_ref: storeRef,
  };
  if (artifactIdFor(ref) !== artifactId) refError("artifact_id does not match its identity");
  return ref;
}

export function parseOutputArtifactMetadata(
  value: unknown,
  expected?: OutputArtifactExpectation
): OutputArtifactMetadata {
  const record = asObject(value, "output_artifact");
  exactKeys(record, OUTPUT_ARTIFACT_FIELDS, "output_artifact", contractError);
  if (record.schema_version !== OUTPUT_ARTIFACT_SCHEMA_VERSION) {
    contractError("unsupported output_artifact schema version");
  }

  const runId = canonicalString(record.run_id, "output_artifact.run_id", contractError);
  const phase = canonicalString(record.phase, "output_artifact.phase", contractError);
  const branchId =
    record.branch_id === null
      ? null
      : canonicalString(record.branch_id, "output_artifact.branch_id", contractError);
  const kind = canonicalString(record.kind, "output_artifact.kind", contractError);
  if (!KIND.test(kind)) contractError("output_artifact.kind must use lowercase kebab-case");
  const operationId = canonicalString(
    record.operation_id,
    "output_artifact.operation_id",
    contractError
  );
  const version = positiveInteger(record.version, "output_artifact.version", contractError);
  const producer = canonicalString(record.producer, "output_artifact.producer", contractError);
  const consumerScope = canonicalStringArray(
    record.consumer_scope,
    "output_artifact.consumer_scope",
    contractError
  );
  const mediaType = canonicalString(record.media_type, "output_artifact.media_type", contractError);
  const parentRef = record.parent_ref === null ? null : parseArtifactRef(record.parent_ref);
  if (!Array.isArray(record.upstream_refs)) {
    contractError("output_artifact.upstream_refs must be an array");
  }
  const upstreamRefs = record.upstream_refs.map(parseArtifactRef);
  if (new Set(upstreamRefs.map((ref) => ref.artifact_id)).size !== upstreamRefs.length) {
    contractError("output_artifact.upstream_refs must not contain duplicates");
  }
  if (upstreamRefs.some((ref) => ref.run_id !== runId)) {
    contractError("output_artifact.upstream_refs must belong to the same run");
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
    schema_version: 1,
    run_id: runId,
    phase,
    branch_id: branchId,
    kind,
    operation_id: operationId,
    version,
    producer,
    consumer_scope: consumerScope,
    media_type: mediaType,
    parent_ref: parentRef,
    upstream_refs: upstreamRefs,
  };
  const serializedBytes = Buffer.byteLength(canonicalArtifactJson(metadata), "utf8");
  if (serializedBytes > MAX_ARTIFACT_METADATA_BYTES) {
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
  return {
    schema_version: 1,
    artifact_id: artifactIdFor(metadata),
    run_id: metadata.run_id,
    phase: metadata.phase,
    branch_id: metadata.branch_id,
    kind: metadata.kind,
    operation_id: metadata.operation_id,
    version: metadata.version,
    producer: metadata.producer,
    consumer_scope: [...metadata.consumer_scope],
    media_type: metadata.media_type,
    byte_length: bytes.length,
    content_digest: digest,
    store_ref: `artifact://sha256/${digest}`,
  };
}

export function stableArtifactReceiptId(metadataValue: OutputArtifactMetadata | unknown): string {
  const metadata = parseOutputArtifactMetadata(metadataValue);
  const digest = createHash("sha256")
    .update(canonicalArtifactJson(artifactIdentity(metadata)), "utf8")
    .digest("hex");
  return `artifact-receipt:${digest}`;
}

function resolveArtifactRoot(
  env: Readonly<Record<string, string | undefined>> = process.env
): string {
  const explicit = env.PENNY_ARTIFACT_ROOT?.trim();
  if (explicit) {
    if (!isAbsolute(explicit)) {
      throw new ArtifactClientError(
        "ARTIFACT_CONFIG_INVALID",
        "PENNY_ARTIFACT_ROOT must be absolute"
      );
    }
    return resolve(explicit);
  }
  const xdgStateHome = env.XDG_STATE_HOME?.trim();
  if (xdgStateHome) {
    if (!isAbsolute(xdgStateHome)) {
      throw new ArtifactClientError("ARTIFACT_CONFIG_INVALID", "XDG_STATE_HOME must be absolute");
    }
    return join(resolve(xdgStateHome), "penny", "artifacts");
  }
  const home = env.HOME?.trim() || homedir();
  if (!home || !isAbsolute(home)) {
    throw new ArtifactClientError(
      "ARTIFACT_CONFIG_INVALID",
      "No absolute artifact state root is available"
    );
  }
  return join(resolve(home), ".local", "state", "penny", "artifacts");
}

function isWithinRoot(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot);
}

async function assertOwnerPath(
  candidate: string,
  type: "file" | "directory",
  missingCode: ArtifactClientErrorCode
): Promise<void> {
  let stats;
  try {
    stats = await lstat(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ArtifactClientError(missingCode, "artifact owner path is missing");
    }
    throw new ArtifactClientError("ARTIFACT_CONFIG_INVALID", "artifact owner path is inaccessible");
  }
  if (stats.isSymbolicLink()) {
    throw new ArtifactClientError("ARTIFACT_CONFIG_INVALID", "artifact owner path is a symlink");
  }
  if ((type === "file" && !stats.isFile()) || (type === "directory" && !stats.isDirectory())) {
    throw new ArtifactClientError("ARTIFACT_CONFIG_INVALID", "artifact owner path has wrong type");
  }
  if ((stats.mode & 0o077) !== 0) {
    throw new ArtifactClientError(
      "ARTIFACT_CONFIG_INVALID",
      "artifact owner path is not owner-only"
    );
  }
  if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
    throw new ArtifactClientError("ARTIFACT_CONFIG_INVALID", "artifact owner path has wrong owner");
  }
}

/** Read and independently verify exact artifact bytes as the execution owner. */
export async function readArtifactOutput(input: {
  ref: ArtifactRef | unknown;
  env?: Readonly<Record<string, string | undefined>>;
}): Promise<Buffer> {
  const ref = parseArtifactRef(input.ref);
  const root = resolveArtifactRoot(input.env);
  await assertOwnerPath(root, "directory", "ARTIFACT_MISSING");
  const canonicalRoot = await realpath(root);
  const objects = join(canonicalRoot, "objects");
  const sha256 = join(objects, "sha256");
  const shard = join(sha256, ref.content_digest.slice(0, 2));
  for (const directory of [objects, sha256, shard]) {
    await assertOwnerPath(directory, "directory", "ARTIFACT_MISSING");
  }
  const objectPath = join(shard, ref.content_digest.slice(2));
  await assertOwnerPath(objectPath, "file", "ARTIFACT_MISSING");
  const canonicalObject = await realpath(objectPath);
  if (!isWithinRoot(canonicalRoot, canonicalObject)) {
    throw new ArtifactClientError("ARTIFACT_CONFIG_INVALID", "artifact object escapes its root");
  }
  const content = await readFile(canonicalObject);
  const digest = createHash("sha256").update(content).digest("hex");
  if (digest !== ref.content_digest || content.length !== ref.byte_length) {
    throw new ArtifactClientError(
      "ARTIFACT_DIGEST_MISMATCH",
      "artifact exact-byte verification failed",
      { artifactId: ref.artifact_id }
    );
  }
  return content;
}

/** Persist exact output bytes through the TypeScript artifact owner. */
export async function persistArtifactOutput(input: {
  metadata: OutputArtifactMetadata | unknown;
  output: string | Buffer;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<ArtifactRef> {
  const metadata = parseOutputArtifactMetadata(input.metadata);
  if (metadata.kind !== "agent-output") {
    contractError("TypeScript artifact persistence accepts agent-output artifacts only");
  }
  const outputBytes = Buffer.isBuffer(input.output)
    ? Buffer.from(input.output)
    : Buffer.from(input.output, "utf8");
  try {
    using store = new ArtifactStore(resolveArtifactRoot(input.env));
    const ref = parseArtifactRef(
      store.persist({
        metadata: metadata as TypeScriptOutputArtifactMetadata,
        content: outputBytes,
      })
    );
    const expected = expectedArtifactRef(metadata, outputBytes);
    if (canonicalArtifactJson(ref) !== canonicalArtifactJson(expected)) {
      refError("TypeScript artifact owner returned a ref that does not match exact output bytes");
    }
    return ref;
  } catch (error) {
    if (error instanceof ArtifactClientError) throw error;
    throw new ArtifactClientError(
      "ARTIFACT_PERSIST_FAILED",
      "TypeScript artifact persistence failed",
      { operationId: metadata.operation_id, version: metadata.version }
    );
  }
}
