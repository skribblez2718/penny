import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";

import {
  PLATFORM_MEMORY_CONTRACT_VERSION,
  PlatformMemoryError,
  type MemoryCredentialReference,
  type PlatformMemoryCapability,
  type PlatformMemoryConfigV1,
  type ValidatedPlatformMemoryConfigV1,
} from "./types.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_READ_ATTEMPTS = 3;
const DEFAULT_MAX_REQUEST_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MIN_TRANSPORT_BYTES = 65_536;
const MIN_SECRET_BYTES = 32;
const MAX_SECRET_BYTES = 4_096;
const MAX_IDENTIFIER_CHARACTERS = 1_024;
const ENVIRONMENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

const CAPABILITIES: ReadonlySet<string> = new Set([
  "recall-read",
  "curated-write",
  "kg-read",
  "kg-write",
  "primary-diary",
]);

function configError(message: string): never {
  throw new PlatformMemoryError("MEMORY_CONFIG_INVALID", message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) configError(`${label} must be an object`);
  return value;
}

function isPlatformMemoryCapability(value: unknown): value is PlatformMemoryCapability {
  return typeof value === "string" && CAPABILITIES.has(value);
}

function assertExactKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  label: string
): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(record).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) configError(`${label} contains unsupported fields`);
}

function boundedIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string") configError(`${label} must be a string`);
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > MAX_IDENTIFIER_CHARACTERS ||
    hasControlCharacter(normalized)
  ) {
    configError(`${label} must be a bounded non-empty identifier`);
  }
  return normalized;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? -1;
    if (codePoint < 32 || codePoint === 127) return true;
  }
  return false;
}

function normalizeEndpoint(value: unknown): string {
  const raw = boundedIdentifier(value, "target.endpoint");
  let endpoint: URL;
  try {
    endpoint = new URL(raw);
  } catch {
    configError("target.endpoint must be an absolute HTTP(S) URL");
  }
  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
    configError("target.endpoint must use HTTP or HTTPS");
  }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    configError("target.endpoint cannot contain credentials, query, or fragment");
  }
  if (endpoint.pathname !== "/" && endpoint.pathname !== "" && endpoint.pathname !== "/mcp") {
    configError("target.endpoint path must be /mcp or empty");
  }
  endpoint.pathname = "/mcp";
  return endpoint.toString();
}

