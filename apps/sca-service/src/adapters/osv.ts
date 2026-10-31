import { Type, type Static } from "typebox";

import { canonicalJson, sha256 } from "../../../orchestration/dist/canonical-json.js";
import { validateContract } from "../../../orchestration/dist/contracts.js";
import {
  Rfc3339UtcSchema,
  Sha256Schema,
} from "../../../orchestration/dist/skill-contracts/common.js";

const MAX_COORDINATES = 128;
const MAX_ADVISORIES = 4_096;
const MAX_RESPONSE_BYTES = 16_777_216;
const MAX_TEXT = 4_096;
const OSV_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;

export const SCA_OSV_REQUEST_SCHEMA = "penny.sca-osv-request.v1";
export const SCA_OSV_RESULT_SCHEMA = "penny.sca-osv-result.v1";
export const SCA_OSV_ORIGIN = "https://api.osv.dev";
export const SCA_OSV_QUERY_BATCH_URL = `${SCA_OSV_ORIGIN}/v1/querybatch`;

const ScaOsvCoordinateV1Schema = Type.Object(
  {
    ecosystem: Type.Union([Type.Literal("npm"), Type.Literal("Packagist")]),
    name: Type.String({ minLength: 1, maxLength: MAX_TEXT }),
    version: Type.String({ minLength: 1, maxLength: MAX_TEXT }),
  },
  { additionalProperties: false }
);

export const ScaOsvRequestV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_OSV_REQUEST_SCHEMA),
    schema_version: Type.Literal(1),
    source_snapshot_sha256: Sha256Schema,
    dependency_inventory_sha256: Sha256Schema,
    coordinates: Type.Array(ScaOsvCoordinateV1Schema, {
      maxItems: MAX_COORDINATES,
    }),
    network_policy: Type.Union([
      Type.Literal("disabled"),
      Type.Literal("fixed_osv_origin_authorized"),
    ]),
    timeout_ms: Type.Integer({ minimum: 1, maximum: 300_000 }),
    max_response_bytes: Type.Integer({ minimum: 1, maximum: MAX_RESPONSE_BYTES }),
  },
  { additionalProperties: false }
);

const ScaOsvResponseIdentityV1Schema = Type.Object(
  {
    request_kind: Type.Union([Type.Literal("querybatch"), Type.Literal("vulnerability")]),
    vulnerability_id: Type.Union([Type.String({ minLength: 1, maxLength: 256 }), Type.Null()]),
    status_code: Type.Integer({ minimum: 100, maximum: 599 }),
    byte_length: Type.Integer({ minimum: 0, maximum: MAX_RESPONSE_BYTES }),
    body_sha256: Sha256Schema,
  },
  { additionalProperties: false }
);

const ScaOsvAdvisoryV1Schema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 256 }),
    modified: Rfc3339UtcSchema,
    published: Type.Union([Rfc3339UtcSchema, Type.Null()]),
    aliases: Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { maxItems: 256 }),
    affected: Type.Array(ScaOsvCoordinateV1Schema, { maxItems: MAX_COORDINATES }),
    raw_sha256: Sha256Schema,
  },
  { additionalProperties: false }
);

export const ScaOsvResultV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_OSV_RESULT_SCHEMA),
    schema_version: Type.Literal(1),
    source_snapshot_sha256: Sha256Schema,
    dependency_inventory_sha256: Sha256Schema,
    status: Type.Union([
      Type.Literal("succeeded"),
      Type.Literal("partial"),
      Type.Literal("failed"),
      Type.Literal("unavailable"),
    ]),
    queried_at: Rfc3339UtcSchema,
    origin: Type.Literal(SCA_OSV_ORIGIN),
    redirects_followed: Type.Literal(0),
    pagination_complete: Type.Boolean(),
    coordinates_queried: Type.Integer({ minimum: 0, maximum: MAX_COORDINATES }),
    advisory_count: Type.Integer({ minimum: 0, maximum: MAX_ADVISORIES }),
    advisories: Type.Array(ScaOsvAdvisoryV1Schema, { maxItems: MAX_ADVISORIES }),
    responses: Type.Array(ScaOsvResponseIdentityV1Schema, { maxItems: MAX_ADVISORIES + 1 }),
    result_sha256: Sha256Schema,
    error_code: Type.Union([
      Type.Literal("none"),
      Type.Literal("network_disabled"),
      Type.Literal("transport_failed"),
      Type.Literal("invalid_response"),
      Type.Literal("response_too_large"),
      Type.Literal("redirect_refused"),
      Type.Literal("timeout"),
    ]),
  },
  { additionalProperties: false }
);

