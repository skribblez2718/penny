import * as https from "node:https";
import { BlockList, isIP } from "node:net";
import { checkServerIdentity } from "node:tls";

import {
  exactAllowedTransportRequest,
  ScaOsvV2TransportError,
  type ScaOsvV2Transport,
  type ScaOsvV2TransportRequest,
  type ScaOsvV2TransportResponse,
} from "./osv-v2.js";

const HOST = "api.osv.dev";
const MAX_IPS = 8;
const MAX_BODY_BYTES = 8_388_608;
const MAX_RESPONSE_BYTES = 134_217_728;
const MAX_INACTIVITY_MS = 300_000;

// Conservative public-unicast admission, reviewed against the IANA IPv4/IPv6
// Special-Purpose Address Registries (2026-09-23; links in OSV-V2-FIXED-IP.md).
// Exclude *all* registered special-purpose prefixes, including globally reachable
// protocol/anycast assignments; do not grant narrow exceptions inside broad blocks.
// This is a pinned policy snapshot, not a live routing/ownership oracle. TLS identity
// verification remains mandatory; refresh this table when IANA changes its registries.
const excluded = new BlockList();
for (const [prefix, length] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.31.196.0", 24],
  ["192.52.193.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["192.175.48.0", 24],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  excluded.addSubnet(prefix, length, "ipv4");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
for (const [prefix, length] of [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["2620:4f:8000::", 48],
  ["3fff::", 20],
] as const)
  excluded.addSubnet(prefix, length, "ipv6");

function literalIp(value: unknown): { address: string; family: 4 | 6 } {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new TypeError("OSV IP configuration requires literal IP strings");
  }
  const family = isIP(value);
  if (
    (family === 4 &&
      (value.split(".").some((part) => String(Number(part)) !== part) ||
        excluded.check(value, "ipv4"))) ||
    (family === 6 &&
      (!globalV6.check(value, "ipv6") ||
        excluded.check(value, "ipv6") ||
        new URL(`http://[${value}]/`).hostname.slice(1, -1) !== value)) ||
    (family !== 4 && family !== 6)
  ) {
    throw new TypeError("OSV IP configuration requires public unicast literal addresses");
  }
  return { address: value, family };
}

export function configuredPublicOsvIps(
  value: unknown
): readonly { address: string; family: 4 | 6 }[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_IPS) {
    throw new TypeError("OSV IP configuration must contain 1–8 literal addresses");
  }
  const ips: { address: string; family: 4 | 6 }[] = [];
  for (const entry of value) {
    const ip = literalIp(entry);
    if (ips.some((item) => item.address === ip.address)) {
      throw new TypeError("OSV IP configuration contains a duplicate address");
    }
    ips.push(ip);
  }
  return ips;
}

function validRequest(request: ScaOsvV2TransportRequest): boolean {
  if (
    !exactAllowedTransportRequest(request) ||
    !Number.isInteger(request.inactivity_timeout_ms) ||
    request.inactivity_timeout_ms < 1 ||
    request.inactivity_timeout_ms > MAX_INACTIVITY_MS ||
    !Number.isInteger(request.max_response_bytes) ||
    request.max_response_bytes < 1 ||
    request.max_response_bytes > MAX_RESPONSE_BYTES ||
    !(request.signal instanceof AbortSignal)
  )
    return false;
  if (request.method === "GET") return true;
  if (request.body === null || Buffer.byteLength(request.body, "utf8") > MAX_BODY_BYTES)
    return false;
  // The transport only accepts the planner's JSON query shape, not arbitrary POST bytes.
  let body: unknown;
  try {
    body = JSON.parse(request.body);
  } catch {
    return false;
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return false;
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== "queries" || !("queries" in body)) return false;
  const queries = body.queries;
  return (
    Array.isArray(queries) &&
    queries.length > 0 &&
    queries.length <= 128 &&
    queries.every((query: unknown) => {
      if (typeof query !== "object" || query === null || Array.isArray(query)) return false;
      if (!("package" in query) || !("version" in query) || Object.keys(query).length !== 2)
        return false;
      const pkg = query.package;
      return (
        typeof pkg === "object" &&
        pkg !== null &&
        !Array.isArray(pkg) &&
        "ecosystem" in pkg &&
        "name" in pkg &&
        Object.keys(pkg).length === 2 &&
        (pkg.ecosystem === "npm" || pkg.ecosystem === "Packagist") &&
        typeof pkg.name === "string" &&
        pkg.name.length > 0 &&
        pkg.name.length <= 4_096 &&
        typeof query.version === "string" &&
        query.version.length > 0 &&
        query.version.length <= 4_096
      );
    })
  );
}

class PreResponseConnectionError extends ScaOsvV2TransportError {}

