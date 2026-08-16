import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, readdir, realpath, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import {
  DEFAULT_TOOL_RESULT_BUDGET,
  ToolResultBudgetConfigError,
  ToolResultBudgetError,
  assessReleaseHeadroom,
  createTextToolResult,
  enforceToolResultBudget,
  fitUtf8ToolResult,
  isUtf8Boundary,
  measureToolResult,
  resolveToolResultBudget,
} from "../lib/tool-result-budget.js";
import {
  ARTIFACT_OPERATION,
  ARTIFACT_SCHEMA_VERSION,
  ArtifactReadError,
  type ArtifactCaller,
  type ArtifactErrorCode,
  type ArtifactExecution,
  type ArtifactGrant,
  type ArtifactInvocation,
  type ArtifactLocator,
  type ArtifactReadParams,
  type ArtifactRef,
  type ArtifactRuntimeConfig,
  type ArtifactRuntimeDependencies,
} from "./types.js";

const MAX_CURSOR_TTL_MS = 15 * 60 * 1_000;
const MIN_CURSOR_TTL_MS = 30 * 1_000;
const DEFAULT_MATERIALIZATION_THRESHOLD = 1_048_576;
const MIN_MATERIALIZATION_THRESHOLD = 65_536;
const ARTIFACT_ID_PATTERN = /^art_[a-f0-9]{64}$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const KIND_PATTERN = /^[a-z][a-z0-9-]*$/;
const STORE_REF_PATTERN = /^artifact:\/\/sha256\/[a-f0-9]{64}$/;
const RFC3339_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/;
const CURSOR_MAX_CHARACTERS = 4_096;
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
interface CursorPayload {
  v: 1;
  op: typeof ARTIFACT_OPERATION;
  caller: { r: string; c: string; i: string };
  aid: string;
  aq: string;
  q: string;
  rev: { v: number; d: string };
  range_start: number;
  range_end: number;
  next: number;
  page: number;
  exp: number;
}

interface NormalizedLocator {
  artifactId: string;
  ref?: ArtifactRef;
  queryHash: string;
}

interface Materialization {
  ref: string;
  path: string;
  expiresAt: number;
}