function parsePositiveInteger(
  value: unknown,
  label: string,
  defaultValue: number,
  minimum: number,
  maximum: number
): number {
  if (value === undefined) return defaultValue;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    configError(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function validateCredential(value: unknown): MemoryCredentialReference {
  const credential = asRecord(value, "credential");
  if (credential.kind === "environment") {
    assertExactKeys(credential, ["kind", "name"], "credential");
    if (typeof credential.name !== "string" || !ENVIRONMENT_NAME_PATTERN.test(credential.name)) {
      configError("credential.name must name an environment variable");
    }
    return { kind: "environment", name: credential.name };
  }
  if (credential.kind === "file") {
    assertExactKeys(credential, ["kind", "path"], "credential");
    if (typeof credential.path !== "string" || !isAbsolute(credential.path)) {
      configError("credential.path must be an absolute caller-supplied path");
    }
    return { kind: "file", path: credential.path };
  }
  configError("credential.kind must be environment or file");
}

function validateCapabilities(value: unknown, primaryDiaryId: unknown): PlatformMemoryCapability[] {
  if (!Array.isArray(value)) configError("capabilities must be an array");
  const capabilities: PlatformMemoryCapability[] = [];
  for (const capability of value) {
    if (!isPlatformMemoryCapability(capability)) {
      configError("capabilities contains an unsupported capability");
    }
    if (capabilities.includes(capability)) {
      configError("capabilities cannot contain duplicates");
    }
    capabilities.push(capability);
  }
  const hasDiary = capabilities.includes("primary-diary");
  if (hasDiary) boundedIdentifier(primaryDiaryId, "primaryDiaryId");
  if (!hasDiary && primaryDiaryId !== undefined) {
    configError("primaryDiaryId requires the primary-diary capability");
  }
  return capabilities;
}

function validateEnabledConfig(record: Record<string, unknown>): ValidatedPlatformMemoryConfigV1 {
  assertExactKeys(
    record,
    [
      "contractVersion",
      "mode",
      "principalId",
      "target",
      "credential",
      "trust",
      "custody",
      "capabilities",
      "primaryDiaryId",
      "transport",
    ],
    "config"
  );

  const target = asRecord(record.target, "target");
  assertExactKeys(target, ["endpoint", "palaceId", "dataRootId"], "target");
  const custody = asRecord(record.custody, "custody");
  assertExactKeys(
    custody,
    [
      "ownerId",
      "backupPolicyRef",
      "migrationPolicyRef",
      "retentionPolicyRef",
      "uninstallDisposition",
    ],
    "custody"
  );
  if (custody.uninstallDisposition !== "preserve") {
    configError("custody.uninstallDisposition must be preserve");
  }

  const trust = asRecord(record.trust, "trust");
  if (record.mode === "isolated") {
    assertExactKeys(trust, ["kind", "isolationBoundaryId"], "trust");
    if (trust.kind !== "isolated") configError("isolated mode requires isolated trust settings");
    boundedIdentifier(trust.isolationBoundaryId, "trust.isolationBoundaryId");
  } else {
    assertExactKeys(trust, ["kind", "trustDomainId", "wholePalaceAccessAcknowledged"], "trust");
    if (trust.kind !== "shared-trust-domain" || trust.wholePalaceAccessAcknowledged !== true) {
      configError("shared-trust-domain mode requires explicit whole-palace trust acknowledgement");
    }
    boundedIdentifier(trust.trustDomainId, "trust.trustDomainId");
  }

  const transport = record.transport === undefined ? {} : asRecord(record.transport, "transport");
  assertExactKeys(
    transport,
    ["requestTimeoutMs", "maxReadAttempts", "maxRequestBytes", "maxResponseBytes"],
    "transport"
  );
  const resolvedTransport = {
    requestTimeoutMs: parsePositiveInteger(
      transport.requestTimeoutMs,
      "transport.requestTimeoutMs",
      DEFAULT_REQUEST_TIMEOUT_MS,
      100,
      30_000
    ),
    maxReadAttempts: parsePositiveInteger(
      transport.maxReadAttempts,
      "transport.maxReadAttempts",
      DEFAULT_MAX_READ_ATTEMPTS,
      1,
      3
    ),
    maxRequestBytes: parsePositiveInteger(
      transport.maxRequestBytes,
      "transport.maxRequestBytes",
      DEFAULT_MAX_REQUEST_BYTES,
      MIN_TRANSPORT_BYTES,
      DEFAULT_MAX_REQUEST_BYTES
    ),
    maxResponseBytes: parsePositiveInteger(
      transport.maxResponseBytes,
      "transport.maxResponseBytes",
      DEFAULT_MAX_RESPONSE_BYTES,
      MIN_TRANSPORT_BYTES,
      DEFAULT_MAX_RESPONSE_BYTES
    ),
  };

  const primaryDiaryId =
    record.primaryDiaryId === undefined
      ? undefined
      : boundedIdentifier(record.primaryDiaryId, "primaryDiaryId");
  const capabilities = validateCapabilities(record.capabilities, primaryDiaryId);
  const common = {
    contractVersion: PLATFORM_MEMORY_CONTRACT_VERSION,
    principalId: boundedIdentifier(record.principalId, "principalId"),
    target: {
      endpoint: normalizeEndpoint(target.endpoint),
      palaceId: boundedIdentifier(target.palaceId, "target.palaceId"),
      dataRootId: boundedIdentifier(target.dataRootId, "target.dataRootId"),
    },
    credential: validateCredential(record.credential),
    custody: {
      ownerId: boundedIdentifier(custody.ownerId, "custody.ownerId"),
      backupPolicyRef: boundedIdentifier(custody.backupPolicyRef, "custody.backupPolicyRef"),
      migrationPolicyRef: boundedIdentifier(
        custody.migrationPolicyRef,
        "custody.migrationPolicyRef"
      ),
      retentionPolicyRef: boundedIdentifier(
        custody.retentionPolicyRef,
        "custody.retentionPolicyRef"
      ),
      uninstallDisposition: "preserve" as const,
    },
    capabilities,
    ...(primaryDiaryId === undefined ? {} : { primaryDiaryId }),
    transport: resolvedTransport,
  };

  if (record.mode === "isolated") {
    return {
      ...common,
      mode: "isolated",
      trust: {
        kind: "isolated",
        isolationBoundaryId: boundedIdentifier(
          trust.isolationBoundaryId,
          "trust.isolationBoundaryId"
        ),
      },
    };
  }
  return {
    ...common,
    mode: "shared-trust-domain",
    trust: {
      kind: "shared-trust-domain",
      trustDomainId: boundedIdentifier(trust.trustDomainId, "trust.trustDomainId"),
      wholePalaceAccessAcknowledged: true,
    },
  };
}

export function validatePlatformMemoryConfigV1(value: unknown): ValidatedPlatformMemoryConfigV1 {
  const record = asRecord(value, "config");
  if (record.contractVersion !== PLATFORM_MEMORY_CONTRACT_VERSION) {
    configError(`contractVersion must be ${PLATFORM_MEMORY_CONTRACT_VERSION}`);
  }
  if (record.mode === "none") {
    assertExactKeys(record, ["contractVersion", "mode", "principalId"], "none config");
    return {
      contractVersion: PLATFORM_MEMORY_CONTRACT_VERSION,
      mode: "none",
      principalId: boundedIdentifier(record.principalId, "principalId"),
    };
  }
  if (record.mode !== "isolated" && record.mode !== "shared-trust-domain") {
    configError("mode must be none, isolated, or shared-trust-domain");
  }
  return validateEnabledConfig(record);
}

function credentialReferenceKey(reference: MemoryCredentialReference): string {
  return reference.kind === "environment"
    ? `environment:${reference.name}`
    : `file:${reference.path}`;
}

/**
 * A pair advertised as isolated must not share its routable service, custody
 * identifiers, isolation boundary, or credential reference.
 */
export function assertDistinctIsolatedMemoryConfigsV1(
  leftValue: PlatformMemoryConfigV1,
  rightValue: PlatformMemoryConfigV1
): void {
  const left = validatePlatformMemoryConfigV1(leftValue);
  const right = validatePlatformMemoryConfigV1(rightValue);
  if (left.mode !== "isolated" || right.mode !== "isolated") {
    configError("isolation comparison requires two isolated configs");
  }
  const collisions = [
    left.principalId === right.principalId,
    left.target.endpoint === right.target.endpoint,
    left.target.palaceId === right.target.palaceId,
    left.target.dataRootId === right.target.dataRootId,
    left.trust.isolationBoundaryId === right.trust.isolationBoundaryId,
    credentialReferenceKey(left.credential) === credentialReferenceKey(right.credential),
  ];
  if (collisions.some(Boolean)) {
    configError("isolated configs must have distinct service, root, trust, and credential custody");
  }
}

export function assertValidResolvedMemoryCredential(token: string): string {
  const bytes = Buffer.byteLength(token, "utf8");
  if (bytes < MIN_SECRET_BYTES || bytes > MAX_SECRET_BYTES || hasControlCharacter(token)) {
    configError("memory credential must be a bounded secret of at least 32 UTF-8 bytes");
  }
  return token;
}

export function resolveMemoryCredentialReference(
  reference: MemoryCredentialReference,
  options: { env?: Readonly<Record<string, string | undefined>> } = {}
): string {
  let token: string;
  if (reference.kind === "environment") {
    token = (options.env ?? process.env)[reference.name]?.trim() ?? "";
  } else {
    let stats;
    try {
      stats = lstatSync(reference.path);
    } catch {
      configError("memory credential file is inaccessible");
    }
    if (stats.isSymbolicLink() || !stats.isFile()) {
      configError("memory credential file must be a regular non-symlink file");
    }
    if ((stats.mode & 0o077) !== 0) configError("memory credential file must be owner-only");
    if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
      configError("memory credential file has the wrong owner");
    }
    try {
      token = readFileSync(reference.path, "utf8").trim();
    } catch {
      configError("memory credential file is unreadable");
    }
  }

  return assertValidResolvedMemoryCredential(token);
}
