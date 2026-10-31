import { readFileSync } from "node:fs";

import { canonicalJson, sha256 } from "../../orchestration/dist/canonical-json.js";
import { validateSourceOracleBytes } from "../src/p03-source-oracle.js";

/** Test-only, canonical authority for deterministic plumbing. Never AC-P03 live evidence. */
export function syntheticSourceOracle() {
  const reviewed = validateSourceOracleBytes(
    readFileSync(new URL("./fixtures/p03-v2/oracle.json", import.meta.url))
  );
  const fixtures = reviewed.fixtures.map((fixture) => ({
    ...fixture,
    material_cases: fixture.material_cases.map((entry) =>
      entry.query_id === "p03.control-guard.v2" || entry.query_id === "p03.framework-dispatch.v2"
        ? {
            ...entry,
            assertions: entry.assertions
              .map((assertion) => ({
                ...assertion,
                disposition: "unresolved" as const,
                reason_code: "relationship_unproven",
                edge: {
                  ...assertion.edge,
                  kind:
                    entry.query_id === "p03.control-guard.v2"
                      ? ("cfg" as const)
                      : ("call" as const),
                  provenance: "observed_cpg" as const,
                  branch_orientation: null,
                },
                ...(entry.query_id === "p03.framework-dispatch.v2"
                  ? {
                      framework: null,
                      registration_form: null,
                      callback_resolution: "dynamic" as const,
                    }
                  : {}),
              }))
              .sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b))),
          }
        : entry
    ),
  }));
  const unsigned = {
    schema_id: reviewed.schema_id,
    schema_version: reviewed.schema_version,
    note: "Synthetic deterministic plumbing only: control and framework edges unresolved/non-material; not AC-P03 evidence.",
    material_dimensions: reviewed.material_dimensions,
    fixtures,
    parser: reviewed.parser,
  };
  const oracle = validateSourceOracleBytes(
    Buffer.from(canonicalJson({ ...unsigned, oracle_sha256: sha256(canonicalJson(unsigned)) }))
  );
  for (const fixture of oracle.fixtures) {
    for (const query_id of ["p03.control-guard.v2", "p03.framework-dispatch.v2"]) {
      const entry = fixture.material_cases.find((item) => item.query_id === query_id);
      if (!entry || entry.assertions.some((assertion) => assertion.disposition !== "unresolved"))
        throw new Error("synthetic oracle claimed unsupported fidelity");
    }
  }
  return oracle;
}