export type ScaOsvRequestV1 = Static<typeof ScaOsvRequestV1Schema>;
export type ScaOsvResultV1 = Static<typeof ScaOsvResultV1Schema>;

type OsvCoordinate = ScaOsvRequestV1["coordinates"][number];
type OsvAdvisory = ScaOsvResultV1["advisories"][number];
type OsvResponseIdentity = ScaOsvResultV1["responses"][number];
type UnsignedOsvResult = Omit<ScaOsvResultV1, "result_sha256">;

export interface ScaOsvTransportRequest {
  readonly url: string;
  readonly method: "GET" | "POST";
  readonly body: string | null;
  readonly timeout_ms: number;
  readonly max_response_bytes: number;
}

export interface ScaOsvTransportResponse {
  readonly status_code: number;
  readonly final_url: string;
  readonly redirected: boolean;
  readonly body: string;
}

export interface ScaOsvTransport {
  send(request: ScaOsvTransportRequest): Promise<ScaOsvTransportResponse>;
}

export interface ScaOsvRunOptions {
  readonly transport?: ScaOsvTransport;
  readonly now?: () => Date;
}

export class ScaOsvError extends Error {
  constructor(
    readonly code: "invalid_request" | "coordinate_collision" | "invalid_clock",
    message: string
  ) {
    super(message);
    this.name = "ScaOsvError";
  }
}

