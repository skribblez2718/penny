import { Type, type Static } from "typebox";

import { canonicalJson, sha256 } from "../../../orchestration/dist/canonical-json.js";
import { validateContract } from "../../../orchestration/dist/contracts.js";
import {
  Rfc3339UtcSchema,
  Sha256Schema,
} from "../../../orchestration/dist/skill-contracts/common.js";
import { scaDependencyCoordinateIdV2 } from "./dependency-inventory-v2.js";

const MAX_COORDINATES = 1_000_000;
const MAX_OCCURRENCES = 1_000_000;
const MAX_BATCH_SIZE = 128;
const MAX_BATCHES = Math.ceil(MAX_COORDINATES / MAX_BATCH_SIZE);
const MAX_RESPONSE_BYTES = 134_217_728;
const MAX_REQUEST_BODY_BYTES = 8_388_608;
const MAX_ADVISORIES_PER_COORDINATE = 4_096;
const MAX_ADVISORY_REQUESTS = 4_096;
const MAX_TEXT_BYTES = 4_096;
const OSV_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;

/**
 * This v2 OSV slice remains inactive and unreleased. All in-tree producers, consumers, validators,
 * and tests are updated atomically, so its existing v2 schema IDs are intentionally retained.
 */
export const SCA_OSV_REQUEST_V2_SCHEMA = "penny.sca-osv-request.v2";
export const SCA_OSV_PLAN_V2_SCHEMA = "penny.sca-osv-plan.v2";
export const SCA_OSV_RESULT_V2_SCHEMA = "penny.sca-osv-result.v2";
export const SCA_OSV_V2_ORIGIN = "https://api.osv.dev";
export const SCA_OSV_V2_QUERY_BATCH_URL = `${SCA_OSV_V2_ORIGIN}/v1/querybatch`;

const OsvCoordinateV2Schema = Type.Object(
  {
    coordinate_id: Type.String({ pattern: "^depcoord_[a-f0-9]{64}$" }),
    ecosystem: Type.Union([Type.Literal("npm"), Type.Literal("Packagist")]),
    name: Type.String({ minLength: 1, maxLength: MAX_TEXT_BYTES }),
    version: Type.String({ minLength: 1, maxLength: MAX_TEXT_BYTES }),
  },
  { additionalProperties: false }
);

const CoordinateOccurrencesV2Schema = Type.Object(
  {
    coordinate_id: Type.String({ pattern: "^depcoord_[a-f0-9]{64}$" }),
    occurrence_ids: Type.Array(Type.String({ pattern: "^depocc_[a-f0-9]{64}$" }), {
      minItems: 1,
      maxItems: MAX_OCCURRENCES,
    }),
  },
  { additionalProperties: false }
);

export const ScaOsvRequestV2Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_OSV_REQUEST_V2_SCHEMA),
    schema_version: Type.Literal(2),
    source_snapshot_sha256: Sha256Schema,
    dependency_inventory_sha256: Sha256Schema,
    coordinates: Type.Array(OsvCoordinateV2Schema, { maxItems: MAX_COORDINATES }),
    coordinate_occurrences: Type.Array(CoordinateOccurrencesV2Schema, {
      maxItems: MAX_COORDINATES,
    }),
    network_policy: Type.Union([
      Type.Literal("offline_evidence"),
      Type.Literal("fixed_osv_origin_authorized"),
    ]),
    ip_confinement: Type.Literal("external_worker_required"),
    inactivity_timeout_ms: Type.Integer({ minimum: 1, maximum: 300_000 }),
    max_response_bytes: Type.Integer({ minimum: 1, maximum: MAX_RESPONSE_BYTES }),
    concurrency: Type.Integer({ minimum: 1, maximum: 2 }),
    max_advisory_requests: Type.Integer({ minimum: 0, maximum: MAX_ADVISORY_REQUESTS }),
    max_age_seconds: Type.Union([Type.Integer({ minimum: 1, maximum: 31_536_000 }), Type.Null()]),
  },
  { additionalProperties: false }
);

const OsvBatchPlanV2Schema = Type.Object(
  {
    batch_id: Type.String({ pattern: "^osvbatch_[a-f0-9]{64}$" }),
    batch_index: Type.Integer({ minimum: 0, maximum: MAX_BATCHES - 1 }),
    coordinate_ids: Type.Array(Type.String({ pattern: "^depcoord_[a-f0-9]{64}$" }), {
      minItems: 1,
      maxItems: MAX_BATCH_SIZE,
    }),
    url: Type.Literal(SCA_OSV_V2_QUERY_BATCH_URL),
    method: Type.Literal("POST"),
    request_body: Type.String({ minLength: 1, maxLength: MAX_REQUEST_BODY_BYTES }),
    request_sha256: Sha256Schema,
  },
  { additionalProperties: false }
);

export const ScaOsvPlanV2Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_OSV_PLAN_V2_SCHEMA),
    schema_version: Type.Literal(2),
    dependency_inventory_sha256: Sha256Schema,
    batch_size: Type.Literal(MAX_BATCH_SIZE),
    ip_confinement_prerequisite: Type.Literal("external_worker"),
    batches: Type.Array(OsvBatchPlanV2Schema, { maxItems: MAX_BATCHES }),
    plan_sha256: Sha256Schema,
  },
  { additionalProperties: false }
);

const ResponseEvidenceFields = {
  started_at: Type.Union([Rfc3339UtcSchema, Type.Null()]),
  completed_at: Type.Union([Rfc3339UtcSchema, Type.Null()]),
  fetch_state: Type.Union([
    Type.Literal("not_fetched"),
    Type.Literal("completed"),
    Type.Literal("failed"),
  ]),
  status_code: Type.Union([Type.Integer({ minimum: 100, maximum: 599 }), Type.Null()]),
  final_url: Type.Union([Type.String({ minLength: 1, maxLength: MAX_TEXT_BYTES }), Type.Null()]),
  redirected: Type.Boolean(),
  response_byte_count: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  response_sha256: Type.Union([Sha256Schema, Type.Null()]),
  response_body_base64: Type.Union([
    Type.String({ maxLength: Math.ceil((MAX_RESPONSE_BYTES * 4) / 3) + 4 }),
    Type.Null(),
  ]),
  retention: Type.Union([
    Type.Literal("full_raw_bytes"),
    Type.Literal("digest_only_truncated"),
    Type.Literal("none"),
  ]),
  error_code: Type.Union([
    Type.Literal("none"),
    Type.Literal("transport_failed"),
    Type.Literal("redirect_refused"),
    Type.Literal("http_error"),
    Type.Literal("invalid_response"),
    Type.Literal("response_too_large"),
    Type.Literal("cancelled"),
    Type.Literal("inactivity_timeout"),
  ]),
} as const;

const OsvBatchEvidenceV2Schema = Type.Object(
  {
    batch_id: Type.String({ pattern: "^osvbatch_[a-f0-9]{64}$" }),
    batch_index: Type.Integer({ minimum: 0, maximum: MAX_BATCHES - 1 }),
    coordinate_ids: Type.Array(Type.String({ pattern: "^depcoord_[a-f0-9]{64}$" }), {
      minItems: 1,
      maxItems: MAX_BATCH_SIZE,
    }),
    request_body: Type.String({ minLength: 1, maxLength: MAX_REQUEST_BODY_BYTES }),
    request_sha256: Sha256Schema,
    ...ResponseEvidenceFields,
  },
  { additionalProperties: false }
);

