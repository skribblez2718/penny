import { describe, expect, it } from "vitest";

import { canonicalJson, sha256 } from "../../orchestration/dist/canonical-json.js";
import { scaDependencyCoordinateIdV2 } from "../src/adapters/dependency-inventory-v2.js";
import {
  SCA_OSV_V2_QUERY_BATCH_URL,
  ScaOsvV2Error,
  ScaOsvV2TransportError,
  createUnconfinedFixedOriginOsvV2Transport,
  evaluateScaOsvV2Freshness,
  planScaOsvV2,
  queryScaOsvV2,
  validateScaOsvResultV2,
  type ScaOsvResultV2,
  type ScaOsvV2Transport,
  type ScaOsvV2TransportRequest,
  type ScaOsvV2TransportResponse,
} from "../src/adapters/osv-v2.js";

const SNAPSHOT = "a".repeat(64);
const INVENTORY = "b".repeat(64);
const NOW = new Date("2026-09-20T12:00:00.000Z");

function coordinate(index: number) {
  const name = `package-${index}`;
  const version = `1.0.${index}`;
  return {
    coordinate_id: scaDependencyCoordinateIdV2("npm", name, version),
    ecosystem: "npm" as const,
    name,
    version,
  };
}

function request(count = 2, max_age_seconds: number | null = 3_600) {
  const coordinates = Array.from({ length: count }, (_, index) => coordinate(index));
  return {
    schema_id: "penny.sca-osv-request.v2",
    schema_version: 2,
    source_snapshot_sha256: SNAPSHOT,
    dependency_inventory_sha256: INVENTORY,
    coordinates,
    coordinate_occurrences: coordinates.map((item, index) => ({
      coordinate_id: item.coordinate_id,
      occurrence_ids: [`depocc_${(index + 1).toString(16).padStart(64, "0")}`],
    })),
    network_policy: "fixed_osv_origin_authorized" as const,
    ip_confinement: "external_worker_required" as const,
    inactivity_timeout_ms: 2_000,
    max_response_bytes: 1_048_576,
    concurrency: 2,
    max_advisory_requests: 32,
    max_age_seconds,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonRecord(value: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("expected fixture JSON");
  }
  if (!isRecord(parsed)) throw new Error("expected a fixture JSON object");
  return parsed;
}

function defaultResponse(
  requestValue: ScaOsvV2TransportRequest,
  advisoryId?: string
): ScaOsvV2TransportResponse {
  if (requestValue.method === "GET") {
    const id = decodeURIComponent(requestValue.url.slice(requestValue.url.lastIndexOf("/") + 1));
    return {
      status_code: 200,
      final_url: requestValue.url,
      redirected: false,
      body: Buffer.from(JSON.stringify({ id, summary: "raw advisory evidence" }), "utf8"),
    };
  }
  const body = parseJsonRecord(requestValue.body ?? "");
  const queries = Array.isArray(body.queries) ? body.queries : [];
  return {
    status_code: 200,
    final_url: SCA_OSV_V2_QUERY_BATCH_URL,
    redirected: false,
    body: Buffer.from(
      JSON.stringify({
        results: queries.map((_: unknown, index: number) =>
          advisoryId === undefined || index > 0 ? {} : { vulns: [{ id: advisoryId }] }
        ),
      }),
      "utf8"
    ),
  };
}

class RecordingTransport implements ScaOsvV2Transport {
  readonly ip_confinement = "external_worker_enforced" as const;
  readonly requests: ScaOsvV2TransportRequest[] = [];
  active = 0;
  maxActive = 0;

  constructor(
    private readonly handler: (
      request: ScaOsvV2TransportRequest,
      index: number
    ) => Promise<ScaOsvV2TransportResponse> | ScaOsvV2TransportResponse
  ) {}

  async send(value: ScaOsvV2TransportRequest): Promise<ScaOsvV2TransportResponse> {
    const index = this.requests.length;
    this.requests.push(value);
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      return await this.handler(value, index);
    } finally {
      this.active -= 1;
    }
  }
}