function asObject(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ArtifactReadError("ARTIFACT_CONFIG_INVALID", `${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  name: string
): void {
  const keys = Object.keys(value).sort();
  const allowed = [...expected].sort();
  if (keys.length !== allowed.length || keys.some((key, index) => key !== allowed[index])) {
    throw new ArtifactReadError("ARTIFACT_CONFIG_INVALID", `${name} has invalid fields`);
  }
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

function isPythonWhitespace(codePoint: number): boolean {
  return (
    (codePoint >= 0x0009 && codePoint <= 0x000d) ||
    (codePoint >= 0x001c && codePoint <= 0x0020) ||
    codePoint === 0x0085 ||
    codePoint === 0x00a0 ||
    codePoint === 0x1680 ||
    (codePoint >= 0x2000 && codePoint <= 0x200a) ||
    codePoint === 0x2028 ||
    codePoint === 0x2029 ||
    codePoint === 0x202f ||
    codePoint === 0x205f ||
    codePoint === 0x3000
  );
}

function canonicalString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0 || hasUnpairedSurrogate(value)) {
    throw new ArtifactReadError("ARTIFACT_CONFIG_INVALID", `${name} is invalid`);
  }
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? -1;
    if (codePoint < 32 || codePoint === 127) {
      throw new ArtifactReadError("ARTIFACT_CONFIG_INVALID", `${name} is invalid`);
    }
  }
  const lastCharacter = Array.from(value).at(-1);
  const first = value.codePointAt(0) ?? -1;
  const last = lastCharacter?.codePointAt(0) ?? -1;
  if (isPythonWhitespace(first) || isPythonWhitespace(last)) {
    throw new ArtifactReadError("ARTIFACT_CONFIG_INVALID", `${name} is invalid`);
  }
  return value;
}

function requiredCanonicalString(
  value: Record<string, unknown>,
  key: string,
  name: string,
  pattern?: RegExp
): string {
  const candidate = canonicalString(value[key], `${name}.${key}`);
  if (pattern && !pattern.test(candidate)) {
    throw new ArtifactReadError("ARTIFACT_CONFIG_INVALID", `${name}.${key} is invalid`);
  }
  return candidate;
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

function canonicalStringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value)) {
    throw new ArtifactReadError("ARTIFACT_CONFIG_INVALID", `${name} must be an array`);
  }
  const items = value.map((item, index) => canonicalString(item, `${name}[${index}]`));
  if (new Set(items).size !== items.length) {
    throw new ArtifactReadError("ARTIFACT_CONFIG_INVALID", `${name} contains duplicates`);
  }
  for (let index = 1; index < items.length; index += 1) {
    const previous = items[index - 1] ?? "";
    const current = items[index] ?? "";
    if (compareUnicode(previous, current) > 0) {
      throw new ArtifactReadError(
        "ARTIFACT_CONFIG_INVALID",
        `${name} must use canonical sorted order`
      );
    }
  }
  return items;
}

function parseTimestamp(value: unknown, name: string): number {
  const text = canonicalString(value, name);
  const match = RFC3339_PATTERN.exec(text);
  if (!match) {
    throw new ArtifactReadError("ARTIFACT_CONFIG_INVALID", `${name} must be RFC 3339 UTC`);
  }
  const components = match.slice(1, 7).map((item) => Number(item));
  if (components.length !== 6 || components.some((item) => !Number.isInteger(item))) {
    throw new ArtifactReadError("ARTIFACT_CONFIG_INVALID", `${name} is invalid`);
  }
  const [year = 0, month = 0, day = 0, hour = 0, minute = 0, second = 0] = components;
  if (year < 1 || month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) {
    throw new ArtifactReadError("ARTIFACT_CONFIG_INVALID", `${name} is invalid`);
  }
  const calendar = new Date(0);
  calendar.setUTCFullYear(year, month - 1, day);
  calendar.setUTCHours(hour, minute, second, 0);
  if (
    calendar.getUTCFullYear() !== year ||
    calendar.getUTCMonth() !== month - 1 ||
    calendar.getUTCDate() !== day ||
    calendar.getUTCHours() !== hour ||
    calendar.getUTCMinutes() !== minute ||
    calendar.getUTCSeconds() !== second
  ) {
    throw new ArtifactReadError("ARTIFACT_CONFIG_INVALID", `${name} is invalid`);
  }
  const timestamp = Date.parse(text);
  if (!Number.isFinite(timestamp)) {
    throw new ArtifactReadError("ARTIFACT_CONFIG_INVALID", `${name} is invalid`);
  }
  return timestamp;
}

function positiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new ArtifactReadError("ARTIFACT_CONFIG_INVALID", `${name} must be a positive integer`);
  }
  return value as number;
}

function nonnegativeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ArtifactReadError(
      "ARTIFACT_CONFIG_INVALID",
      `${name} must be a non-negative integer`
    );
  }
  return value as number;
}

/** Compute Python's stable owner identity for the canonical artifact identity tuple. */
export function canonicalArtifactId(
  identity: Pick<
    ArtifactRef,
    "run_id" | "phase" | "branch_id" | "kind" | "operation_id" | "version"
  >
): string {
  const canonicalIdentity = {
    branch_id: identity.branch_id,
    kind: identity.kind,
    operation_id: identity.operation_id,
    phase: identity.phase,
    run_id: identity.run_id,
    version: identity.version,
  };
  return `art_${createHash("sha256").update(JSON.stringify(canonicalIdentity), "utf8").digest("hex")}`;
}

export function parseArtifactRef(value: unknown, name = "artifact ref"): ArtifactRef {
  const record = asObject(value, name);
  assertExactKeys(record, ARTIFACT_REF_FIELDS, name);
  if (record.schema_version !== ARTIFACT_SCHEMA_VERSION) {
    throw new ArtifactReadError("ARTIFACT_CONFIG_INVALID", `${name}.schema_version is unsupported`);
  }

  const artifactId = requiredCanonicalString(record, "artifact_id", name, ARTIFACT_ID_PATTERN);
  const runId = requiredCanonicalString(record, "run_id", name);
  const phase = requiredCanonicalString(record, "phase", name);
  const branchId =
    record.branch_id === null ? null : canonicalString(record.branch_id, `${name}.branch_id`);
  const kind = requiredCanonicalString(record, "kind", name, KIND_PATTERN);
  const operationId = requiredCanonicalString(record, "operation_id", name);
  const version = positiveInteger(record.version, `${name}.version`);
  const producer = requiredCanonicalString(record, "producer", name);
  const consumerScope = canonicalStringArray(record.consumer_scope, `${name}.consumer_scope`);
  const mediaType = requiredCanonicalString(record, "media_type", name);
  const byteLength = nonnegativeInteger(record.byte_length, `${name}.byte_length`);
  const digest = requiredCanonicalString(record, "content_digest", name, DIGEST_PATTERN);
  const storeRef = requiredCanonicalString(record, "store_ref", name, STORE_REF_PATTERN);

  const ref: ArtifactRef = {
    schema_version: ARTIFACT_SCHEMA_VERSION,
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
    content_digest: digest,
    store_ref: storeRef,
  };
  if (artifactId !== canonicalArtifactId(ref)) {
    throw new ArtifactReadError(
      "ARTIFACT_CONFIG_INVALID",
      `${name}.artifact_id does not match its canonical identity`
    );
  }
  if (storeRef !== `artifact://sha256/${digest}`) {
    throw new ArtifactReadError(
      "ARTIFACT_CONFIG_INVALID",
      `${name}.store_ref does not match content_digest`
    );
  }
  return ref;
}

export function artifactRefFromEnvelope(artifact: ArtifactRef): ArtifactRef {
  return {
    schema_version: artifact.schema_version,
    artifact_id: artifact.artifact_id,
    run_id: artifact.run_id,
    phase: artifact.phase,
    branch_id: artifact.branch_id,
    kind: artifact.kind,
    operation_id: artifact.operation_id,
    version: artifact.version,
    producer: artifact.producer,
    consumer_scope: [...artifact.consumer_scope],
    media_type: artifact.media_type,
    byte_length: artifact.byte_length,
    content_digest: artifact.content_digest,
    store_ref: artifact.store_ref,
  };
}