const OsvAdvisoryEvidenceV2Schema = Type.Object(
  {
    advisory_id: Type.String({ minLength: 1, maxLength: 256 }),
    url: Type.String({ minLength: 1, maxLength: MAX_TEXT_BYTES }),
    method: Type.Literal("GET"),
    ...ResponseEvidenceFields,
  },
  { additionalProperties: false }
);

const CoordinateResultV2Schema = Type.Object(
  {
    batch_id: Type.String({ pattern: "^osvbatch_[a-f0-9]{64}$" }),
    batch_index: Type.Integer({ minimum: 0, maximum: MAX_BATCHES - 1 }),
    result_index: Type.Integer({ minimum: 0, maximum: MAX_BATCH_SIZE - 1 }),
    coordinate_id: Type.String({ pattern: "^depcoord_[a-f0-9]{64}$" }),
    advisory_ids: Type.Array(Type.String({ minLength: 1, maxLength: 256 }), {
      maxItems: MAX_ADVISORIES_PER_COORDINATE,
    }),
  },
  { additionalProperties: false }
);

const AdvisoryOccurrencesV2Schema = Type.Object(
  {
    advisory_id: Type.String({ minLength: 1, maxLength: 256 }),
    coordinate_ids: Type.Array(Type.String({ pattern: "^depcoord_[a-f0-9]{64}$" }), {
      minItems: 1,
      maxItems: MAX_COORDINATES,
    }),
    occurrence_ids: Type.Array(Type.String({ pattern: "^depocc_[a-f0-9]{64}$" }), {
      minItems: 1,
      maxItems: MAX_OCCURRENCES,
    }),
  },
  { additionalProperties: false }
);

const ResultErrorCodeV2Schema = Type.Union([
  Type.Literal("none"),
  Type.Literal("network_denied"),
  Type.Literal("ip_confinement_unmet"),
  Type.Literal("transport_failed"),
  Type.Literal("redirect_refused"),
  Type.Literal("http_error"),
  Type.Literal("invalid_response"),
  Type.Literal("response_too_large"),
  Type.Literal("cancelled"),
  Type.Literal("inactivity_timeout"),
  Type.Literal("advisory_limit_exceeded"),
]);

export const ScaOsvResultV2Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_OSV_RESULT_V2_SCHEMA),
    schema_version: Type.Literal(2),
    source_snapshot_sha256: Sha256Schema,
    dependency_inventory_sha256: Sha256Schema,
    plan_sha256: Sha256Schema,
    network_policy: Type.Union([
      Type.Literal("offline_evidence"),
      Type.Literal("fixed_osv_origin_authorized"),
    ]),
    status: Type.Union([
      Type.Literal("succeeded"),
      Type.Literal("partial"),
      Type.Literal("failed"),
      Type.Literal("offline"),
      Type.Literal("denied"),
      Type.Literal("cancelled"),
      Type.Literal("truncated"),
    ]),
    origin: Type.Literal(SCA_OSV_V2_ORIGIN),
    redirects_followed: Type.Literal(0),
    ip_confinement_prerequisite: Type.Literal("external_worker"),
    scheduler_concurrency_limit: Type.Literal(2),
    fetched_at: Type.Union([Rfc3339UtcSchema, Type.Null()]),
    completed_at: Rfc3339UtcSchema,
    max_age_seconds: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
    freshness_at_completion: Type.Union([
      Type.Literal("fresh"),
      Type.Literal("stale"),
      Type.Literal("not_fetched"),
    ]),
    response_bytes_received: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    batches_planned: Type.Integer({ minimum: 0, maximum: MAX_BATCHES }),
    batches_completed: Type.Integer({ minimum: 0, maximum: MAX_BATCHES }),
    advisories_planned: Type.Integer({ minimum: 0, maximum: MAX_ADVISORY_REQUESTS }),
    advisories_completed: Type.Integer({ minimum: 0, maximum: MAX_ADVISORY_REQUESTS }),
    batch_evidence: Type.Array(OsvBatchEvidenceV2Schema, { maxItems: MAX_BATCHES }),
    advisory_evidence: Type.Array(OsvAdvisoryEvidenceV2Schema, {
      maxItems: MAX_ADVISORY_REQUESTS,
    }),
    coordinate_results: Type.Array(CoordinateResultV2Schema, { maxItems: MAX_COORDINATES }),
    advisory_occurrences: Type.Array(AdvisoryOccurrencesV2Schema, { maxItems: 1_000_000 }),
    error_code: ResultErrorCodeV2Schema,
    result_sha256: Sha256Schema,
  },
  { additionalProperties: false }
);

export type ScaOsvRequestV2 = Static<typeof ScaOsvRequestV2Schema>;
export type ScaOsvPlanV2 = Static<typeof ScaOsvPlanV2Schema>;
export type ScaOsvResultV2 = Static<typeof ScaOsvResultV2Schema>;

type Batch = ScaOsvPlanV2["batches"][number];
type BatchEvidence = ScaOsvResultV2["batch_evidence"][number];
type AdvisoryEvidence = ScaOsvResultV2["advisory_evidence"][number];
type CoordinateResult = ScaOsvResultV2["coordinate_results"][number];
type AdvisoryOccurrences = ScaOsvResultV2["advisory_occurrences"][number];
type ResultErrorCode = ScaOsvResultV2["error_code"];
type EvidenceErrorCode = BatchEvidence["error_code"];
type UnsignedPlan = Omit<ScaOsvPlanV2, "plan_sha256">;
type UnsignedResult = Omit<ScaOsvResultV2, "result_sha256">;

export type ScaOsvV2TransportRequest = Readonly<{
  url: string;
  method: "POST" | "GET";
  body: string | null;
  inactivity_timeout_ms: number;
  max_response_bytes: number;
  signal: AbortSignal;
}>;

export interface ScaOsvV2TransportResponse {
  readonly status_code: number;
  readonly final_url: string;
  readonly redirected: boolean;
  readonly body: Buffer;
}

export interface ScaOsvV2Transport {
  /** Enforced requires an independently attested external egress worker; in-process transports report not_enforced. */
  readonly ip_confinement: "external_worker_enforced" | "not_enforced";
  send(request: ScaOsvV2TransportRequest): Promise<ScaOsvV2TransportResponse>;
}

interface ScaOsvV2Scheduler {
  readonly max_concurrency: 2;
  schedule<T>(operation: () => Promise<T>): Promise<T>;
}

export interface ScaOsvV2RunOptions {
  readonly transport?: ScaOsvV2Transport;
  readonly signal?: AbortSignal;
  readonly now?: () => Date;
}

export class ScaOsvV2Error extends Error {
  constructor(
    readonly code:
      | "invalid_request"
      | "coordinate_collision"
      | "mapping_mismatch"
      | "invalid_clock"
      | "semantic_mismatch",
    message: string
  ) {
    super(message);
    this.name = "ScaOsvV2Error";
  }
}

export class ScaOsvV2TransportError extends Error {
  constructor(
    readonly code:
      | "transport_failed"
      | "redirect_refused"
      | "http_error"
      | "response_too_large"
      | "cancelled"
      | "inactivity_timeout",
    message: string
  ) {
    super(message);
    this.name = "ScaOsvV2TransportError";
  }
}

class SharedOsvScheduler implements ScaOsvV2Scheduler {
  readonly max_concurrency = 2 as const;
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  private async acquire(): Promise<void> {
    if (this.active < this.max_concurrency) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next === undefined) this.active -= 1;
    else next();
  }

  async schedule<T>(operation: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await operation();
    } finally {
      this.release();
    }
  }
}

