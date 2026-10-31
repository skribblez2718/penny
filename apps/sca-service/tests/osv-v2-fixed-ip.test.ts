import { EventEmitter } from "node:events";
import { checkServerIdentity } from "node:tls";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { scaDependencyCoordinateIdV2 } from "../src/adapters/dependency-inventory-v2.js";
import { createFixedIpOsvV2Transport } from "../src/adapters/osv-v2-fixed-ip.js";
import {
  SCA_OSV_V2_QUERY_BATCH_URL,
  ScaOsvV2TransportError,
  planScaOsvV2,
  queryScaOsvV2,
  validateScaOsvResultV2,
  type ScaOsvV2TransportRequest,
} from "../src/adapters/osv-v2.js";

const mocked = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("node:https", () => ({ request: mocked.request }));

const calls: Record<string, unknown>[] = [];
let behavior: (
  req: EventEmitter,
  respond: (status: number, chunks?: Buffer[], complete?: boolean) => void
) => void;
function callable(value: unknown): value is (...args: unknown[]) => void {
  return typeof value === "function";
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function fakeRequest(
  options: unknown,
  callback: unknown
): EventEmitter & { end: (body?: string) => void; destroy: () => void } {
  if (!record(options) || !callable(callback)) throw new Error("unexpected HTTPS call");
  calls.push(options);
  const req = new EventEmitter();
  const respond = (
    status: number,
    chunks: Buffer[] = [Buffer.from("{}")],
    complete = true
  ): void => {
    const res = new EventEmitter();
    Object.assign(res, { statusCode: status, complete });
    callback(res);
    for (const chunk of chunks) res.emit("data", chunk);
    res.emit("end");
  };
  return Object.assign(req, {
    end: () => {
      queueMicrotask(() => behavior(req, respond));
    },
    destroy: () => {
      req.emit("close");
    },
  });
}

beforeEach(() => {
  calls.length = 0;
  mocked.request.mockImplementation(fakeRequest);
  behavior = (_req, respond) => respond(200);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

function transportRequest(
  overrides: Partial<ScaOsvV2TransportRequest> = {}
): ScaOsvV2TransportRequest {
  return {
    url: SCA_OSV_V2_QUERY_BATCH_URL,
    method: "POST",
    body: '{"queries":[{"package":{"ecosystem":"npm","name":"test"},"version":"1.0.0"}]}',
    inactivity_timeout_ms: 200,
    max_response_bytes: 64,
    signal: new AbortController().signal,
    ...overrides,
  };
}
const publicIps = ["1.1.1.1", "8.8.8.8"];

function httpsOptions(index = 0): Record<string, unknown> {
  const value = calls[index];
  if (value === undefined) throw new Error("missing HTTPS call");
  return value;
}

async function expectFailure(
  request: ScaOsvV2TransportRequest,
  code: ScaOsvV2TransportError["code"]
): Promise<void> {
  await expect(createFixedIpOsvV2Transport(publicIps).send(request)).rejects.toMatchObject({
    code,
  });
}

describe("OSV v2 operator-configured fixed IP transport", () => {
  it("cannot issue live-qualified P02 evidence when passed to the v2 executor", async () => {
    const digest = "a".repeat(64);
    const coordinate = {
      ecosystem: "npm" as const,
      name: "fixture",
      version: "1.0.0",
      coordinate_id: scaDependencyCoordinateIdV2("npm", "fixture", "1.0.0"),
    };
    const request = {
      schema_id: "penny.sca-osv-request.v2",
      schema_version: 2,
      source_snapshot_sha256: digest,
      dependency_inventory_sha256: digest,
      coordinates: [coordinate],
      coordinate_occurrences: [
        { coordinate_id: coordinate.coordinate_id, occurrence_ids: [`depocc_${digest}`] },
      ],
      network_policy: "fixed_osv_origin_authorized" as const,
      ip_confinement: "external_worker_required" as const,
      inactivity_timeout_ms: 200,
      max_response_bytes: 64,
      concurrency: 1,
      max_advisory_requests: 0,
      max_age_seconds: 3_600,
    };
    const plan = planScaOsvV2(request);
    const result = await queryScaOsvV2(request, {
      transport: createFixedIpOsvV2Transport(publicIps),
    });
    expect(result).toMatchObject({
      status: "denied",
      error_code: "ip_confinement_unmet",
      ip_confinement_prerequisite: "external_worker",
      batch_evidence: [],
      fetched_at: null,
    });
    expect(validateScaOsvResultV2(result, request, plan)).toEqual(result);
    expect(calls).toHaveLength(0);
  });
  it.each([
    ["empty", []],
    ["missing", undefined],
    ["hostname", ["api.osv.dev"]],
    ["whitespace", ["8.8.8.8 "]],
    ["ambiguous IPv4", ["08.8.8.8"]],
    ["duplicate", ["8.8.8.8", "8.8.8.8"]],
    ["too many", Array(9).fill("8.8.8.8")],
  ])("rejects %s IP configuration before connection", (_case, ips) => {
    expect(() => createFixedIpOsvV2Transport(ips)).toThrow();
    expect(calls).toHaveLength(0);
  });

  // Representatives from every excluded IANA special-purpose IPv4 block, plus
  // multicast and IPv6 non-global/unicast exclusions. No IANA anycast exception.
  it.each([
    "0.1.2.3",
    "10.1.2.3",
    "100.64.1.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.0.0.9",
    "192.0.2.1",
    "192.31.196.1",
    "192.52.193.1",
    "192.88.99.1",
    "192.88.99.2",
    "192.88.99.254",
    "192.168.1.1",
    "192.175.48.1",
    "198.18.0.1",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "239.1.2.3",
    "240.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "::ffff:8.8.8.8",
    "64:ff9b::808:808",
    "100::1",
    "2001::1",
    "2001:1::1",
    "2001:2::1",
    "2001:db8::1",
    "2002::1",
    "2620:4f:8000::1",
    "3fff::1",
    "5f00::1",
    "fc00::1",
    "fe80::1",
  ])("rejects special-purpose/non-public literal %s", (ip) => {
    expect(() => createFixedIpOsvV2Transport([ip])).toThrow();
    expect(calls).toHaveLength(0);
  });

  it.each([
    "1.1.1.1",
    "8.8.8.8",
    "9.9.9.9",
    "142.250.10.121",
    "2606:4700:4700::1111",
    "2001:4860:4860::8888",
  ])("admits ordinary public unicast literal %s but does not claim confinement", (ip) => {
    expect(createFixedIpOsvV2Transport([ip]).ip_confinement).toBe("not_enforced");
    expect(calls).toHaveLength(0);
  });

  it("pins TLS identity and lookup to the selected IP, ignoring ambient proxy settings", async () => {
    vi.stubEnv("HTTPS_PROXY", "http://127.0.0.1:4444");
    vi.stubEnv("HTTP_PROXY", "http://127.0.0.1:4444");
    vi.stubEnv("NO_PROXY", "*");
    const response = await createFixedIpOsvV2Transport(publicIps).send(transportRequest());
    expect(response).toMatchObject({
      status_code: 200,
      redirected: false,
      final_url: SCA_OSV_V2_QUERY_BATCH_URL,
    });
    const options = httpsOptions();
    expect(options).toMatchObject({
      protocol: "https:",
      hostname: "api.osv.dev",
      port: 443,
      servername: "api.osv.dev",
      rejectUnauthorized: true,
      agent: false,
      family: 4,
      method: "POST",
      path: "/v1/querybatch",
    });
    expect(options.headers).toEqual({
      Accept: "application/json",
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(transportRequest().body ?? ""),
      Connection: "close",
    });
    expect(options.checkServerIdentity).toBe(checkServerIdentity);
    expect(typeof options.lookup).toBe("function");
    if (!callable(options.lookup)) throw new Error("missing fixed lookup");
    const lookup = options.lookup;
    const results: unknown[][] = [];
    lookup("api.osv.dev", { all: false }, (...args: unknown[]) => results.push(args));
    lookup("api.osv.dev", { all: true }, (...args: unknown[]) => results.push(args));
    lookup("evil.example", { all: false }, (...args: unknown[]) => results.push(args));
    expect(results.slice(0, 2)).toEqual([
      [null, "1.1.1.1", 4],
      [null, [{ address: "1.1.1.1", family: 4 }]],
    ]);
    expect(results[2]?.[0]).toBeInstanceOf(Error);
    expect(calls).toHaveLength(1);
  });

  it("refuses origin, credential, redirect path, method, and body misuse without a socket", async () => {
    for (const value of [
      { url: "http://api.osv.dev/v1/querybatch" },
      { url: "https://api.osv.dev:444/v1/querybatch" },
      { url: "https://evil.example/v1/querybatch" },
      { url: "https://user@api.osv.dev/v1/querybatch" },
      { url: "https://api.osv.dev/v1/querybatch?next=evil" },
      { url: "https://api.osv.dev/v1/vulns/x" },
      { url: "https://api.osv.dev/v1/vulns/../querybatch" },
      { method: "GET", body: "{}" },
      { method: "GET", body: null, url: "https://api.osv.dev/v1/querybatch" },
      { body: null },
      { body: "not json" },
      { body: '{"queries":[{"url":"http://127.0.0.1"}]}' },
    ] as Partial<ScaOsvV2TransportRequest>[]) {
      await expectFailure(transportRequest(value), "transport_failed");
    }
    expect(calls).toHaveLength(0);
    const get = await createFixedIpOsvV2Transport(publicIps).send(
      transportRequest({
        method: "GET",
        body: null,
        url: "https://api.osv.dev/v1/vulns/OSV-2026-1",
      })
    );
    expect(get.status_code).toBe(200);
    expect(httpsOptions().headers).toEqual({ Accept: "application/json", Connection: "close" });
  });

  it("does not follow redirects or accept error status, and does not fail over after a response", async () => {
    for (const [status, code] of [
      [302, "redirect_refused"],
      [304, "redirect_refused"],
      [500, "http_error"],
    ] as const) {
      calls.length = 0;
      behavior = (_req, respond) => respond(status);
      await expectFailure(transportRequest(), code);
      expect(calls).toHaveLength(1);
    }
  });

  it("never accepts or retries an incomplete response on another IP", async () => {
    behavior = (_req, respond) => respond(200, [Buffer.from("partial")], false);
    await expectFailure(transportRequest(), "transport_failed");
    expect(calls).toHaveLength(1);
  });

  it("enforces response byte limit before buffering any overflow", async () => {
    behavior = (_req, respond) => respond(200, [Buffer.alloc(32), Buffer.alloc(33)]);
    await expectFailure(transportRequest(), "response_too_large");
    expect(calls).toHaveLength(1);
  });

  it("bounds connection inactivity and caller cancellation even before the socket connects", async () => {
    vi.useFakeTimers();
    behavior = () => {};
    const timed = expect(
      createFixedIpOsvV2Transport(publicIps).send(transportRequest({ inactivity_timeout_ms: 10 }))
    ).rejects.toMatchObject({ code: "inactivity_timeout" });
    await vi.advanceTimersByTimeAsync(11);
    await timed;
    expect(calls).toHaveLength(1);
    const controller = new AbortController();
    const cancelled = createFixedIpOsvV2Transport(publicIps).send(
      transportRequest({ signal: controller.signal })
    );
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ code: "cancelled" });
    expect(calls).toHaveLength(2);
    await expectFailure(transportRequest({ signal: controller.signal }), "cancelled");
    expect(calls).toHaveLength(2);
  });

  it("fails over only for pre-response connection errors, without consulting DNS", async () => {
    behavior = (req, respond) => {
      if (calls.length === 1)
        req.emit("error", Object.assign(new Error("refused"), { code: "ECONNREFUSED" }));
      else respond(200, [Buffer.from("ok")]);
    };
    const response = await createFixedIpOsvV2Transport(publicIps).send(transportRequest());
    expect(response.body.toString()).toBe("ok");
    expect(calls).toHaveLength(2);
    const second = httpsOptions(1);
    if (!callable(second.lookup)) throw new Error("missing lookup");
    const results: unknown[][] = [];
    second.lookup("api.osv.dev", { all: false }, (...args: unknown[]) => results.push(args));
    expect(results).toEqual([[null, "8.8.8.8", 4]]);
    calls.length = 0;
    behavior = (req) =>
      req.emit(
        "error",
        Object.assign(new Error("certificate"), { code: "ERR_TLS_CERT_ALTNAME_INVALID" })
      );
    await expectFailure(transportRequest(), "transport_failed");
    expect(calls).toHaveLength(1);
  });
});