export function parseArtifactInvocation(json: string): ArtifactInvocation {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new ArtifactReadError("ARTIFACT_CONFIG_INVALID", "Invocation context is not valid JSON");
  }

  const invocation = asObject(value, "invocation");
  assertExactKeys(invocation, ["schema_version", "caller", "grants"], "invocation");
  if (invocation.schema_version !== ARTIFACT_SCHEMA_VERSION) {
    throw new ArtifactReadError("ARTIFACT_CONFIG_INVALID", "Invocation schema is unsupported");
  }

  const callerValue = asObject(invocation.caller, "invocation.caller");
  assertExactKeys(callerValue, ["run_id", "consumer_ref", "invocation_id"], "invocation.caller");
  const caller: ArtifactCaller = {
    run_id: requiredCanonicalString(callerValue, "run_id", "invocation.caller"),
    consumer_ref: requiredCanonicalString(callerValue, "consumer_ref", "invocation.caller"),
    invocation_id: requiredCanonicalString(callerValue, "invocation_id", "invocation.caller"),
  };

  if (!Array.isArray(invocation.grants)) {
    throw new ArtifactReadError("ARTIFACT_CONFIG_INVALID", "invocation.grants must be an array");
  }
  const grants = invocation.grants.map((item, index): ArtifactGrant => {
    const grantValue = asObject(item, `invocation.grants[${index}]`);
    assertExactKeys(grantValue, ["artifact", "expires_at"], `invocation.grants[${index}]`);
    const expiresAt = requiredCanonicalString(
      grantValue,
      "expires_at",
      `invocation.grants[${index}]`,
      RFC3339_PATTERN
    );
    parseTimestamp(expiresAt, `invocation.grants[${index}].expires_at`);
    return {
      artifact: parseArtifactRef(grantValue.artifact, `invocation.grants[${index}].artifact`),
      expires_at: expiresAt,
    };
  });
  if (new Set(grants.map((grant) => grant.artifact.artifact_id)).size !== grants.length) {
    throw new ArtifactReadError("ARTIFACT_CONFIG_INVALID", "Artifact grants must be unique");
  }

  return { schema_version: ARTIFACT_SCHEMA_VERSION, caller, grants };
}