const operationalOsvScheduler: ScaOsvV2Scheduler = new SharedOsvScheduler();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function validateRequest(value: unknown): ScaOsvRequestV2 {
  let request: ScaOsvRequestV2;
  try {
    request = validateContract(ScaOsvRequestV2Schema, value, "SCA OSV v2 request");
  } catch (error) {
    throw new ScaOsvV2Error(
      "invalid_request",
      error instanceof Error ? error.message : "OSV v2 request is invalid"
    );
  }
  if (
    (request.network_policy === "fixed_osv_origin_authorized" &&
      request.max_age_seconds === null) ||
    (request.network_policy === "offline_evidence" && request.max_age_seconds !== null)
  ) {
    throw new ScaOsvV2Error(
      "invalid_request",
      "authorized network lookup requires a positive max_age_seconds; no-expiry policy is offline only"
    );
  }
  const coordinateIds = new Set<string>();
  const coordinateKeys = new Set<string>();
  for (const coordinate of request.coordinates) {
    const expectedId = scaDependencyCoordinateIdV2(
      coordinate.ecosystem,
      coordinate.name,
      coordinate.version
    );
    const key = canonicalJson({
      ecosystem: coordinate.ecosystem,
      name: coordinate.name,
      version: coordinate.version,
    });
    if (
      coordinate.coordinate_id !== expectedId ||
      coordinateIds.has(coordinate.coordinate_id) ||
      coordinateKeys.has(key)
    ) {
      throw new ScaOsvV2Error(
        "coordinate_collision",
        "OSV v2 coordinates must be deduplicated with exact stable identities"
      );
    }
    coordinateIds.add(coordinate.coordinate_id);
    coordinateKeys.add(key);
  }
  if (request.coordinate_occurrences.length !== request.coordinates.length) {
    throw new ScaOsvV2Error(
      "mapping_mismatch",
      "every coordinate must have exactly one occurrence mapping"
    );
  }
  const mappedCoordinates = new Set<string>();
  const mappedOccurrences = new Set<string>();
  let mappedOccurrenceCount = 0;
  for (const mapping of request.coordinate_occurrences) {
    if (!coordinateIds.has(mapping.coordinate_id) || mappedCoordinates.has(mapping.coordinate_id)) {
      throw new ScaOsvV2Error("mapping_mismatch", "coordinate mapping is missing or duplicated");
    }
    mappedCoordinates.add(mapping.coordinate_id);
    for (const occurrenceId of mapping.occurrence_ids) {
      mappedOccurrenceCount += 1;
      if (mappedOccurrenceCount > MAX_OCCURRENCES) {
        throw new ScaOsvV2Error("mapping_mismatch", "occurrence mapping exceeds its total limit");
      }
      if (mappedOccurrences.has(occurrenceId)) {
        throw new ScaOsvV2Error(
          "mapping_mismatch",
          "an occurrence cannot map to more than one coordinate"
        );
      }
      mappedOccurrences.add(occurrenceId);
    }
    if (new Set(mapping.occurrence_ids).size !== mapping.occurrence_ids.length) {
      throw new ScaOsvV2Error("mapping_mismatch", "occurrence mappings must be deduplicated");
    }
  }
  return request;
}

function planDigest(value: UnsignedPlan): string {
  return sha256(canonicalJson(value));
}

export function planScaOsvV2(value: unknown): ScaOsvPlanV2 {
  const request = validateRequest(value);
  const coordinates = [...request.coordinates].sort((left, right) =>
    compareUtf8(left.coordinate_id, right.coordinate_id)
  );
  const batches: Batch[] = [];
  for (let offset = 0; offset < coordinates.length; offset += MAX_BATCH_SIZE) {
    const selected = coordinates.slice(offset, offset + MAX_BATCH_SIZE);
    const batchIndex = batches.length;
    const requestBody = canonicalJson({
      queries: selected.map((coordinate) => ({
        package: { ecosystem: coordinate.ecosystem, name: coordinate.name },
        version: coordinate.version,
      })),
    });
    if (Buffer.byteLength(requestBody, "utf8") > MAX_REQUEST_BODY_BYTES) {
      throw new ScaOsvV2Error("invalid_request", "OSV batch request body exceeds its limit");
    }
    const requestSha256 = sha256(requestBody);
    batches.push({
      batch_id: `osvbatch_${sha256(
        canonicalJson({
          dependency_inventory_sha256: request.dependency_inventory_sha256,
          batch_index: batchIndex,
          request_sha256: requestSha256,
        })
      )}`,
      batch_index: batchIndex,
      coordinate_ids: selected.map((coordinate) => coordinate.coordinate_id),
      url: SCA_OSV_V2_QUERY_BATCH_URL,
      method: "POST",
      request_body: requestBody,
      request_sha256: requestSha256,
    });
  }
  const unsigned: UnsignedPlan = {
    schema_id: SCA_OSV_PLAN_V2_SCHEMA,
    schema_version: 2,
    dependency_inventory_sha256: request.dependency_inventory_sha256,
    batch_size: MAX_BATCH_SIZE,
    ip_confinement_prerequisite: "external_worker",
    batches,
  };
  return validateContract(
    ScaOsvPlanV2Schema,
    { ...unsigned, plan_sha256: planDigest(unsigned) },
    "SCA OSV v2 plan"
  );
}

function strictUtf8(bytes: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ScaOsvV2Error("invalid_request", "OSV response is not strict UTF-8");
  }
}

export function parseScaOsvV2BatchResults(
  batch: Batch,
  bytes: Buffer
): readonly CoordinateResult[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(strictUtf8(bytes));
  } catch (error) {
    if (error instanceof ScaOsvV2Error) throw error;
    throw new ScaOsvV2Error("invalid_request", "OSV batch response is not valid JSON");
  }
  if (
    !isRecord(parsed) ||
    !Array.isArray(parsed.results) ||
    parsed.results.length !== batch.coordinate_ids.length
  ) {
    throw new ScaOsvV2Error(
      "invalid_request",
      "OSV batch response does not correspond to every query index"
    );
  }
  return parsed.results.map((entry, resultIndex) => {
    if (!isRecord(entry)) {
      throw new ScaOsvV2Error("invalid_request", "OSV batch result entry is invalid");
    }
    const vulnerabilities = entry.vulns;
    if (vulnerabilities !== undefined && !Array.isArray(vulnerabilities)) {
      throw new ScaOsvV2Error("invalid_request", "OSV batch vulnerabilities are invalid");
    }
    const advisoryIds = new Set<string>();
    if (Array.isArray(vulnerabilities)) {
      for (const vulnerability of vulnerabilities) {
        if (
          !isRecord(vulnerability) ||
          typeof vulnerability.id !== "string" ||
          !OSV_ID_PATTERN.test(vulnerability.id)
        ) {
          throw new ScaOsvV2Error("invalid_request", "OSV advisory identity is invalid");
        }
        advisoryIds.add(vulnerability.id);
        if (advisoryIds.size > MAX_ADVISORIES_PER_COORDINATE) {
          throw new ScaOsvV2Error("invalid_request", "OSV advisory count exceeds its limit");
        }
      }
    }
    const coordinateId = batch.coordinate_ids[resultIndex];
    if (coordinateId === undefined) {
      throw new ScaOsvV2Error("invalid_request", "OSV result index exceeded its batch");
    }
    return {
      batch_id: batch.batch_id,
      batch_index: batch.batch_index,
      result_index: resultIndex,
      coordinate_id: coordinateId,
      advisory_ids: [...advisoryIds].sort(compareUtf8),
    };
  });
}

