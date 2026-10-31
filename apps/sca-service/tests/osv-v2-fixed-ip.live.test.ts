import { expect, it } from "vitest";

import { canonicalJson, sha256 } from "../../orchestration/dist/canonical-json.js";
import { scaDependencyCoordinateIdV2 } from "../src/adapters/dependency-inventory-v2.js";
import { createFixedIpOsvV2Transport } from "../src/adapters/osv-v2-fixed-ip.js";
import { parseScaOsvV2BatchResults, planScaOsvV2, queryScaOsvV2 } from "../src/adapters/osv-v2.js";

/** Explicit operator opt-in; never reads a repository corpus, manifest, or package lock. */
it.skipIf(process.env.PENNY_OSV_V2_LIVE_CONFIG === undefined)(
  "smokes fixed-IP HTTPS and OSV batch semantics without issuing P02 evidence",
  async () => {
    const raw = process.env.PENNY_OSV_V2_LIVE_CONFIG;
    if (raw === undefined || Buffer.byteLength(raw) > 4_096)
      throw new Error("live config missing or oversized");
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      Object.keys(parsed).sort().join(",") !== "ips,package,version" ||
      !("ips" in parsed) ||
      !("package" in parsed) ||
      !("version" in parsed) ||
      typeof parsed.package !== "string" ||
      !/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/u.test(parsed.package) ||
      parsed.package.length > 256 ||
      typeof parsed.version !== "string" ||
      !/^[0-9][a-zA-Z0-9.+_-]{0,127}$/u.test(parsed.version)
    ) {
      throw new Error("live config requires exactly ips, approved npm package, and version");
    }
    const transport = createFixedIpOsvV2Transport(parsed.ips);
    expect(transport.ip_confinement).toBe("not_enforced");
    const coordinate = {
      ecosystem: "npm" as const,
      name: parsed.package,
      version: parsed.version,
      coordinate_id: scaDependencyCoordinateIdV2("npm", parsed.package, parsed.version),
    };
    const binding = sha256(canonicalJson(coordinate));
    const request = {
      schema_id: "penny.sca-osv-request.v2",
      schema_version: 2,
      source_snapshot_sha256: binding,
      dependency_inventory_sha256: binding,
      coordinates: [coordinate],
      coordinate_occurrences: [
        { coordinate_id: coordinate.coordinate_id, occurrence_ids: [`depocc_${binding}`] },
      ],
      network_policy: "fixed_osv_origin_authorized" as const,
      ip_confinement: "external_worker_required" as const,
      inactivity_timeout_ms: 10_000,
      max_response_bytes: 1_048_576,
      concurrency: 1,
      max_advisory_requests: 16,
      max_age_seconds: 3_600,
    };
    const plan = planScaOsvV2(request);
    const batch = plan.batches[0];
    if (plan.batches.length !== 1 || batch === undefined) throw new Error("expected one batch");
    expect(batch.request_body).toBe(
      canonicalJson({
        queries: [
          { package: { ecosystem: "npm", name: coordinate.name }, version: coordinate.version },
        ],
      })
    );
    // The executor must deny this same transport before any request; only the raw
    // transport is exercised below. No result or live-qualified P02 evidence is issued.
    const denied = await queryScaOsvV2(request, { transport });
    expect(denied).toMatchObject({ status: "denied", error_code: "ip_confinement_unmet" });
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await transport.send({
        url: batch.url,
        method: "POST",
        body: batch.request_body,
        inactivity_timeout_ms: request.inactivity_timeout_ms,
        max_response_bytes: request.max_response_bytes,
        signal: controller.signal,
      });
      expect(response.status_code).toBe(200);
      expect(response.final_url).toBe(batch.url);
      expect(response.redirected).toBe(false);
      const results = parseScaOsvV2BatchResults(batch, response.body);
      expect(results).toHaveLength(1);
      expect(results[0]?.coordinate_id).toBe(coordinate.coordinate_id);
      // Connectivity/semantics only: no plan/result evidence digest or advisory bodies.
      process.stdout.write(
        `${canonicalJson({
          smoke: "fixed_ip_https_not_p02_qualified",
          binding,
          response_sha256: sha256(response.body),
          status_code: response.status_code,
          advisory_count: results[0]?.advisory_ids.length,
        })}\n`
      );
    } finally {
      clearTimeout(deadline);
    }
  },
  40_000
);