function parseBoundedInteger(
  raw: string | undefined,
  name: string,
  defaultValue: number,
  minimum: number,
  maximum: number
): number {
  if (raw === undefined || raw.trim() === "") return defaultValue;
  if (!/^\d+$/.test(raw.trim())) {
    throw new ArtifactReadError("ARTIFACT_CONFIG_INVALID", `${name} must be an integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new ArtifactReadError(
      "ARTIFACT_CONFIG_INVALID",
      `${name} must be between ${minimum} and ${maximum}`
    );
  }
  return value;
}

function parseBoolean(raw: string | undefined, name: string): boolean {
  if (raw === undefined || raw === "" || raw === "false") return false;
  if (raw === "true") return true;
  throw new ArtifactReadError("ARTIFACT_CONFIG_INVALID", `${name} must be true or false`);
}

function parseCursorKey(raw: string | undefined): Buffer {
  if (!raw) {
    throw new ArtifactReadError(
      "ARTIFACT_CONFIG_INVALID",
      "PENNY_ARTIFACT_CURSOR_HMAC_KEY is required"
    );
  }
  let key: Buffer;
  if (/^[a-fA-F0-9]+$/.test(raw) && raw.length % 2 === 0) {
    key = Buffer.from(raw, "hex");
  } else if (/^[A-Za-z0-9_-]+$/.test(raw)) {
    key = Buffer.from(raw, "base64url");
  } else {
    throw new ArtifactReadError("ARTIFACT_CONFIG_INVALID", "Cursor HMAC key encoding is invalid");
  }
  if (key.length < 32) {
    throw new ArtifactReadError("ARTIFACT_CONFIG_INVALID", "Cursor HMAC key is too short");
  }
  return key;
}

function resolveArtifactRoot(env: Readonly<Record<string, string | undefined>>): string {
  const explicit = env.PENNY_ARTIFACT_ROOT?.trim();
  if (explicit) {
    if (!isAbsolute(explicit)) {
      throw new ArtifactReadError(
        "ARTIFACT_CONFIG_INVALID",
        "PENNY_ARTIFACT_ROOT must be absolute"
      );
    }
    return resolve(explicit);
  }

  const xdgStateHome = env.XDG_STATE_HOME?.trim();
  if (xdgStateHome) {
    if (!isAbsolute(xdgStateHome)) {
      throw new ArtifactReadError("ARTIFACT_CONFIG_INVALID", "XDG_STATE_HOME must be absolute");
    }
    return join(xdgStateHome, "penny", "artifacts");
  }

  const home = env.HOME?.trim() || homedir();
  if (!home || !isAbsolute(home)) {
    throw new ArtifactReadError(
      "ARTIFACT_CONFIG_INVALID",
      "No absolute artifact state root is available"
    );
  }
  return join(home, ".local", "state", "penny", "artifacts");
}

export function loadArtifactRuntimeConfig(
  env: Readonly<Record<string, string | undefined>>
): ArtifactRuntimeConfig {
  const invocationJson = env.PENNY_ARTIFACT_INVOCATION_JSON?.trim();
  const invocationFile = env.PENNY_ARTIFACT_INVOCATION_FILE?.trim();
  if ((!invocationJson && !invocationFile) || (invocationJson && invocationFile)) {
    throw new ArtifactReadError(
      "ARTIFACT_CONFIG_INVALID",
      "Exactly one trusted artifact invocation source is required"
    );
  }
  if (invocationFile && !isAbsolute(invocationFile)) {
    throw new ArtifactReadError(
      "ARTIFACT_CONFIG_INVALID",
      "PENNY_ARTIFACT_INVOCATION_FILE must be absolute"
    );
  }

  let budget;
  try {
    budget = resolveToolResultBudget(env);
  } catch (error) {
    if (error instanceof ToolResultBudgetConfigError) {
      throw new ArtifactReadError("ARTIFACT_CONFIG_INVALID", error.message);
    }
    throw error;
  }

  return {
    artifactRoot: resolveArtifactRoot(env),
    invocationJson,
    invocationFile: invocationFile ? resolve(invocationFile) : undefined,
    cursorKey: parseCursorKey(env.PENNY_ARTIFACT_CURSOR_HMAC_KEY),
    cursorTtlMs:
      parseBoundedInteger(
        env.PENNY_ARTIFACT_CURSOR_TTL_SECONDS,
        "PENNY_ARTIFACT_CURSOR_TTL_SECONDS",
        MAX_CURSOR_TTL_MS / 1_000,
        MIN_CURSOR_TTL_MS / 1_000,
        MAX_CURSOR_TTL_MS / 1_000
      ) * 1_000,
    budget,
    materialization: {
      enabled: parseBoolean(
        env.PENNY_ARTIFACT_MATERIALIZATION_ENABLED,
        "PENNY_ARTIFACT_MATERIALIZATION_ENABLED"
      ),
      thresholdBytes: parseBoundedInteger(
        env.PENNY_ARTIFACT_MATERIALIZATION_THRESHOLD_BYTES,
        "PENNY_ARTIFACT_MATERIALIZATION_THRESHOLD_BYTES",
        DEFAULT_MATERIALIZATION_THRESHOLD,
        MIN_MATERIALIZATION_THRESHOLD,
        DEFAULT_MATERIALIZATION_THRESHOLD
      ),
      ttlMs:
        parseBoundedInteger(
          env.PENNY_ARTIFACT_MATERIALIZATION_TTL_SECONDS,
          "PENNY_ARTIFACT_MATERIALIZATION_TTL_SECONDS",
          MAX_CURSOR_TTL_MS / 1_000,
          MIN_CURSOR_TTL_MS / 1_000,
          MAX_CURSOR_TTL_MS / 1_000
        ) * 1_000,
    },
  };
}

function isOwnerOnly(mode: number): boolean {
  return (mode & 0o077) === 0;
}

async function assertProtectedPath(
  path: string,
  kind: "file" | "directory",
  label: string
): Promise<void> {
  let stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new ArtifactReadError(
        label === "artifact object" ? "ARTIFACT_MISSING" : "ARTIFACT_CONFIG_INVALID",
        `${label} is missing`
      );
    }
    throw new ArtifactReadError("ARTIFACT_CONFIG_INVALID", `${label} is inaccessible`);
  }
  if (stats.isSymbolicLink()) {
    throw new ArtifactReadError("ARTIFACT_CONFIG_INVALID", `${label} cannot be a symbolic link`);
  }
  if ((kind === "file" && !stats.isFile()) || (kind === "directory" && !stats.isDirectory())) {
    throw new ArtifactReadError("ARTIFACT_CONFIG_INVALID", `${label} has the wrong type`);
  }
  if (!isOwnerOnly(stats.mode)) {
    throw new ArtifactReadError("ARTIFACT_CONFIG_INVALID", `${label} must be owner-only`);
  }
  if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
    throw new ArtifactReadError("ARTIFACT_CONFIG_INVALID", `${label} has the wrong owner`);
  }
}

async function loadInvocation(config: ArtifactRuntimeConfig): Promise<ArtifactInvocation> {
  if (config.invocationJson !== undefined) return parseArtifactInvocation(config.invocationJson);
  if (!config.invocationFile) {
    throw new ArtifactReadError("ARTIFACT_CONFIG_INVALID", "Invocation context is missing");
  }
  await assertProtectedPath(config.invocationFile, "file", "invocation context");
  return parseArtifactInvocation(await readFile(config.invocationFile, "utf8"));
}

function normalizeLocator(locator: ArtifactLocator): NormalizedLocator {
  if (typeof locator === "string") {
    if (!ARTIFACT_ID_PATTERN.test(locator)) {
      throw new ArtifactReadError("ARTIFACT_NOT_GRANTED", "Artifact is not granted");
    }
    return {
      artifactId: locator,
      queryHash: sha256Json({ artifact_id: locator }),
    };
  }
  const ref = parseArtifactRef(locator, "artifact ref");
  return {
    artifactId: ref.artifact_id,
    ref,
    queryHash: sha256Json(ref),
  };
}

function sha256Json(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function validateGrant(
  invocation: ArtifactInvocation,
  locator: NormalizedLocator,
  now: number
): ArtifactGrant {
  const grant = invocation.grants.find(
    (candidate) => candidate.artifact.artifact_id === locator.artifactId
  );
  if (!grant) {
    throw new ArtifactReadError("ARTIFACT_NOT_GRANTED", "Artifact is not granted");
  }
  const artifact = grant.artifact;
  if (
    artifact.run_id !== invocation.caller.run_id ||
    (locator.ref?.run_id !== undefined && locator.ref.run_id !== invocation.caller.run_id)
  ) {
    throw new ArtifactReadError("ARTIFACT_WRONG_RUN", "Artifact belongs to another run");
  }
  if (!artifact.consumer_scope.includes(invocation.caller.consumer_ref)) {
    throw new ArtifactReadError(
      "ARTIFACT_WRONG_CONSUMER",
      "Artifact is not granted to this consumer"
    );
  }
  if (parseTimestamp(grant.expires_at, "grant.expires_at") <= now) {
    throw new ArtifactReadError("ARTIFACT_STALE", "Artifact grant is stale");
  }
  if (
    locator.ref &&
    JSON.stringify(locator.ref) !== JSON.stringify(artifactRefFromEnvelope(artifact))
  ) {
    throw new ArtifactReadError("ARTIFACT_STALE", "Artifact ref is stale");
  }
  return grant;
}

/** Resolve a canonical store URI to Python's sharded objects/sha256 path. */
export function resolveArtifactObjectPath(root: string, storeRef: string): string {
  if (!STORE_REF_PATTERN.test(storeRef)) {
    throw new ArtifactReadError("ARTIFACT_CONFIG_INVALID", "Artifact store_ref is invalid");
  }
  const digest = storeRef.slice("artifact://sha256/".length);
  const path = join(root, "objects", "sha256", digest.slice(0, 2), digest.slice(2));
  if (!isWithinRoot(root, path)) {
    throw new ArtifactReadError("ARTIFACT_CONFIG_INVALID", "Artifact object escapes its root");
  }
  return path;
}

function isWithinRoot(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot);
}

async function readAndVerifyArtifact(
  config: ArtifactRuntimeConfig,
  artifact: ArtifactRef
): Promise<Buffer> {
  await assertProtectedPath(config.artifactRoot, "directory", "artifact root");
  const rootReal = await realpath(config.artifactRoot);
  const objectsRoot = join(rootReal, "objects");
  const sha256Root = join(objectsRoot, "sha256");
  const shardRoot = join(sha256Root, artifact.content_digest.slice(0, 2));
  await assertProtectedPath(objectsRoot, "directory", "artifact objects root");
  await assertProtectedPath(sha256Root, "directory", "artifact sha256 root");
  await assertProtectedPath(shardRoot, "directory", "artifact digest shard");
  const path = resolveArtifactObjectPath(rootReal, artifact.store_ref);
  await assertProtectedPath(path, "file", "artifact object");
  const objectReal = await realpath(path);
  if (!isWithinRoot(rootReal, objectReal)) {
    throw new ArtifactReadError("ARTIFACT_CONFIG_INVALID", "Artifact object escapes its root");
  }

  const content = await readFile(objectReal);
  const digest = createHash("sha256").update(content).digest("hex");
  if (digest !== artifact.content_digest || content.length !== artifact.byte_length) {
    throw new ArtifactReadError(
      "ARTIFACT_DIGEST_MISMATCH",
      "Artifact integrity verification failed"
    );
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    throw new ArtifactReadError("ARTIFACT_ENCODING_INVALID", "Artifact is not valid UTF-8");
  }
  return content;
}

function encodeCursor(payload: CursorPayload, key: Buffer): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", key).update(body).digest("base64url");
  return `${body}.${signature}`;
}

function parseCursorPayload(value: unknown): CursorPayload {
  const payload = asObject(value, "cursor");
  assertExactKeys(
    payload,
    [
      "v",
      "op",
      "caller",
      "aid",
      "aq",
      "q",
      "rev",
      "range_start",
      "range_end",
      "next",
      "page",
      "exp",
    ],
    "cursor"
  );
  const caller = asObject(payload.caller, "cursor.caller");
  assertExactKeys(caller, ["r", "c", "i"], "cursor.caller");
  const revision = asObject(payload.rev, "cursor.rev");
  assertExactKeys(revision, ["v", "d"], "cursor.rev");
  if (
    payload.v !== 1 ||
    payload.op !== ARTIFACT_OPERATION ||
    typeof payload.aid !== "string" ||
    typeof payload.aq !== "string" ||
    !DIGEST_PATTERN.test(payload.aq) ||
    typeof payload.q !== "string" ||
    !DIGEST_PATTERN.test(payload.q) ||
    typeof caller.r !== "string" ||
    typeof caller.c !== "string" ||
    typeof caller.i !== "string" ||
    typeof revision.v !== "number" ||
    !Number.isSafeInteger(revision.v) ||
    revision.v < 1 ||
    typeof revision.d !== "string" ||
    !DIGEST_PATTERN.test(revision.d) ||
    typeof payload.range_start !== "number" ||
    !Number.isSafeInteger(payload.range_start) ||
    typeof payload.range_end !== "number" ||
    !Number.isSafeInteger(payload.range_end) ||
    typeof payload.next !== "number" ||
    !Number.isSafeInteger(payload.next) ||
    typeof payload.page !== "number" ||
    !Number.isSafeInteger(payload.page) ||
    typeof payload.exp !== "number" ||
    !Number.isSafeInteger(payload.exp)
  ) {
    throw new ArtifactReadError("ARTIFACT_CURSOR_INVALID", "Artifact cursor is invalid");
  }
  return {
    v: 1,
    op: ARTIFACT_OPERATION,
    caller: { r: caller.r, c: caller.c, i: caller.i },
    aid: payload.aid,
    aq: payload.aq,
    q: payload.q,
    rev: { v: revision.v, d: revision.d },
    range_start: payload.range_start,
    range_end: payload.range_end,
    next: payload.next,
    page: payload.page,
    exp: payload.exp,
  };
}

function decodeCursor(cursor: string, key: Buffer): CursorPayload {
  if (cursor.length === 0 || cursor.length > CURSOR_MAX_CHARACTERS) {
    throw new ArtifactReadError("ARTIFACT_CURSOR_INVALID", "Artifact cursor is invalid");
  }
  const [body, suppliedSignature, extra] = cursor.split(".");
  if (!body || !suppliedSignature || extra !== undefined || !/^[A-Za-z0-9_-]+$/.test(body)) {
    throw new ArtifactReadError("ARTIFACT_CURSOR_INVALID", "Artifact cursor is invalid");
  }
  const expected = Buffer.from(createHmac("sha256", key).update(body).digest("base64url"));
  const supplied = Buffer.from(suppliedSignature);
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
    throw new ArtifactReadError("ARTIFACT_CURSOR_INVALID", "Artifact cursor is invalid");
  }

  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    throw new ArtifactReadError("ARTIFACT_CURSOR_INVALID", "Artifact cursor is invalid");
  }
  return parseCursorPayload(value);
}

function validateCursor(
  cursor: string,
  config: ArtifactRuntimeConfig,
  invocation: ArtifactInvocation,
  locator: NormalizedLocator,
  artifact: ArtifactRef,
  now: number
): CursorPayload {
  const payload = decodeCursor(cursor, config.cursorKey);
  if (payload.caller.r !== invocation.caller.run_id) {
    throw new ArtifactReadError("ARTIFACT_WRONG_RUN", "Cursor belongs to another run");
  }
  if (payload.caller.c !== invocation.caller.consumer_ref) {
    throw new ArtifactReadError("ARTIFACT_WRONG_CONSUMER", "Cursor belongs to another consumer");
  }
  if (payload.caller.i !== invocation.caller.invocation_id) {
    throw new ArtifactReadError("ARTIFACT_CURSOR_INVALID", "Cursor belongs to another invocation");
  }
  if (payload.exp <= now) {
    throw new ArtifactReadError("ARTIFACT_CURSOR_EXPIRED", "Artifact cursor has expired");
  }
  if (payload.aid !== artifact.artifact_id || payload.aq !== locator.queryHash) {
    throw new ArtifactReadError("ARTIFACT_CURSOR_INVALID", "Cursor query binding is invalid");
  }
  if (payload.rev.v !== artifact.version || payload.rev.d !== artifact.content_digest) {
    throw new ArtifactReadError("ARTIFACT_STALE", "Artifact cursor is stale");
  }
  const expectedQueryHash = sha256Json({
    operation: ARTIFACT_OPERATION,
    artifact_query_hash: payload.aq,
    requested_range: { start: payload.range_start, end: payload.range_end },
  });
  if (expectedQueryHash !== payload.q) {
    throw new ArtifactReadError("ARTIFACT_CURSOR_INVALID", "Cursor query binding is invalid");
  }
  if (
    payload.range_start < 0 ||
    payload.range_end < payload.range_start ||
    payload.range_end > artifact.byte_length ||
    payload.next < payload.range_start ||
    payload.next >= payload.range_end ||
    payload.page < 1
  ) {
    throw new ArtifactReadError("ARTIFACT_CURSOR_INVALID", "Artifact cursor range is invalid");
  }
  return payload;
}

function validateRange(
  source: Buffer,
  range: ArtifactReadParams["range"]
): { start: number; end: number } {
  const start = range?.start ?? 0;
  const end = range?.end ?? source.length;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start ||
    end > source.length ||
    !isUtf8Boundary(source, start) ||
    !isUtf8Boundary(source, end)
  ) {
    throw new ArtifactReadError(
      "ARTIFACT_RANGE_INVALID",
      "Artifact byte range must use valid UTF-8 boundaries"
    );
  }
  return { start, end };
}

function makeCursorPayload(options: {
  invocation: ArtifactInvocation;
  locator: NormalizedLocator;
  artifact: ArtifactRef;
  rangeStart: number;
  rangeEnd: number;
  next: number;
  page: number;
  expiresAt: number;
}): CursorPayload {
  const queryHash = sha256Json({
    operation: ARTIFACT_OPERATION,
    artifact_query_hash: options.locator.queryHash,
    requested_range: { start: options.rangeStart, end: options.rangeEnd },
  });
  return {
    v: 1,
    op: ARTIFACT_OPERATION,
    caller: {
      r: options.invocation.caller.run_id,
      c: options.invocation.caller.consumer_ref,
      i: options.invocation.caller.invocation_id,
    },
    aid: options.artifact.artifact_id,
    aq: options.locator.queryHash,
    q: queryHash,
    rev: { v: options.artifact.version, d: options.artifact.content_digest },
    range_start: options.rangeStart,
    range_end: options.rangeEnd,
    next: options.next,
    page: options.page,
    exp: options.expiresAt,
  };
}

async function cleanupExpiredMaterializations(directory: string, now: number): Promise<void> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  await Promise.all(
    names.map(async (name) => {
      const match = /^(\d+)-[a-f0-9]{32}\.artifact$/.exec(name);
      if (match && Number(match[1]) <= now) {
        await rm(join(directory, name), { force: true });
      }
    })
  );
}

async function materializeArtifact(options: {
  config: ArtifactRuntimeConfig;
  content: Buffer;
  now: number;
  grantExpiresAt: number;
}): Promise<Materialization> {
  const directory = join(options.config.artifactRoot, "materialized");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  await cleanupExpiredMaterializations(directory, options.now);
  const expiresAt = Math.min(
    options.now + options.config.materialization.ttlMs,
    options.grantExpiresAt
  );
  const path = join(directory, `${expiresAt}-${randomBytes(16).toString("hex")}.artifact`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "wx", 0o600);
    await handle.writeFile(options.content);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(path, 0o600);
    const cleanupTimer = setTimeout(
      () => {
        void rm(path, { force: true }).catch(() => undefined);
      },
      Math.max(0, expiresAt - options.now)
    );
    cleanupTimer.unref();
    return { ref: pathToFileURL(path).href, path, expiresAt };
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(path, { force: true }).catch(() => undefined);
    throw error;
  }
}

function errorExecution(
  code: ArtifactErrorCode,
  message: string,
  budget = DEFAULT_TOOL_RESULT_BUDGET
): ArtifactExecution {
  const result = createTextToolResult(
    {
      schema_version: ARTIFACT_SCHEMA_VERSION,
      ok: false,
      type: "artifact_error",
      error: { code, message, retryable: false },
    },
    { isError: true }
  );
  try {
    enforceToolResultBudget(result, budget);
  } catch {
    const fallback = createTextToolResult(
      { ok: false, error: { code: "ARTIFACT_RESULT_BUDGET_EXCEEDED" } },
      { isError: true }
    );
    enforceToolResultBudget(fallback, budget);
    return { result: fallback, code: "ARTIFACT_RESULT_BUDGET_EXCEEDED" };
  }
  return { result, code };
}

function errorFromUnknown(error: unknown, config: ArtifactRuntimeConfig): ArtifactExecution {
  if (error instanceof ArtifactReadError) {
    return errorExecution(error.code, error.message, config.budget);
  }
  if (error instanceof ToolResultBudgetError) {
    return errorExecution(
      "ARTIFACT_RESULT_BUDGET_EXCEEDED",
      "Artifact result cannot fit the configured budget",
      config.budget
    );
  }
  return errorExecution("ARTIFACT_MISSING", "Artifact could not be read", config.budget);
}

export async function executeArtifactRead(
  config: ArtifactRuntimeConfig,
  params: ArtifactReadParams,
  dependencies: ArtifactRuntimeDependencies = {}
): Promise<ArtifactExecution> {
  const startedAt = Date.now();
  const now = dependencies.now?.() ?? startedAt;
  const telemetry = dependencies.telemetry;
  let artifactId: string | undefined;
  let materializationPath: string | undefined;

  try {
    if (params.cursor !== undefined && params.range !== undefined) {
      throw new ArtifactReadError("ARTIFACT_RANGE_INVALID", "Range and cursor cannot be combined");
    }
    const locator = normalizeLocator(params.artifact);
    artifactId = locator.artifactId;
    const invocation = await loadInvocation(config);
    const grant = validateGrant(invocation, locator, now);
    const artifact = grant.artifact;
    const cursorPayload = params.cursor
      ? validateCursor(params.cursor, config, invocation, locator, artifact, now)
      : undefined;
    const content = await readAndVerifyArtifact(config, artifact);
    const grantExpiresAt = parseTimestamp(grant.expires_at, "grant.expires_at");

    if (
      config.materialization.enabled &&
      content.length > config.materialization.thresholdBytes &&
      params.cursor === undefined &&
      params.range === undefined
    ) {
      let materialization: Materialization;
      try {
        materialization = await materializeArtifact({
          config,
          content,
          now,
          grantExpiresAt,
        });
        materializationPath = materialization.path;
      } catch {
        throw new ArtifactReadError(
          "ARTIFACT_MATERIALIZATION_FAILED",
          "Protected artifact materialization failed"
        );
      }
      const result = createTextToolResult({
        schema_version: ARTIFACT_SCHEMA_VERSION,
        ok: true,
        type: "artifact_materialization",
        artifact_ref: artifactRefFromEnvelope(artifact),
        media_type: artifact.media_type,
        total_bytes: artifact.byte_length,
        returned_range: { start: 0, end: 0 },
        returned_bytes: 0,
        content_digest: artifact.content_digest,
        materialization: {
          ref: materialization.ref,
          byte_length: artifact.byte_length,
          content_digest: artifact.content_digest,
          expires_at: new Date(materialization.expiresAt).toISOString(),
        },
      });
      const measurement = enforceToolResultBudget(result, config.budget);
      telemetry?.info("artifact_read_succeeded", {
        artifactId: artifact.artifact_id,
        runId: artifact.run_id,
        consumerRef: invocation.caller.consumer_ref,
        version: artifact.version,
        contentDigest: artifact.content_digest,
        totalBytes: artifact.byte_length,
        returnedStart: 0,
        returnedEnd: 0,
        serializedBytes: measurement.bytes,
        estimatedTokens: measurement.estimatedTokens,
        releaseHeadroom: assessReleaseHeadroom(measurement.estimatedTokens),
        compactionCorrelation: {
          status: "not_evaluated",
          keys: [`run:${artifact.run_id}`],
        },
        mode: "materialization",
        durationMs: Date.now() - startedAt,
      });
      return { result, code: "OK" };
    }

    let rangeStart: number;
    let rangeEnd: number;
    let page: number;
    if (cursorPayload) {
      rangeStart = cursorPayload.next;
      rangeEnd = cursorPayload.range_end;
      page = cursorPayload.page;
      if (!isUtf8Boundary(content, rangeStart) || !isUtf8Boundary(content, rangeEnd)) {
        throw new ArtifactReadError("ARTIFACT_CURSOR_INVALID", "Cursor UTF-8 range is invalid");
      }
    } else {
      const range = validateRange(content, params.range);
      rangeStart = range.start;
      rangeEnd = range.end;
      page = 1;
    }
    const originalRangeStart = cursorPayload?.range_start ?? rangeStart;
    const cursorExpiresAt = Math.min(now + config.cursorTtlMs, grantExpiresAt);

    const fitted = fitUtf8ToolResult({
      source: content,
      start: rangeStart,
      end: rangeEnd,
      budget: config.budget,
      build: (returnedEnd, text, truncated) => {
        const nextCursor = truncated
          ? encodeCursor(
              makeCursorPayload({
                invocation,
                locator,
                artifact,
                rangeStart: originalRangeStart,
                rangeEnd,
                next: returnedEnd,
                page: page + 1,
                expiresAt: cursorExpiresAt,
              }),
              config.cursorKey
            )
          : null;
        return createTextToolResult({
          schema_version: ARTIFACT_SCHEMA_VERSION,
          ok: true,
          type: "artifact_read",
          artifact_ref: artifactRefFromEnvelope(artifact),
          phase: artifact.phase,
          kind: artifact.kind,
          producer: artifact.producer,
          media_type: artifact.media_type,
          total_bytes: artifact.byte_length,
          requested_range: { start: originalRangeStart, end: rangeEnd },
          returned_range: { start: rangeStart, end: returnedEnd },
          returned_bytes: returnedEnd - rangeStart,
          content_digest: artifact.content_digest,
          content: text,
          truncated,
          continuation: truncated
            ? {
                cursor: nextCursor,
                next_range: { start: returnedEnd, end: rangeEnd },
                expires_at: new Date(cursorExpiresAt).toISOString(),
                page: page + 1,
              }
            : null,
        });
      },
    });

    telemetry?.info("artifact_read_succeeded", {
      artifactId: artifact.artifact_id,
      runId: artifact.run_id,
      consumerRef: invocation.caller.consumer_ref,
      version: artifact.version,
      contentDigest: artifact.content_digest,
      totalBytes: artifact.byte_length,
      returnedStart: rangeStart,
      returnedEnd: fitted.end,
      serializedBytes: fitted.measurement.bytes,
      estimatedTokens: fitted.measurement.estimatedTokens,
      releaseHeadroom: assessReleaseHeadroom(fitted.measurement.estimatedTokens),
      compactionCorrelation: {
        status: "not_evaluated",
        keys: [`run:${artifact.run_id}`],
      },
      mode: "inline",
      truncated: fitted.truncated,
      durationMs: Date.now() - startedAt,
    });
    return { result: fitted.result, code: "OK" };
  } catch (error) {
    if (materializationPath) {
      try {
        await rm(materializationPath, { force: true });
      } catch {
        telemetry?.warn("artifact_materialization_cleanup_failed", {
          artifactId,
          errorCode: "ARTIFACT_MATERIALIZATION_FAILED",
        });
      }
    }
    const execution = errorFromUnknown(error, config);
    const measurement = measureToolResult(execution.result);
    telemetry?.warn("artifact_read_failed", {
      artifactId,
      errorCode: execution.code,
      serializedBytes: measurement.bytes,
      estimatedTokens: measurement.estimatedTokens,
      releaseHeadroom: assessReleaseHeadroom(measurement.estimatedTokens),
      compactionCorrelation: {
        status: "not_evaluated",
        keys: artifactId ? [`artifact:${artifactId}`] : [],
      },
      durationMs: Date.now() - startedAt,
    });
    return execution;
  }
}

export function configurationErrorResult(error: unknown): ArtifactExecution {
  const message =
    error instanceof ArtifactReadError ? error.message : "Artifact configuration is invalid";
  return errorExecution("ARTIFACT_CONFIG_INVALID", message);
}