function advisoryUrl(advisoryId: string): string {
  return `${SCA_OSV_V2_ORIGIN}/v1/vulns/${encodeURIComponent(advisoryId)}`;
}

function parseAdvisory(advisoryId: string, bytes: Buffer): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(strictUtf8(bytes));
  } catch (error) {
    if (error instanceof ScaOsvV2Error) throw error;
    throw new ScaOsvV2Error("invalid_request", "OSV advisory response is not valid JSON");
  }
  if (!isRecord(parsed) || parsed.id !== advisoryId) {
    throw new ScaOsvV2Error(
      "invalid_request",
      "OSV advisory response does not match its requested advisory ID"
    );
  }
}

class TrustedClock {
  private last = Number.NEGATIVE_INFINITY;
  constructor(private readonly now: () => Date) {}

  sample(): string {
    const value = this.now();
    const milliseconds = value.getTime();
    if (!Number.isFinite(milliseconds) || milliseconds < this.last) {
      throw new ScaOsvV2Error("invalid_clock", "OSV clock is invalid or moved backwards");
    }
    this.last = milliseconds;
    return value.toISOString();
  }
}

function evidenceBase(
  startedAt: string | null,
  completedAt: string | null,
  fetchState: BatchEvidence["fetch_state"],
  errorCode: EvidenceErrorCode
) {
  return {
    started_at: startedAt,
    completed_at: completedAt,
    fetch_state: fetchState,
    status_code: null,
    final_url: null,
    redirected: false,
    response_byte_count: 0,
    response_sha256: null,
    response_body_base64: null,
    retention: "none" as const,
    error_code: errorCode,
  };
}

function responseEvidence(
  response: ScaOsvV2TransportResponse,
  startedAt: string,
  completedAt: string,
  errorCode: EvidenceErrorCode,
  retain: boolean
) {
  return {
    started_at: startedAt,
    completed_at: completedAt,
    fetch_state: "completed" as const,
    status_code: response.status_code,
    final_url: response.final_url,
    redirected: response.redirected,
    response_byte_count: response.body.byteLength,
    response_sha256: sha256(response.body),
    response_body_base64: retain ? response.body.toString("base64") : null,
    retention: retain ? ("full_raw_bytes" as const) : ("digest_only_truncated" as const),
    error_code: errorCode,
  };
}

function transportFailureCode(
  error: unknown,
  callerSignal: AbortSignal | undefined
): EvidenceErrorCode {
  if (callerSignal?.aborted === true) return "cancelled";
  if (error instanceof ScaOsvV2TransportError) return error.code;
  return "transport_failed";
}

function batchFailureCode(response: ScaOsvV2TransportResponse): EvidenceErrorCode | null {
  if (response.redirected || response.final_url !== SCA_OSV_V2_QUERY_BATCH_URL) {
    return "redirect_refused";
  }
  if (response.status_code < 200 || response.status_code >= 300) return "http_error";
  return null;
}

function advisoryFailureCode(
  response: ScaOsvV2TransportResponse,
  expectedUrl: string
): EvidenceErrorCode | null {
  if (response.redirected || response.final_url !== expectedUrl) return "redirect_refused";
  if (response.status_code < 200 || response.status_code >= 300) return "http_error";
  return null;
}

function mapAdvisories(
  results: readonly CoordinateResult[],
  mappings: readonly ScaOsvRequestV2["coordinate_occurrences"][number][]
): AdvisoryOccurrences[] {
  const occurrencesByCoordinate = new Map(
    mappings.map((mapping) => [mapping.coordinate_id, mapping.occurrence_ids])
  );
  const coordinatesByAdvisory = new Map<string, Set<string>>();
  const occurrencesByAdvisory = new Map<string, Set<string>>();
  for (const result of results) {
    const occurrenceIds = occurrencesByCoordinate.get(result.coordinate_id) ?? [];
    for (const advisoryId of result.advisory_ids) {
      const coordinateIds = coordinatesByAdvisory.get(advisoryId) ?? new Set<string>();
      coordinateIds.add(result.coordinate_id);
      coordinatesByAdvisory.set(advisoryId, coordinateIds);
      const advisoryOccurrences = occurrencesByAdvisory.get(advisoryId) ?? new Set<string>();
      for (const occurrenceId of occurrenceIds) advisoryOccurrences.add(occurrenceId);
      occurrencesByAdvisory.set(advisoryId, advisoryOccurrences);
    }
  }
  return [...coordinatesByAdvisory.keys()].sort(compareUtf8).map((advisoryId) => ({
    advisory_id: advisoryId,
    coordinate_ids: [...(coordinatesByAdvisory.get(advisoryId) ?? [])].sort(compareUtf8),
    occurrence_ids: [...(occurrencesByAdvisory.get(advisoryId) ?? [])].sort(compareUtf8),
  }));
}

function resultDigest(value: UnsignedResult): string {
  return sha256(canonicalJson(value));
}

function successfulCompletionTimes(
  batchEvidence: readonly BatchEvidence[],
  advisoryEvidence: readonly AdvisoryEvidence[]
): readonly string[] {
  return [
    ...batchEvidence
      .filter((evidence) => evidence.error_code === "none")
      .map((evidence) => evidence.completed_at),
    ...advisoryEvidence
      .filter((evidence) => evidence.error_code === "none")
      .map((evidence) => evidence.completed_at),
  ].filter((value): value is string => value !== null);
}

function freshnessAt(
  fetchedAt: string | null,
  completedAt: string,
  maxAgeSeconds: number | null
): ScaOsvResultV2["freshness_at_completion"] {
  if (fetchedAt === null || maxAgeSeconds === null) return "not_fetched";
  return Date.parse(completedAt) - Date.parse(fetchedAt) <= maxAgeSeconds * 1_000
    ? "fresh"
    : "stale";
}