class OsvTransportFailure extends Error {
  constructor(
    readonly code: ScaOsvResultV1["error_code"],
    message: string
  ) {
    super(message);
    this.name = "OsvTransportFailure";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bodyIdentity(
  requestKind: OsvResponseIdentity["request_kind"],
  vulnerabilityId: string | null,
  response: ScaOsvTransportResponse
): OsvResponseIdentity {
  return {
    request_kind: requestKind,
    vulnerability_id: vulnerabilityId,
    status_code: response.status_code,
    byte_length: Buffer.byteLength(response.body, "utf8"),
    body_sha256: sha256(response.body),
  };
}

function exactOsvResponse(
  request: ScaOsvTransportRequest,
  response: ScaOsvTransportResponse
): void {
  if (response.redirected || response.final_url !== request.url) {
    throw new OsvTransportFailure("redirect_refused", "OSV redirect or destination drift refused");
  }
  if (Buffer.byteLength(response.body, "utf8") > request.max_response_bytes) {
    throw new OsvTransportFailure("response_too_large", "OSV response exceeded its byte limit");
  }
  if (response.status_code < 200 || response.status_code >= 300) {
    throw new OsvTransportFailure("transport_failed", "OSV returned a non-success status");
  }
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    throw new OsvTransportFailure("invalid_response", "OSV response was not valid JSON");
  }
}

function queryBatchIds(body: string, expected: number): readonly string[] {
  const parsed = parseJson(body);
  if (!isRecord(parsed) || !Array.isArray(parsed.results) || parsed.results.length !== expected) {
    throw new OsvTransportFailure(
      "invalid_response",
      "OSV querybatch result cardinality is invalid"
    );
  }
  const ids = new Set<string>();
  for (const result of parsed.results) {
    if (!isRecord(result)) {
      throw new OsvTransportFailure("invalid_response", "OSV querybatch entry is invalid");
    }
    const vulns = result.vulns;
    if (vulns === undefined) continue;
    if (!Array.isArray(vulns)) {
      throw new OsvTransportFailure(
        "invalid_response",
        "OSV querybatch vulnerabilities are invalid"
      );
    }
    for (const vulnerability of vulns) {
      if (
        !isRecord(vulnerability) ||
        typeof vulnerability.id !== "string" ||
        !OSV_ID_PATTERN.test(vulnerability.id)
      ) {
        throw new OsvTransportFailure(
          "invalid_response",
          "OSV querybatch vulnerability ID is invalid"
        );
      }
      ids.add(vulnerability.id);
      if (ids.size > MAX_ADVISORIES) {
        throw new OsvTransportFailure(
          "response_too_large",
          "OSV advisory count exceeded its limit"
        );
      }
    }
  }
  return [...ids].sort();
}

function affectedCoordinates(value: unknown): readonly OsvCoordinate[] {
  if (!Array.isArray(value)) return [];
  const coordinates = new Map<string, OsvCoordinate>();
  for (const affected of value) {
    if (!isRecord(affected) || !isRecord(affected.package)) continue;
    const ecosystem = affected.package.ecosystem;
    const name = affected.package.name;
    if ((ecosystem !== "npm" && ecosystem !== "Packagist") || typeof name !== "string") continue;
    const versions = affected.versions;
    if (!Array.isArray(versions)) continue;
    for (const version of versions) {
      if (typeof version !== "string") continue;
      const coordinate: OsvCoordinate = { ecosystem, name, version };
      coordinates.set(canonicalJson(coordinate), coordinate);
      if (coordinates.size >= MAX_COORDINATES) break;
    }
  }
  return [...coordinates.values()].sort((left, right) =>
    canonicalJson(left).localeCompare(canonicalJson(right), "en-US")
  );
}

function parseAdvisory(body: string, expectedId: string): OsvAdvisory {
  const parsed = parseJson(body);
  if (
    !isRecord(parsed) ||
    parsed.id !== expectedId ||
    typeof parsed.modified !== "string" ||
    !Number.isFinite(Date.parse(parsed.modified))
  ) {
    throw new OsvTransportFailure("invalid_response", "OSV advisory identity is invalid");
  }
  const published = parsed.published;
  if (
    published !== undefined &&
    (typeof published !== "string" || !Number.isFinite(Date.parse(published)))
  ) {
    throw new OsvTransportFailure("invalid_response", "OSV advisory published time is invalid");
  }
  const aliases = parsed.aliases;
  if (
    aliases !== undefined &&
    (!Array.isArray(aliases) || !aliases.every((alias) => typeof alias === "string"))
  ) {
    throw new OsvTransportFailure("invalid_response", "OSV advisory aliases are invalid");
  }
  return {
    id: expectedId,
    modified: parsed.modified,
    published: typeof published === "string" ? published : null,
    aliases: aliases === undefined ? [] : [...aliases].sort(),
    affected: [...affectedCoordinates(parsed.affected)],
    raw_sha256: sha256(body),
  };
}

function resultDigest(value: UnsignedOsvResult): string {
  return sha256(canonicalJson(value));
}

function terminalResult(
  request: ScaOsvRequestV1,
  queriedAt: string,
  status: ScaOsvResultV1["status"],
  errorCode: ScaOsvResultV1["error_code"],
  advisories: readonly OsvAdvisory[],
  responses: readonly OsvResponseIdentity[],
  paginationComplete: boolean
): ScaOsvResultV1 {
  const unsigned: UnsignedOsvResult = {
    schema_id: SCA_OSV_RESULT_SCHEMA,
    schema_version: 1,
    source_snapshot_sha256: request.source_snapshot_sha256,
    dependency_inventory_sha256: request.dependency_inventory_sha256,
    status,
    queried_at: queriedAt,
    origin: SCA_OSV_ORIGIN,
    redirects_followed: 0,
    pagination_complete: paginationComplete,
    coordinates_queried: status === "unavailable" ? 0 : request.coordinates.length,
    advisory_count: advisories.length,
    advisories: [...advisories],
    responses: [...responses],
    error_code: errorCode,
  };
  return validateContract(
    ScaOsvResultV1Schema,
    { ...unsigned, result_sha256: resultDigest(unsigned) },
    "SCA OSV result"
  );
}

function isAllowedOsvTransportRequest(request: ScaOsvTransportRequest): boolean {
  let parsed: URL;
  try {
    parsed = new URL(request.url);
  } catch {
    return false;
  }
  if (parsed.origin !== SCA_OSV_ORIGIN || parsed.search.length > 0 || parsed.hash.length > 0) {
    return false;
  }
  if (request.url === SCA_OSV_QUERY_BATCH_URL) {
    return request.method === "POST" && request.body !== null;
  }
  return (
    request.method === "GET" &&
    request.body === null &&
    /^\/v1\/vulns\/[A-Za-z0-9._:%-]+$/u.test(parsed.pathname)
  );
}

export function createFixedOsvTransport(): ScaOsvTransport {
  return Object.freeze({
    async send(request: ScaOsvTransportRequest): Promise<ScaOsvTransportResponse> {
      if (!isAllowedOsvTransportRequest(request)) {
        throw new OsvTransportFailure(
          "transport_failed",
          "OSV destination or method is not allowed"
        );
      }
      const controller = new AbortController();
      let inactivityTimer: NodeJS.Timeout | undefined;
      const renewInactivity = (): void => {
        if (inactivityTimer !== undefined) clearTimeout(inactivityTimer);
        inactivityTimer = setTimeout(() => controller.abort(), request.timeout_ms);
        inactivityTimer.unref();
      };
      renewInactivity();
      try {
        const response = await fetch(request.url, {
          method: request.method,
          headers:
            request.body === null
              ? { Accept: "application/json" }
              : {
                  Accept: "application/json",
                  "Content-Type": "application/json",
                },
          body: request.body,
          redirect: "error",
          signal: controller.signal,
        });
        renewInactivity();
        const chunks: Buffer[] = [];
        let bodyBytes = 0;
        if (response.body !== null) {
          const reader = response.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value.byteLength === 0) continue;
            bodyBytes += value.byteLength;
            if (bodyBytes > request.max_response_bytes) {
              await reader.cancel();
              throw new OsvTransportFailure(
                "response_too_large",
                "OSV response exceeded its byte limit"
              );
            }
            chunks.push(Buffer.from(value));
            renewInactivity();
          }
        }
        const bodyBuffer = Buffer.concat(chunks, bodyBytes);
        return {
          status_code: response.status,
          final_url: response.url,
          redirected: response.redirected,
          body: bodyBuffer.toString("utf8"),
        };
      } catch (error) {
        if (error instanceof OsvTransportFailure) throw error;
        if (controller.signal.aborted) {
          throw new OsvTransportFailure("timeout", "OSV request became inactive");
        }
        throw new OsvTransportFailure("transport_failed", "OSV transport failed");
      } finally {
        if (inactivityTimer !== undefined) clearTimeout(inactivityTimer);
      }
    },
  });
}

