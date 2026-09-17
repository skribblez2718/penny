import { describe, expect, it } from "vitest";

import {
  SCA_OSV_ORIGIN,
  SCA_OSV_QUERY_BATCH_URL,
  ScaOsvError,
  createFixedOsvTransport,
  queryScaOsvV1,
  type ScaOsvTransport,
  type ScaOsvTransportRequest,
  type ScaOsvTransportResponse,
} from "../src/adapters/osv.js";

const SNAPSHOT = "a".repeat(64);
const INVENTORY = "b".repeat(64);
const NOW = new Date("2026-09-15T12:00:00.000Z");

function request(
  network_policy: "disabled" | "fixed_osv_origin_authorized" = "fixed_osv_origin_authorized"
) {
  return {
    schema_id: "penny.sca-osv-request.v1",
    schema_version: 1,
    source_snapshot_sha256: SNAPSHOT,
    dependency_inventory_sha256: INVENTORY,
    coordinates: [
      { ecosystem: "npm", name: "alpha", version: "1.0.0" },
      { ecosystem: "Packagist", name: "vendor/beta", version: "2.0.0" },
    ],
    network_policy,
    timeout_ms: 2_000,
    max_response_bytes: 16_384,
  };
}

class FixtureTransport implements ScaOsvTransport {
  readonly requests: ScaOsvTransportRequest[] = [];

  constructor(private readonly responses: ScaOsvTransportResponse[]) {}

  async send(value: ScaOsvTransportRequest): Promise<ScaOsvTransportResponse> {
    this.requests.push(value);
    const response = this.responses.shift();
    if (response === undefined) throw new Error("unexpected OSV request");
    return response;
  }
}

function response(url: string, body: unknown): ScaOsvTransportResponse {
  return {
    status_code: 200,
    final_url: url,
    redirected: false,
    body: JSON.stringify(body),
  };
}