function finishResult(
  request: ScaOsvRequestV2,
  plan: ScaOsvPlanV2,
  status: ScaOsvResultV2["status"],
  completedAt: string,
  batchEvidence: readonly BatchEvidence[],
  advisoryEvidence: readonly AdvisoryEvidence[],
  coordinateResults: readonly CoordinateResult[],
  errorCode: ResultErrorCode
): ScaOsvResultV2 {
  const orderedBatchEvidence = [...batchEvidence].sort(
    (left, right) => left.batch_index - right.batch_index
  );
  const orderedAdvisoryEvidence = [...advisoryEvidence].sort((left, right) =>
    compareUtf8(left.advisory_id, right.advisory_id)
  );
  const orderedResults = [...coordinateResults].sort(
    (left, right) => left.batch_index - right.batch_index || left.result_index - right.result_index
  );
  const completionTimes = successfulCompletionTimes(
    orderedBatchEvidence.filter((evidence) =>
      orderedResults.some((result) => result.batch_id === evidence.batch_id)
    ),
    orderedAdvisoryEvidence
  );
  const fetchedAt =
    completionTimes.length === 0
      ? null
      : ([...completionTimes].sort((left, right) => Date.parse(left) - Date.parse(right))[0] ??
        null);
  const responseBytes = [...orderedBatchEvidence, ...orderedAdvisoryEvidence].reduce(
    (total, evidence) => total + evidence.response_byte_count,
    0
  );
  const advisoryIds = new Set(orderedResults.flatMap((result) => result.advisory_ids));
  const unsigned: UnsignedResult = {
    schema_id: SCA_OSV_RESULT_V2_SCHEMA,
    schema_version: 2,
    source_snapshot_sha256: request.source_snapshot_sha256,
    dependency_inventory_sha256: request.dependency_inventory_sha256,
    plan_sha256: plan.plan_sha256,
    network_policy: request.network_policy,
    status,
    origin: SCA_OSV_V2_ORIGIN,
    redirects_followed: 0,
    ip_confinement_prerequisite: "external_worker",
    scheduler_concurrency_limit: 2,
    fetched_at: fetchedAt,
    completed_at: completedAt,
    max_age_seconds: request.max_age_seconds,
    freshness_at_completion: freshnessAt(fetchedAt, completedAt, request.max_age_seconds),
    response_bytes_received: responseBytes,
    batches_planned: plan.batches.length,
    batches_completed: new Set(orderedResults.map((entry) => entry.batch_id)).size,
    advisories_planned: advisoryIds.size,
    advisories_completed: orderedAdvisoryEvidence.filter(
      (evidence) => evidence.error_code === "none"
    ).length,
    batch_evidence: orderedBatchEvidence,
    advisory_evidence: orderedAdvisoryEvidence,
    coordinate_results: orderedResults,
    advisory_occurrences: mapAdvisories(orderedResults, request.coordinate_occurrences),
    error_code: errorCode,
  };
  return validateContract(
    ScaOsvResultV2Schema,
    { ...unsigned, result_sha256: resultDigest(unsigned) },
    "SCA OSV v2 result"
  );
}

function signalIsAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted ?? false;
}

type SettledFetch = Readonly<{
  response: ScaOsvV2TransportResponse | null;
  error: unknown;
  startedAt: string;
  completedAt: string;
}>;

async function scheduledFetch(
  transport: ScaOsvV2Transport,
  clock: TrustedClock,
  request: ScaOsvV2TransportRequest
): Promise<SettledFetch> {
  return operationalOsvScheduler.schedule(async () => {
    const startedAt = clock.sample();
    try {
      const response = await transport.send(request);
      return { response, error: null, startedAt, completedAt: clock.sample() };
    } catch (error) {
      return { response: null, error, startedAt, completedAt: clock.sample() };
    }
  });
}

function firstEvidenceError(
  batches: readonly BatchEvidence[],
  advisories: readonly AdvisoryEvidence[]
): ResultErrorCode {
  for (const evidence of [...batches, ...advisories]) {
    if (evidence.error_code !== "none") return evidence.error_code;
  }
  return "none";
}

export async function queryScaOsvV2(
  value: unknown,
  options: ScaOsvV2RunOptions = {}
): Promise<ScaOsvResultV2> {
  const request = validateRequest(value);
  const plan = planScaOsvV2(request);
  const clock = new TrustedClock(options.now ?? (() => new Date()));
  if (request.network_policy === "offline_evidence") {
    return finishResult(request, plan, "offline", clock.sample(), [], [], [], "none");
  }
  if (signalIsAborted(options.signal)) {
    return finishResult(request, plan, "cancelled", clock.sample(), [], [], [], "cancelled");
  }
  if (options.transport === undefined) {
    return finishResult(request, plan, "failed", clock.sample(), [], [], [], "transport_failed");
  }
  if (options.transport.ip_confinement !== "external_worker_enforced") {
    return finishResult(
      request,
      plan,
      "denied",
      clock.sample(),
      [],
      [],
      [],
      "ip_confinement_unmet"
    );
  }
  const transport = options.transport;
  if (plan.batches.length === 0) {
    return finishResult(request, plan, "succeeded", clock.sample(), [], [], [], "none");
  }

  const signal = options.signal ?? new AbortController().signal;
  const batchEvidence: BatchEvidence[] = [];
  const coordinateResults: CoordinateResult[] = [];
  let responseBytes = 0;
  let terminalError: ResultErrorCode | null = null;

  for (let offset = 0; offset < plan.batches.length && terminalError === null; ) {
    if (signal.aborted) {
      terminalError = "cancelled";
      break;
    }
    const remaining = request.max_response_bytes - responseBytes;
    if (remaining <= 0) {
      terminalError = "response_too_large";
      break;
    }
    const wave = plan.batches.slice(offset, offset + request.concurrency);
    const perRequestLimit = Math.max(1, Math.floor(remaining / wave.length));
    const settled = await Promise.all(
      wave.map(async (batch) => ({
        batch,
        settled: await scheduledFetch(transport, clock, {
          url: batch.url,
          method: "POST",
          body: batch.request_body,
          inactivity_timeout_ms: request.inactivity_timeout_ms,
          max_response_bytes: perRequestLimit,
          signal,
        }),
      }))
    );
    for (const item of settled) {
      const { batch } = item;
      const fetched = item.settled;
      if (fetched.response === null) {
        const code = transportFailureCode(fetched.error, signal);
        batchEvidence.push({
          batch_id: batch.batch_id,
          batch_index: batch.batch_index,
          coordinate_ids: [...batch.coordinate_ids],
          request_body: batch.request_body,
          request_sha256: batch.request_sha256,
          ...evidenceBase(fetched.startedAt, fetched.completedAt, "failed", code),
        });
        if (code === "cancelled" || code === "response_too_large") terminalError = code;
        continue;
      }
      const response = fetched.response;
      responseBytes += response.body.byteLength;
      if (
        response.body.byteLength > perRequestLimit ||
        responseBytes > request.max_response_bytes
      ) {
        batchEvidence.push({
          batch_id: batch.batch_id,
          batch_index: batch.batch_index,
          coordinate_ids: [...batch.coordinate_ids],
          request_body: batch.request_body,
          request_sha256: batch.request_sha256,
          ...responseEvidence(
            response,
            fetched.startedAt,
            fetched.completedAt,
            "response_too_large",
            false
          ),
        });
        terminalError = "response_too_large";
        continue;
      }
      const transportCode = batchFailureCode(response);
      if (transportCode !== null) {
        batchEvidence.push({
          batch_id: batch.batch_id,
          batch_index: batch.batch_index,
          coordinate_ids: [...batch.coordinate_ids],
          request_body: batch.request_body,
          request_sha256: batch.request_sha256,
          ...responseEvidence(
            response,
            fetched.startedAt,
            fetched.completedAt,
            transportCode,
            true
          ),
        });
        continue;
      }
      try {
        const results = parseScaOsvV2BatchResults(batch, response.body);
        batchEvidence.push({
          batch_id: batch.batch_id,
          batch_index: batch.batch_index,
          coordinate_ids: [...batch.coordinate_ids],
          request_body: batch.request_body,
          request_sha256: batch.request_sha256,
          ...responseEvidence(response, fetched.startedAt, fetched.completedAt, "none", true),
        });
        coordinateResults.push(...results);
      } catch {
        batchEvidence.push({
          batch_id: batch.batch_id,
          batch_index: batch.batch_index,
          coordinate_ids: [...batch.coordinate_ids],
          request_body: batch.request_body,
          request_sha256: batch.request_sha256,
          ...responseEvidence(
            response,
            fetched.startedAt,
            fetched.completedAt,
            "invalid_response",
            true
          ),
        });
      }
    }
    offset += wave.length;
  }

  const advisoryIds = [...new Set(coordinateResults.flatMap((result) => result.advisory_ids))].sort(
    compareUtf8
  );
  const advisoryEvidence: AdvisoryEvidence[] = [];
  if (terminalError === null && advisoryIds.length > request.max_advisory_requests) {
    terminalError = "advisory_limit_exceeded";
  }
  for (
    let offset = 0;
    offset < advisoryIds.length && terminalError === null;
    offset += request.concurrency
  ) {
    if (signal.aborted) {
      terminalError = "cancelled";
      break;
    }
    const remaining = request.max_response_bytes - responseBytes;
    if (remaining <= 0) {
      terminalError = "response_too_large";
      break;
    }
    const wave = advisoryIds.slice(offset, offset + request.concurrency);
    const perRequestLimit = Math.max(1, Math.floor(remaining / wave.length));
    const settled = await Promise.all(
      wave.map(async (advisoryId) => {
        const url = advisoryUrl(advisoryId);
        return {
          advisoryId,
          url,
          settled: await scheduledFetch(transport, clock, {
            url,
            method: "GET",
            body: null,
            inactivity_timeout_ms: request.inactivity_timeout_ms,
            max_response_bytes: perRequestLimit,
            signal,
          }),
        };
      })
    );
    for (const item of settled) {
      const fetched = item.settled;
      if (fetched.response === null) {
        const code = transportFailureCode(fetched.error, signal);
        advisoryEvidence.push({
          advisory_id: item.advisoryId,
          url: item.url,
          method: "GET",
          ...evidenceBase(fetched.startedAt, fetched.completedAt, "failed", code),
        });
        if (code === "cancelled" || code === "response_too_large") terminalError = code;
        continue;
      }
      const response = fetched.response;
      responseBytes += response.body.byteLength;
      if (
        response.body.byteLength > perRequestLimit ||
        responseBytes > request.max_response_bytes
      ) {
        advisoryEvidence.push({
          advisory_id: item.advisoryId,
          url: item.url,
          method: "GET",
          ...responseEvidence(
            response,
            fetched.startedAt,
            fetched.completedAt,
            "response_too_large",
            false
          ),
        });
        terminalError = "response_too_large";
        continue;
      }
      const transportCode = advisoryFailureCode(response, item.url);
      if (transportCode !== null) {
        advisoryEvidence.push({
          advisory_id: item.advisoryId,
          url: item.url,
          method: "GET",
          ...responseEvidence(
            response,
            fetched.startedAt,
            fetched.completedAt,
            transportCode,
            true
          ),
        });
        continue;
      }
      try {
        parseAdvisory(item.advisoryId, response.body);
        advisoryEvidence.push({
          advisory_id: item.advisoryId,
          url: item.url,
          method: "GET",
          ...responseEvidence(response, fetched.startedAt, fetched.completedAt, "none", true),
        });
      } catch {
        advisoryEvidence.push({
          advisory_id: item.advisoryId,
          url: item.url,
          method: "GET",
          ...responseEvidence(
            response,
            fetched.startedAt,
            fetched.completedAt,
            "invalid_response",
            true
          ),
        });
      }
    }
  }

  const completedAt = clock.sample();
  if (terminalError === "cancelled") {
    return finishResult(
      request,
      plan,
      "cancelled",
      completedAt,
      batchEvidence,
      advisoryEvidence,
      coordinateResults,
      "cancelled"
    );
  }
  if (terminalError === "response_too_large" || terminalError === "advisory_limit_exceeded") {
    return finishResult(
      request,
      plan,
      "truncated",
      completedAt,
      batchEvidence,
      advisoryEvidence,
      coordinateResults,
      terminalError
    );
  }
  const batchesCompleted = new Set(coordinateResults.map((result) => result.batch_id)).size;
  const advisoriesCompleted = advisoryEvidence.filter(
    (evidence) => evidence.error_code === "none"
  ).length;
  const allAdvisoriesCompleted = advisoriesCompleted === advisoryIds.length;
  const status: ScaOsvResultV2["status"] =
    batchesCompleted === plan.batches.length && allAdvisoriesCompleted
      ? "succeeded"
      : batchesCompleted === 0
        ? "failed"
        : "partial";
  const firstError = firstEvidenceError(batchEvidence, advisoryEvidence);
  return finishResult(
    request,
    plan,
    status,
    completedAt,
    batchEvidence,
    advisoryEvidence,
    coordinateResults,
    status === "succeeded" ? "none" : firstError === "none" ? "transport_failed" : firstError
  );
}