function runOptions(transport: ScaOsvV2Transport) {
  return { transport, now: () => NOW };
}

function redigest(result: ScaOsvResultV2): ScaOsvResultV2 {
  const { result_sha256: digest, ...unsigned } = result;
  expect(digest).toMatch(/^[a-f0-9]{64}$/u);
  return { ...unsigned, result_sha256: sha256(canonicalJson(unsigned)) };
}

function expectOsvError(run: () => unknown, code: ScaOsvV2Error["code"]): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ScaOsvV2Error);
    if (error instanceof ScaOsvV2Error) expect(error.code).toBe(code);
    return;
  }
  throw new Error(`expected OSV v2 error '${code}'`);
}

describe("SCA-P02 controlled OSV planner/executor v2", () => {
  it("plans deterministic source-free batches of at most 128 with an external IP prerequisite", () => {
    const value = request(257);
    const plan = planScaOsvV2(value);
    const replay = planScaOsvV2({
      ...value,
      coordinates: [...value.coordinates].reverse(),
      coordinate_occurrences: [...value.coordinate_occurrences].reverse(),
    });

    expect(plan).toEqual(replay);
    expect(plan.ip_confinement_prerequisite).toBe("external_worker");
    expect(plan.batches.map((batch) => batch.coordinate_ids.length)).toEqual([128, 128, 1]);
    for (const batch of plan.batches) {
      expect(batch.url).toBe("https://api.osv.dev/v1/querybatch");
      expect(batch.method).toBe("POST");
      expect(batch.request_body).not.toContain("depocc_");
      expect(batch.request_body).not.toContain("depcoord_");
      expect(batch.request_body).not.toContain("path");
      expect(Object.keys(parseJsonRecord(batch.request_body))).toEqual(["queries"]);
    }
  });

  it("records exact batch bytes/timestamps and bounded same-origin advisory GET evidence", async () => {
    const value = request(2);
    const transport = new RecordingTransport((transportRequest) =>
      defaultResponse(transportRequest, "OSV-2026-FIXTURE")
    );
    const plan = planScaOsvV2(value);
    const firstCoordinateId = plan.batches[0]?.coordinate_ids[0];
    if (firstCoordinateId === undefined) throw new Error("expected a first planned coordinate");
    const firstInputMapping = value.coordinate_occurrences.find(
      (mapping) => mapping.coordinate_id === firstCoordinateId
    );
    if (firstInputMapping === undefined) throw new Error("expected a first coordinate mapping");
    firstInputMapping.occurrence_ids.push(`depocc_${"f".repeat(64)}`);
    const result = await queryScaOsvV2(value, runOptions(transport));

    expect(result).toMatchObject({
      status: "succeeded",
      origin: "https://api.osv.dev",
      redirects_followed: 0,
      fetched_at: NOW.toISOString(),
      completed_at: NOW.toISOString(),
      freshness_at_completion: "fresh",
      batches_planned: 1,
      batches_completed: 1,
      advisories_planned: 1,
      advisories_completed: 1,
      error_code: "none",
    });
    const batchEvidence = result.batch_evidence[0];
    if (batchEvidence === undefined) throw new Error("expected batch evidence");
    expect(batchEvidence).toMatchObject({
      started_at: NOW.toISOString(),
      completed_at: NOW.toISOString(),
      fetch_state: "completed",
      status_code: 200,
      final_url: SCA_OSV_V2_QUERY_BATCH_URL,
      retention: "full_raw_bytes",
      error_code: "none",
    });
    const rawBatch = Buffer.from(batchEvidence.response_body_base64 ?? "", "base64");
    expect(batchEvidence.response_byte_count).toBe(rawBatch.byteLength);
    expect(batchEvidence.response_sha256).toBe(sha256(rawBatch));
    expect(result.advisory_evidence[0]).toMatchObject({
      advisory_id: "OSV-2026-FIXTURE",
      url: "https://api.osv.dev/v1/vulns/OSV-2026-FIXTURE",
      method: "GET",
      retention: "full_raw_bytes",
      error_code: "none",
    });
    expect(transport.requests.map(({ method }) => method)).toEqual(["POST", "GET"]);
    expect(result.advisory_occurrences[0]).toEqual({
      advisory_id: "OSV-2026-FIXTURE",
      coordinate_ids: [firstCoordinateId],
      occurrence_ids: [...firstInputMapping.occurrence_ids].sort(),
    });
    expect(validateScaOsvResultV2(result, value, plan)).toEqual(result);
  });

  it("caps independent jobs at two across batch and advisory requests", async () => {
    const transport = new RecordingTransport(async (transportRequest) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return defaultResponse(transportRequest, "OSV-2026-CONCURRENCY");
    });
    const first = request(257);
    const second = request(257);
    second.dependency_inventory_sha256 = "c".repeat(64);
    const [firstResult, secondResult] = await Promise.all([
      queryScaOsvV2(first, { transport, now: () => NOW }),
      queryScaOsvV2(second, { transport, now: () => NOW }),
    ]);
    expect(firstResult.status).toBe("succeeded");
    expect(secondResult.status).toBe("succeeded");
    expect(transport.requests.filter(({ method }) => method === "POST")).toHaveLength(6);
    expect(transport.requests.filter(({ method }) => method === "GET")).toHaveLength(2);
    expect(transport.maxActive).toBeLessThanOrEqual(2);
  });

  it("requires positive live freshness and keeps no-expiry policy explicitly offline", async () => {
    const liveNoExpiry = request(1, null);
    await expect(queryScaOsvV2(liveNoExpiry)).rejects.toMatchObject({ code: "invalid_request" });

    const offline = {
      ...request(1, null),
      network_policy: "offline_evidence" as const,
    };
    const result = await queryScaOsvV2(offline, { now: () => NOW });
    expect(result).toMatchObject({
      status: "offline",
      fetched_at: null,
      freshness_at_completion: "not_fetched",
      max_age_seconds: null,
      response_bytes_received: 0,
    });
    expect(result.batch_evidence).toEqual([]);
  });

  it("computes explicit stale freshness from actual successful completion time", async () => {
    const times = [
      new Date("2026-09-20T12:00:00.000Z"),
      new Date("2026-09-20T12:00:01.000Z"),
      new Date("2026-09-20T12:02:00.000Z"),
    ];
    let index = 0;
    const value = request(1, 60);
    const transport = new RecordingTransport((transportRequest) =>
      defaultResponse(transportRequest)
    );
    const plan = planScaOsvV2(value);
    const result = await queryScaOsvV2(value, {
      transport,
      now: () => times[index++] ?? times[times.length - 1] ?? NOW,
    });
    expect(result).toMatchObject({
      fetched_at: "2026-09-20T12:00:01.000Z",
      completed_at: "2026-09-20T12:02:00.000Z",
      freshness_at_completion: "stale",
    });
    expect(
      evaluateScaOsvV2Freshness(result, new Date("2026-09-20T12:00:30.000Z"), value, plan)
    ).toBe("fresh");
    expect(
      evaluateScaOsvV2Freshness(result, new Date("2026-09-20T12:02:00.000Z"), value, plan)
    ).toBe("stale");
  });

  it("keeps no-fetch failures not_fetched and preserves typed transport failures", async () => {
    const value = request(1);
    const noTransport = await queryScaOsvV2(value, { now: () => NOW });
    expect(noTransport).toMatchObject({
      status: "failed",
      fetched_at: null,
      freshness_at_completion: "not_fetched",
      error_code: "transport_failed",
    });

    for (const code of ["response_too_large", "inactivity_timeout"] as const) {
      const transport = new RecordingTransport(() => {
        throw new ScaOsvV2TransportError(code, `fixture ${code}`);
      });
      const result = await queryScaOsvV2(value, runOptions(transport));
      expect(result.error_code).toBe(code);
      expect(result.batch_evidence[0]).toMatchObject({
        fetch_state: "failed",
        error_code: code,
        response_body_base64: null,
      });
      expect(result.fetched_at).toBeNull();
      expect(result.status).toBe(code === "response_too_large" ? "truncated" : "failed");
    }
  });

  it("hashes invalid UTF-8 as exact raw bytes before strict decoding fails", async () => {
    const raw = Buffer.from([0xff, 0xfe, 0x00]);
    const transport = new RecordingTransport(() => ({
      status_code: 200,
      final_url: SCA_OSV_V2_QUERY_BATCH_URL,
      redirected: false,
      body: raw,
    }));
    const value = request(1);
    const result = await queryScaOsvV2(value, runOptions(transport));
    expect(result).toMatchObject({
      status: "failed",
      fetched_at: null,
      freshness_at_completion: "not_fetched",
      error_code: "invalid_response",
    });
    expect(result.batch_evidence[0]).toMatchObject({
      response_byte_count: raw.byteLength,
      response_sha256: sha256(raw),
      response_body_base64: raw.toString("base64"),
      error_code: "invalid_response",
    });
    expect(validateScaOsvResultV2(result, value, planScaOsvV2(value))).toEqual(result);
  });

  it("propagates cancellation and refuses a direct unconfined transport", async () => {
    const unconfined = createUnconfinedFixedOriginOsvV2Transport();
    expect(unconfined.ip_confinement).toBe("not_enforced");
    const denied = await queryScaOsvV2(request(1), {
      transport: unconfined,
      now: () => NOW,
    });
    expect(denied).toMatchObject({
      status: "denied",
      error_code: "ip_confinement_unmet",
      fetched_at: null,
    });

    const controller = new AbortController();
    const transport = new RecordingTransport(
      (transportRequest) =>
        new Promise<ScaOsvV2TransportResponse>((_resolve, reject) => {
          transportRequest.signal.addEventListener(
            "abort",
            () => reject(new ScaOsvV2TransportError("cancelled", "fixture cancellation")),
            { once: true }
          );
        })
    );
    const running = queryScaOsvV2(request(1), {
      transport,
      signal: controller.signal,
      now: () => NOW,
    });
    await Promise.resolve();
    controller.abort();
    const cancelled = await running;
    expect(cancelled).toMatchObject({ status: "cancelled", error_code: "cancelled" });
    expect(cancelled.batch_evidence[0]?.error_code).toBe("cancelled");
  });

  it("bounds advisory-ID retrieval and makes overflow explicit", async () => {
    const value = request(1);
    value.max_advisory_requests = 0;
    const transport = new RecordingTransport((transportRequest) =>
      defaultResponse(transportRequest, "OSV-2026-LIMIT")
    );
    const result = await queryScaOsvV2(value, runOptions(transport));
    expect(result).toMatchObject({
      status: "truncated",
      error_code: "advisory_limit_exceeded",
      advisories_planned: 1,
      advisories_completed: 0,
    });
    expect(transport.requests.map(({ method }) => method)).toEqual(["POST"]);
  });

  it("semantic validation rejects swapped coordinate correspondence after outer redigest", async () => {
    const value = request(2);
    const transport = new RecordingTransport((transportRequest) =>
      defaultResponse(transportRequest)
    );
    const plan = planScaOsvV2(value);
    const result = await queryScaOsvV2(value, runOptions(transport));
    const first = result.coordinate_results[0];
    const second = result.coordinate_results[1];
    if (first === undefined || second === undefined)
      throw new Error("expected two coordinate results");
    const mutated = redigest({
      ...result,
      coordinate_results: [
        { ...first, coordinate_id: second.coordinate_id },
        { ...second, coordinate_id: first.coordinate_id },
      ],
    });
    expectOsvError(() => validateScaOsvResultV2(mutated, value, plan), "semantic_mismatch");
  });
});