function attempt(
  request: ScaOsvV2TransportRequest,
  ip: { address: string; family: 4 | 6 }
): Promise<ScaOsvV2TransportResponse> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let receivedResponse = false;
    let timer: NodeJS.Timeout | undefined;
    const fail = (code: ScaOsvV2TransportError["code"], retryable = false): void => {
      if (settled) return;
      settled = true;
      cleanup();
      nodeRequest.destroy();
      reject(
        retryable
          ? new PreResponseConnectionError(code, `OSV transport ${code}`)
          : new ScaOsvV2TransportError(code, `OSV transport ${code}`)
      );
    };
    const renew = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => fail("inactivity_timeout"), request.inactivity_timeout_ms);
    };
    const abort = (): void => fail("cancelled");
    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      request.signal.removeEventListener("abort", abort);
    };
    const path = new URL(request.url).pathname;
    // No fetch, ambient proxy agent, redirect machinery, user headers, credentials, or DNS fallback.
    // Node's socket lookup is invoked for the fixed hostname only; explicit family disables auto-family retries.
    const nodeRequest = https.request(
      {
        protocol: "https:",
        hostname: HOST,
        port: 443,
        path,
        method: request.method,
        servername: HOST,
        rejectUnauthorized: true,
        checkServerIdentity,
        agent: false,
        family: ip.family,
        lookup: (hostname, options, callback) => {
          if (hostname !== HOST) {
            callback(new Error("OSV hostname drift"), "");
          } else if (options.all) {
            callback(null, [{ address: ip.address, family: ip.family }]);
          } else {
            callback(null, ip.address, ip.family);
          }
        },
        headers:
          request.method === "POST"
            ? {
                Accept: "application/json",
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(request.body ?? "", "utf8"),
                Connection: "close",
              }
            : { Accept: "application/json", Connection: "close" },
      },
      (response) => {
        receivedResponse = true;
        const status = response.statusCode;
        if (status === undefined || status < 200 || status >= 300) {
          fail(
            status !== undefined && status >= 300 && status < 400
              ? "redirect_refused"
              : "http_error"
          );
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          if (settled) return;
          bytes += chunk.byteLength;
          if (bytes > request.max_response_bytes) {
            fail("response_too_large");
            return;
          }
          chunks.push(chunk);
          renew();
        });
        response.on("end", () => {
          if (settled) return;
          if (!response.complete) {
            fail("transport_failed");
            return;
          }
          settled = true;
          cleanup();
          resolve({
            status_code: status,
            final_url: request.url,
            redirected: false,
            body: Buffer.concat(chunks, bytes),
          });
        });
        response.on("error", () => fail("transport_failed"));
        response.on("aborted", () => fail("transport_failed"));
        response.on("close", () => {
          if (!response.complete) fail("transport_failed");
        });
      }
    );
    nodeRequest.on("error", (error: NodeJS.ErrnoException) => {
      const retryable =
        !receivedResponse &&
        ["ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH", "ETIMEDOUT", "ECONNRESET"].includes(
          error.code ?? ""
        );
      fail(
        request.signal.aborted ? "cancelled" : "transport_failed",
        retryable && !request.signal.aborted
      );
    });
    nodeRequest.on("socket", (socket) => socket.on("secureConnect", renew));
    request.signal.addEventListener("abort", abort, { once: true });
    if (request.signal.aborted) {
      abort();
      return;
    }
    renew();
    nodeRequest.end(request.body ?? undefined);
  });
}

/** In-process fixed-IP HTTPS, not externally confined; never resolves DNS or reads environment configuration. */
export function createFixedIpOsvV2Transport(ipAddresses: unknown): ScaOsvV2Transport {
  const ips = configuredPublicOsvIps(ipAddresses);
  return Object.freeze({
    // Fixed lookup and TLS live in this process; no independent egress boundary exists.
    ip_confinement: "not_enforced" as const,
    async send(request: ScaOsvV2TransportRequest): Promise<ScaOsvV2TransportResponse> {
      if (!validRequest(request)) {
        throw new ScaOsvV2TransportError(
          "transport_failed",
          "OSV destination or request is not allowed"
        );
      }
      if (request.signal.aborted)
        throw new ScaOsvV2TransportError("cancelled", "OSV request was cancelled");
      for (const [index, ip] of ips.entries()) {
        try {
          return await attempt(request, ip);
        } catch (error) {
          // Retry only a pre-response connection failure, not HTTP status, TLS policy,
          // cancellation, timeout, or partial response. No DNS/proxy fallback.
          if (request.signal.aborted)
            throw new ScaOsvV2TransportError("cancelled", "OSV request was cancelled");
          if (!(error instanceof PreResponseConnectionError) || index === ips.length - 1)
            throw error;
        }
      }
      throw new ScaOsvV2TransportError("transport_failed", "OSV addresses exhausted");
    },
  });
}