function semanticFailure(message: string): never {
  throw new ScaOsvV2Error("semantic_mismatch", message);
}

function validateRawEvidence(evidence: {
  readonly started_at: string | null;
  readonly completed_at: string | null;
  readonly fetch_state: "not_fetched" | "completed" | "failed";
  readonly response_byte_count: number;
  readonly response_sha256: string | null;
  readonly response_body_base64: string | null;
  readonly retention: "full_raw_bytes" | "digest_only_truncated" | "none";
  readonly error_code: EvidenceErrorCode;
}): void {
  if (evidence.fetch_state === "not_fetched") {
    if (
      evidence.started_at !== null ||
      evidence.completed_at !== null ||
      evidence.response_byte_count !== 0 ||
      evidence.response_sha256 !== null ||
      evidence.response_body_base64 !== null ||
      evidence.retention !== "none"
    ) {
      semanticFailure("not-fetched evidence contains fetch facts");
    }
    return;
  }
  if (
    evidence.started_at === null ||
    evidence.completed_at === null ||
    Date.parse(evidence.completed_at) < Date.parse(evidence.started_at)
  ) {
    semanticFailure("fetched evidence timestamps are invalid");
  }
  if (evidence.error_code === "none" && evidence.response_body_base64 === null) {
    semanticFailure("successful response evidence does not retain exact raw bytes");
  }
  if (evidence.response_body_base64 !== null) {
    const bytes = Buffer.from(evidence.response_body_base64, "base64");
    if (
      bytes.toString("base64") !== evidence.response_body_base64 ||
      bytes.byteLength !== evidence.response_byte_count ||
      evidence.response_sha256 !== sha256(bytes) ||
      evidence.retention !== "full_raw_bytes"
    ) {
      semanticFailure("raw response evidence bytes or digest mismatch");
    }
    if (evidence.error_code === "none") {
      try {
        strictUtf8(bytes);
      } catch {
        semanticFailure("successful response evidence is not strict UTF-8");
      }
    }
  } else if (
    evidence.response_byte_count > 0 &&
    (evidence.response_sha256 === null || evidence.retention !== "digest_only_truncated")
  ) {
    semanticFailure("digest-only response evidence is inconsistent");
  }
}

export function validateScaOsvPlanV2(value: unknown, requestValue: unknown): ScaOsvPlanV2 {
  const request = validateRequest(requestValue);
  const plan = validateContract(ScaOsvPlanV2Schema, value, "SCA OSV v2 plan");
  const expected = planScaOsvV2(request);
  if (canonicalJson(plan) !== canonicalJson(expected)) {
    semanticFailure("OSV plan does not exactly correspond to its request");
  }
  return plan;
}

