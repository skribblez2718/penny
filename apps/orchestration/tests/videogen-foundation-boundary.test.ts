import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { inspectVideogenPublicBoundary } from "../dist/videogen/public-boundary.js";
const root = path.resolve(import.meta.dirname, "../../..");
const files = [
  "bounds",
  "foundation-contracts",
  "rights-ledger",
  "admission",
  "budget",
  "gates",
  "completion",
  "rational-time",
  "shot-modes",
  "timeline-validation",
  "public-boundary",
];
describe("WP001 generic public boundary and traceability", () => {
  it("scans every new foundation source, including the guard; injected selectors remain data", () => {
    expect(
      inspectVideogenPublicBoundary([
        ...files.map((name) => ({
          path: name,
          content: readFileSync(
            path.join(root, "apps/orchestration/src/videogen", `${name}.ts`),
            "utf8"
          ),
        })),
        ...["boundary", "contracts", "rights", "time", "gates"].map((name) => ({
          path: `tests/${name}`,
          content: readFileSync(
            path.join(import.meta.dirname, `videogen-foundation-${name}.test.ts`),
            "utf8"
          ),
        })),
        {
          path: "tests/helpers/videogen-foundation-fixtures.ts",
          content: readFileSync(
            path.join(import.meta.dirname, "helpers/videogen-foundation-fixtures.ts"),
            "utf8"
          ),
        },
      ])
    ).toEqual([]);
    expect(
      inspectVideogenPublicBoundary([
        {
          path: "generic.ts",
          content:
            "const destination = host.admitted_destination_id; const profile = host.current_capability;",
        },
      ])
    ).toEqual([]);
  });
  it.each(["operator_path", "endpoint", "secret", "model_default", "downstream_binding"] as const)(
    "rejects a synthetic %s binding without embedding private data",
    (rule) => {
      const samples = {
        operator_path: ["const root = '/", "home/fixture/private';"].join(""),
        endpoint: ["const endpoint = 'http", "://127.0.0.1:9999';"].join(""),
        secret: ["api_", "key = 'synthetic-fixture-only';"].join(""),
        model_default: ["default_", "model = 'synthetic-checkpoint';"].join(""),
        downstream_binding: ["downstream_", "project = 'synthetic-project';"].join(""),
      };
      expect(
        inspectVideogenPublicBoundary([{ path: "fixture.ts", content: samples[rule] }])
      ).toEqual([{ path: "fixture.ts", rule }]);
    }
  );
  it("traceability has exact authorized WP/REQ/AC mapping and explicitly partial status", () => {
    const value: unknown = JSON.parse(
      readFileSync(
        path.join(import.meta.dirname, "fixtures/videogen/foundation-traceability.v1.json"),
        "utf8"
      )
    );
    expect(value).toEqual({
      schema_version: 1,
      scope: "provider-free-foundation-only",
      production_registration: false,
      work_packages: [
        { wp: "VG-WP-001", ac: ["AC-048"] },
        { wp: "VG-WP-002", ac: ["AC-001", "AC-003", "AC-034", "AC-044"] },
        { wp: "VG-WP-003", ac: ["AC-004", "AC-018", "AC-041"] },
        {
          wp: "VG-WP-004",
          ac: ["AC-005", "AC-007", "AC-009", "AC-012", "AC-015", "AC-017", "AC-043"],
        },
        { wp: "VG-WP-005", ac: ["AC-008", "AC-033", "AC-038"] },
      ],
      deferred: [
        "atomic_capacity_owner",
        "media_proof_adapters",
        "native_package_proof",
        "delivery_proof",
        "production_state_machine",
        "live_qualification",
        "UC-01..UC-18",
      ],
    });
  });
});