export async function queryScaOsvV1(
  value: unknown,
  options: ScaOsvRunOptions = {}
): Promise<ScaOsvResultV1> {
  let request: ScaOsvRequestV1;
  try {
    request = validateContract(ScaOsvRequestV1Schema, value, "SCA OSV request");
  } catch (error) {
    throw new ScaOsvError(
      "invalid_request",
      error instanceof Error ? error.message : "OSV request is invalid"
    );
  }
  const coordinateKeys = request.coordinates.map((coordinate) => canonicalJson(coordinate));
  if (new Set(coordinateKeys).size !== coordinateKeys.length) {
    throw new ScaOsvError("coordinate_collision", "OSV coordinates must be unique");
  }
  const now = options.now?.() ?? new Date();
  if (!Number.isFinite(now.getTime()))
    throw new ScaOsvError("invalid_clock", "OSV clock is invalid");
  const queriedAt = now.toISOString();
  if (request.coordinates.length === 0) {
    return terminalResult(request, queriedAt, "succeeded", "none", [], [], true);
  }
  if (request.network_policy === "disabled") {
    return terminalResult(request, queriedAt, "unavailable", "network_disabled", [], [], false);
  }
  const transport = options.transport;
  if (transport === undefined) {
    return terminalResult(request, queriedAt, "unavailable", "transport_failed", [], [], false);
  }

  const responses: OsvResponseIdentity[] = [];
  const advisories: OsvAdvisory[] = [];
  try {
    const queryBody = canonicalJson({
      queries: request.coordinates.map((coordinate) => ({
        package: { ecosystem: coordinate.ecosystem, name: coordinate.name },
        version: coordinate.version,
      })),
    });
    const batchRequest: ScaOsvTransportRequest = {
      url: SCA_OSV_QUERY_BATCH_URL,
      method: "POST",
      body: queryBody,
      timeout_ms: request.timeout_ms,
      max_response_bytes: request.max_response_bytes,
    };
    const batchResponse = await transport.send(batchRequest);
    exactOsvResponse(batchRequest, batchResponse);
    responses.push(bodyIdentity("querybatch", null, batchResponse));

    for (const id of queryBatchIds(batchResponse.body, request.coordinates.length)) {
      const advisoryRequest: ScaOsvTransportRequest = {
        url: `${SCA_OSV_ORIGIN}/v1/vulns/${encodeURIComponent(id)}`,
        method: "GET",
        body: null,
        timeout_ms: request.timeout_ms,
        max_response_bytes: request.max_response_bytes,
      };
      const advisoryResponse = await transport.send(advisoryRequest);
      exactOsvResponse(advisoryRequest, advisoryResponse);
      responses.push(bodyIdentity("vulnerability", id, advisoryResponse));
      advisories.push(parseAdvisory(advisoryResponse.body, id));
    }
  } catch (error) {
    const errorCode = error instanceof OsvTransportFailure ? error.code : "transport_failed";
    return terminalResult(
      request,
      queriedAt,
      responses.length === 0 ? "failed" : "partial",
      errorCode,
      advisories,
      responses,
      false
    );
  }

  return terminalResult(request, queriedAt, "succeeded", "none", advisories, responses, true);
}