describe("S-04-T3 fixed-destination OSV adapter", () => {
  it("completes an empty ecosystem without network access", async () => {
    const transport = new FixtureTransport([]);
    const result = await queryScaOsvV1(
      { ...request("disabled"), coordinates: [] },
      { transport, now: () => NOW }
    );
    expect(result).toMatchObject({
      status: "succeeded",
      error_code: "none",
      coordinates_queried: 0,
      advisory_count: 0,
      pagination_complete: true,
    });
    expect(transport.requests).toEqual([]);
  });

  it("distinguishes a complete no-match response from unavailability", async () => {
    const transport = new FixtureTransport([
      response(SCA_OSV_QUERY_BATCH_URL, { results: [{}, {}] }),
    ]);
    const noMatch = await queryScaOsvV1(request(), { transport, now: () => NOW });
    expect(noMatch).toMatchObject({
      status: "succeeded",
      error_code: "none",
      coordinates_queried: 2,
      advisory_count: 0,
      pagination_complete: true,
      origin: SCA_OSV_ORIGIN,
      redirects_followed: 0,
    });
    expect(noMatch.responses).toHaveLength(1);

    const disabledTransport = new FixtureTransport([]);
    const unavailable = await queryScaOsvV1(request("disabled"), {
      transport: disabledTransport,
      now: () => NOW,
    });
    expect(unavailable).toMatchObject({
      status: "unavailable",
      error_code: "network_disabled",
      coordinates_queried: 0,
      pagination_complete: false,
    });
    expect(disabledTransport.requests).toEqual([]);
  });

  it("uses only querybatch and returned-ID URLs and preserves response identities", async () => {
    const advisoryId = "OSV-2026-FIXTURE";
    const advisoryUrl = `${SCA_OSV_ORIGIN}/v1/vulns/${advisoryId}`;
    const transport = new FixtureTransport([
      response(SCA_OSV_QUERY_BATCH_URL, {
        results: [{ vulns: [{ id: advisoryId }] }, { vulns: [{ id: advisoryId }] }],
      }),
      response(advisoryUrl, {
        id: advisoryId,
        modified: "2026-09-01T00:00:00Z",
        published: "2026-08-01T00:00:00Z",
        aliases: ["CVE-2026-0001"],
        affected: [
          {
            package: { ecosystem: "npm", name: "alpha" },
            versions: ["1.0.0"],
          },
        ],
      }),
    ]);
    const result = await queryScaOsvV1(request(), { transport, now: () => NOW });
    expect(transport.requests.map(({ url, method }) => ({ url, method }))).toEqual([
      { url: SCA_OSV_QUERY_BATCH_URL, method: "POST" },
      { url: advisoryUrl, method: "GET" },
    ]);
    expect(JSON.parse(transport.requests[0]?.body ?? "null")).toEqual({
      queries: [
        { package: { ecosystem: "npm", name: "alpha" }, version: "1.0.0" },
        { package: { ecosystem: "Packagist", name: "vendor/beta" }, version: "2.0.0" },
      ],
    });
    expect(result).toMatchObject({
      status: "succeeded",
      error_code: "none",
      advisory_count: 1,
      pagination_complete: true,
    });
    expect(result.advisories[0]).toMatchObject({
      id: advisoryId,
      aliases: ["CVE-2026-0001"],
      affected: [{ ecosystem: "npm", name: "alpha", version: "1.0.0" }],
    });
    expect(result.responses).toHaveLength(2);
  });

  it("keeps transport, redirect, malformed, and partial advisory failures distinct from no-match", async () => {
    const redirect = new FixtureTransport([
      {
        status_code: 200,
        final_url: "https://example.invalid/redirect",
        redirected: true,
        body: JSON.stringify({ results: [{}, {}] }),
      },
    ]);
    expect(await queryScaOsvV1(request(), { transport: redirect, now: () => NOW })).toMatchObject({
      status: "failed",
      error_code: "redirect_refused",
      pagination_complete: false,
    });

    const malformed = new FixtureTransport([response(SCA_OSV_QUERY_BATCH_URL, { results: [{}] })]);
    expect(await queryScaOsvV1(request(), { transport: malformed, now: () => NOW })).toMatchObject({
      status: "partial",
      error_code: "invalid_response",
      advisory_count: 0,
    });

    const advisoryId = "OSV-2026-PARTIAL";
    const partial = new FixtureTransport([
      response(SCA_OSV_QUERY_BATCH_URL, {
        results: [{ vulns: [{ id: advisoryId }] }, {}],
      }),
      response(`${SCA_OSV_ORIGIN}/v1/vulns/${advisoryId}`, { id: "wrong", modified: "bad" }),
    ]);
    expect(await queryScaOsvV1(request(), { transport: partial, now: () => NOW })).toMatchObject({
      status: "partial",
      error_code: "invalid_response",
      advisory_count: 0,
      pagination_complete: false,
    });
  });

  it("refuses caller-selected destinations before any network request", async () => {
    await expect(
      createFixedOsvTransport().send({
        url: "https://example.invalid/v1/querybatch",
        method: "POST",
        body: "{}",
        timeout_ms: 1_000,
        max_response_bytes: 1_000,
      })
    ).rejects.toThrow("destination or method is not allowed");
  });

  it("rejects unknown fields, duplicate coordinates, and an invalid clock before transport", async () => {
    await expect(queryScaOsvV1({ ...request(), unexpected: true })).rejects.toMatchObject({
      code: "invalid_request",
    });
    const duplicated = request();
    await expect(
      queryScaOsvV1({
        ...duplicated,
        coordinates: [duplicated.coordinates[0], duplicated.coordinates[0]],
      })
    ).rejects.toBeInstanceOf(ScaOsvError);
    await expect(
      queryScaOsvV1(request(), { now: () => new Date(Number.NaN) })
    ).rejects.toMatchObject({ code: "invalid_clock" });
  });
});