export function validateScaOsvResultV2(
  value: unknown,
  requestValue: unknown,
  planValue: unknown
): ScaOsvResultV2 {
  const request = validateRequest(requestValue);
  const plan = validateScaOsvPlanV2(planValue, request);
  const result = validateContract(ScaOsvResultV2Schema, value, "SCA OSV v2 result");
  const { result_sha256: observedDigest, ...unsigned } = result;
  if (resultDigest(unsigned) !== observedDigest) {
    throw new ScaOsvV2Error("invalid_request", "OSV v2 result digest mismatch");
  }
  if (
    result.source_snapshot_sha256 !== request.source_snapshot_sha256 ||
    result.dependency_inventory_sha256 !== request.dependency_inventory_sha256 ||
    result.plan_sha256 !== plan.plan_sha256 ||
    result.network_policy !== request.network_policy ||
    result.max_age_seconds !== request.max_age_seconds ||
    result.batches_planned !== plan.batches.length
  ) {
    semanticFailure("OSV result is not bound to its exact request and plan");
  }
  if (
    result.batch_evidence.some(
      (evidence, index) =>
        index > 0 && (result.batch_evidence[index - 1]?.batch_index ?? -1) >= evidence.batch_index
    )
  ) {
    semanticFailure("OSV batch evidence is not uniquely ordered");
  }
  const evidenceByBatch = new Map<string, BatchEvidence>();
  for (const evidence of result.batch_evidence) {
    const batch = plan.batches[evidence.batch_index];
    if (
      batch === undefined ||
      evidenceByBatch.has(evidence.batch_id) ||
      evidence.batch_id !== batch.batch_id ||
      canonicalJson(evidence.coordinate_ids) !== canonicalJson(batch.coordinate_ids) ||
      evidence.request_body !== batch.request_body ||
      evidence.request_sha256 !== batch.request_sha256
    ) {
      semanticFailure("OSV batch evidence does not correspond to its plan batch");
    }
    validateRawEvidence(evidence);
    if (evidence.fetch_state === "completed") {
      if (evidence.status_code === null || evidence.final_url === null) {
        semanticFailure("completed OSV batch evidence lacks transport response facts");
      }
      const transportCode = batchFailureCode({
        status_code: evidence.status_code,
        final_url: evidence.final_url,
        redirected: evidence.redirected,
        body: Buffer.alloc(0),
      });
      if (
        (transportCode !== null && evidence.error_code !== transportCode) ||
        (transportCode === null &&
          evidence.error_code !== "none" &&
          evidence.error_code !== "invalid_response" &&
          evidence.error_code !== "response_too_large")
      ) {
        semanticFailure("OSV batch evidence error code contradicts transport response facts");
      }
    } else if (
      evidence.status_code !== null ||
      evidence.final_url !== null ||
      evidence.redirected
    ) {
      semanticFailure("unfetched OSV batch evidence contains transport response facts");
    }
    if (evidence.error_code === "none") {
      const bytes = Buffer.from(evidence.response_body_base64 ?? "", "base64");
      const expectedResults = parseScaOsvV2BatchResults(batch, bytes);
      const observedResults = result.coordinate_results.filter(
        (entry) => entry.batch_id === batch.batch_id
      );
      if (canonicalJson(observedResults) !== canonicalJson(expectedResults)) {
        semanticFailure("OSV coordinate results do not equal retained batch evidence");
      }
    }
    evidenceByBatch.set(evidence.batch_id, evidence);
  }
  const seenCoordinates = new Set<string>();
  for (const [index, coordinateResult] of result.coordinate_results.entries()) {
    if (
      index > 0 &&
      ((result.coordinate_results[index - 1]?.batch_index ?? -1) > coordinateResult.batch_index ||
        ((result.coordinate_results[index - 1]?.batch_index ?? -1) ===
          coordinateResult.batch_index &&
          (result.coordinate_results[index - 1]?.result_index ?? -1) >=
            coordinateResult.result_index))
    ) {
      semanticFailure("OSV coordinate results are not uniquely ordered");
    }
    const batch = plan.batches[coordinateResult.batch_index];
    const evidence = evidenceByBatch.get(coordinateResult.batch_id);
    if (
      batch === undefined ||
      evidence?.error_code !== "none" ||
      coordinateResult.batch_id !== batch.batch_id ||
      coordinateResult.coordinate_id !== batch.coordinate_ids[coordinateResult.result_index] ||
      seenCoordinates.has(coordinateResult.coordinate_id) ||
      canonicalJson(coordinateResult.advisory_ids) !==
        canonicalJson([...new Set(coordinateResult.advisory_ids)].sort(compareUtf8))
    ) {
      semanticFailure("OSV coordinate result index or coordinate correspondence mismatch");
    }
    seenCoordinates.add(coordinateResult.coordinate_id);
  }
  const successfulBatchIds = new Set(result.coordinate_results.map((entry) => entry.batch_id));
  if (result.batches_completed !== successfulBatchIds.size) {
    semanticFailure("OSV completed batch count mismatch");
  }

  const expectedAdvisoryIds = [
    ...new Set(result.coordinate_results.flatMap((entry) => entry.advisory_ids)),
  ].sort(compareUtf8);
  if (result.advisories_planned !== expectedAdvisoryIds.length) {
    semanticFailure("OSV planned advisory count mismatch");
  }
  if (
    result.advisory_evidence.some(
      (evidence, index) =>
        index > 0 &&
        compareUtf8(result.advisory_evidence[index - 1]?.advisory_id ?? "", evidence.advisory_id) >=
          0
    )
  ) {
    semanticFailure("OSV advisory evidence is not uniquely ordered");
  }
  for (const evidence of result.advisory_evidence) {
    if (
      !expectedAdvisoryIds.includes(evidence.advisory_id) ||
      evidence.url !== advisoryUrl(evidence.advisory_id) ||
      evidence.method !== "GET"
    ) {
      semanticFailure("OSV advisory evidence does not correspond to a returned advisory ID");
    }
    validateRawEvidence(evidence);
    if (evidence.fetch_state === "completed") {
      if (evidence.status_code === null || evidence.final_url === null) {
        semanticFailure("completed OSV advisory evidence lacks transport response facts");
      }
      const transportCode = advisoryFailureCode(
        {
          status_code: evidence.status_code,
          final_url: evidence.final_url,
          redirected: evidence.redirected,
          body: Buffer.alloc(0),
        },
        evidence.url
      );
      if (
        (transportCode !== null && evidence.error_code !== transportCode) ||
        (transportCode === null &&
          evidence.error_code !== "none" &&
          evidence.error_code !== "invalid_response" &&
          evidence.error_code !== "response_too_large")
      ) {
        semanticFailure("OSV advisory evidence error code contradicts transport response facts");
      }
    } else if (
      evidence.status_code !== null ||
      evidence.final_url !== null ||
      evidence.redirected
    ) {
      semanticFailure("unfetched OSV advisory evidence contains transport response facts");
    }
    if (evidence.error_code === "none") {
      parseAdvisory(
        evidence.advisory_id,
        Buffer.from(evidence.response_body_base64 ?? "", "base64")
      );
    }
  }
  const completedAdvisories = result.advisory_evidence.filter(
    (evidence) => evidence.error_code === "none"
  ).length;
  if (result.advisories_completed !== completedAdvisories) {
    semanticFailure("OSV completed advisory count mismatch");
  }
  const expectedMappings = mapAdvisories(result.coordinate_results, request.coordinate_occurrences);
  if (canonicalJson(result.advisory_occurrences) !== canonicalJson(expectedMappings)) {
    semanticFailure("OSV advisory occurrence mappings mismatch");
  }
  const expectedBytes = [...result.batch_evidence, ...result.advisory_evidence].reduce(
    (total, evidence) => total + evidence.response_byte_count,
    0
  );
  if (result.response_bytes_received !== expectedBytes) {
    semanticFailure("OSV response byte aggregate mismatch");
  }
  const completionTimes = successfulCompletionTimes(
    result.batch_evidence.filter((evidence) => successfulBatchIds.has(evidence.batch_id)),
    result.advisory_evidence
  );
  const expectedFetchedAt =
    completionTimes.length === 0
      ? null
      : ([...completionTimes].sort((left, right) => Date.parse(left) - Date.parse(right))[0] ??
        null);
  if (
    result.fetched_at !== expectedFetchedAt ||
    result.freshness_at_completion !==
      freshnessAt(expectedFetchedAt, result.completed_at, request.max_age_seconds) ||
    completionTimes.some((time) => Date.parse(time) > Date.parse(result.completed_at))
  ) {
    semanticFailure("OSV fetch timestamp or completion freshness mismatch");
  }
  if (request.network_policy === "offline_evidence") {
    if (
      result.status !== "offline" ||
      result.error_code !== "none" ||
      result.fetched_at !== null ||
      result.batch_evidence.length !== 0 ||
      result.advisory_evidence.length !== 0
    ) {
      semanticFailure("offline OSV result contains live lookup claims");
    }
  } else if (result.status === "denied") {
    if (result.error_code !== "ip_confinement_unmet" || result.fetched_at !== null) {
      semanticFailure("denied OSV result has inconsistent prerequisite facts");
    }
  } else if (result.status === "cancelled") {
    if (result.error_code !== "cancelled") semanticFailure("cancelled OSV status mismatch");
  } else if (result.status === "truncated") {
    if (
      result.error_code !== "response_too_large" &&
      result.error_code !== "advisory_limit_exceeded"
    ) {
      semanticFailure("truncated OSV status mismatch");
    }
  } else {
    const allAdvisoriesComplete = result.advisories_completed === expectedAdvisoryIds.length;
    const expectedStatus: ScaOsvResultV2["status"] =
      result.batches_completed === plan.batches.length && allAdvisoriesComplete
        ? "succeeded"
        : result.batches_completed === 0
          ? "failed"
          : "partial";
    if (result.status !== expectedStatus) semanticFailure("OSV aggregate status mismatch");
    if ((result.status === "succeeded") !== (result.error_code === "none")) {
      semanticFailure("OSV aggregate error code mismatch");
    }
    if (result.status !== "succeeded") {
      const expectedError = firstEvidenceError(result.batch_evidence, result.advisory_evidence);
      if (result.error_code !== (expectedError === "none" ? "transport_failed" : expectedError)) {
        semanticFailure("OSV first failure code mismatch");
      }
    }
  }
  return result;
}

export function evaluateScaOsvV2Freshness(
  value: unknown,
  asOf: Date,
  requestValue: unknown,
  planValue: unknown
): "fresh" | "stale" | "not_fetched" {
  const result = validateScaOsvResultV2(value, requestValue, planValue);
  if (!Number.isFinite(asOf.getTime())) {
    throw new ScaOsvV2Error("invalid_clock", "OSV clock is invalid");
  }
  if (result.fetched_at === null || result.max_age_seconds === null) return "not_fetched";
  return asOf.getTime() - Date.parse(result.fetched_at) <= result.max_age_seconds * 1_000
    ? "fresh"
    : "stale";
}

export function exactAllowedTransportRequest(request: ScaOsvV2TransportRequest): boolean {
  if (request.method === "POST") {
    return (
      request.url === SCA_OSV_V2_QUERY_BATCH_URL && request.body !== null && request.body.length > 0
    );
  }
  if (request.method !== "GET" || request.body !== null) return false;
  let parsed: URL;
  try {
    parsed = new URL(request.url);
  } catch {
    return false;
  }
  if (
    parsed.origin !== SCA_OSV_V2_ORIGIN ||
    parsed.href !== request.url ||
    parsed.username.length > 0 ||
    parsed.password.length > 0
  ) {
    return false;
  }
  if (parsed.search.length > 0 || parsed.hash.length > 0) return false;
  const prefix = "/v1/vulns/";
  if (!parsed.pathname.startsWith(prefix)) return false;
  const encodedId = parsed.pathname.slice(prefix.length);
  let advisoryId: string;
  try {
    advisoryId = decodeURIComponent(encodedId);
  } catch {
    return false;
  }
  return OSV_ID_PATTERN.test(advisoryId) && encodeURIComponent(advisoryId) === encodedId;
}

/**
 * Fixed-origin HTTP transport only. It deliberately reports `not_enforced` and therefore cannot be
 * used as an authorized P02 live transport. The in-process fixed-IP HTTPS transport also reports
 * `not_enforced`: socket lookup and SNI pinning do not independently confine network egress.
 */
export function createUnconfinedFixedOriginOsvV2Transport(): ScaOsvV2Transport {
  return Object.freeze({
    ip_confinement: "not_enforced" as const,
    async send(request: ScaOsvV2TransportRequest): Promise<ScaOsvV2TransportResponse> {
      if (!exactAllowedTransportRequest(request)) {
        throw new ScaOsvV2TransportError(
          "transport_failed",
          "OSV destination, method, or path is not allowed"
        );
      }
      const controller = new AbortController();
      const abortFromCaller = (): void => controller.abort();
      request.signal.addEventListener("abort", abortFromCaller, { once: true });
      let inactivityTimer: NodeJS.Timeout | undefined;
      let inactivityExpired = false;
      const renew = (): void => {
        if (inactivityTimer !== undefined) clearTimeout(inactivityTimer);
        inactivityTimer = setTimeout(() => {
          inactivityExpired = true;
          controller.abort();
        }, request.inactivity_timeout_ms);
        inactivityTimer.unref();
      };
      renew();
      try {
        const response = await fetch(request.url, {
          method: request.method,
          headers:
            request.method === "POST"
              ? { Accept: "application/json", "Content-Type": "application/json" }
              : { Accept: "application/json" },
          body: request.body,
          redirect: "error",
          signal: controller.signal,
        });
        const chunks: Buffer[] = [];
        let byteCount = 0;
        if (response.body !== null) {
          const reader = response.body.getReader();
          for (;;) {
            const item = await reader.read();
            if (item.done) break;
            if (item.value.byteLength === 0) continue;
            byteCount += item.value.byteLength;
            if (byteCount > request.max_response_bytes) {
              await reader.cancel();
              throw new ScaOsvV2TransportError(
                "response_too_large",
                "OSV response exceeded the admitted byte limit"
              );
            }
            chunks.push(Buffer.from(item.value));
            renew();
          }
        }
        return {
          status_code: response.status,
          final_url: response.url,
          redirected: response.redirected,
          body: Buffer.concat(chunks, byteCount),
        };
      } catch (error) {
        if (error instanceof ScaOsvV2TransportError) throw error;
        if (request.signal.aborted) {
          throw new ScaOsvV2TransportError("cancelled", "OSV request was cancelled");
        }
        if (inactivityExpired) {
          throw new ScaOsvV2TransportError(
            "inactivity_timeout",
            "OSV response exceeded the inactivity timeout"
          );
        }
        throw new ScaOsvV2TransportError("transport_failed", "OSV transport failed");
      } finally {
        if (inactivityTimer !== undefined) clearTimeout(inactivityTimer);
        request.signal.removeEventListener("abort", abortFromCaller);
      }
    },
  });
}
