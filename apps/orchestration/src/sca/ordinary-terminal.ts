import { Type } from "typebox";
import { Value } from "typebox/value";
import type { ArtifactHostStore } from "../artifact-store.js";
import { canonicalJson } from "../canonical-json.js";
import { TerminalDirectiveSchema, validateContract, type ArtifactRef } from "../contracts.js";
import { exactJson } from "./ordinary-artifacts.js";
import { ScaReportProductSchema } from "./ordinary-report.js";

/** Existing output manifest, now checked before persistence and exact retrieval. */
export const ScaOutputManifestSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    status: Type.Union([
      Type.Literal("complete"),
      Type.Literal("incomplete"),
      Type.Literal("cancelled"),
    ]),
    source_snapshot_sha256: ScaReportProductSchema.properties.source_snapshot_sha256,
    outputs: TerminalDirectiveSchema.properties.artifacts,
    unresolved: ScaReportProductSchema.properties.gaps,
    target_execution: ScaReportProductSchema.properties.reproduction,
    publication_performed: Type.Literal(false),
  },
  { additionalProperties: false }
);

/** Delivery projection only: never changes assessment truth, products or diagnostics. */
export function scaTerminalUnresolved(input: {
  store: ArtifactHostStore;
  manifest: ArtifactRef;
  report?: ArtifactRef;
}): string[] {
  const manifest = exactJson(input.store, input.manifest, ScaOutputManifestSchema);
  const delivery = TerminalDirectiveSchema.properties.unresolved;
  // Check the actual shared count AND per-string contract, not a duplicated allowance.
  if (Value.Errors(delivery, manifest.unresolved).length === 0) return manifest.unresolved;

  let ref = input.manifest;
  let pointer = "/unresolved";
  if (input.report !== undefined) {
    const report = exactJson(input.store, input.report, ScaReportProductSchema);
    // Exact ordered equality also preserves repeated entries. A sanitized or otherwise
    // different report cannot stand in for the supplied terminal diagnostics.
    if (
      manifest.outputs.some((output) => canonicalJson(output) === canonicalJson(input.report)) &&
      canonicalJson(report.gaps) === canonicalJson(manifest.unresolved)
    ) {
      ref = input.report;
      pointer = "/gaps";
    }
  }
  return validateContract(
    delivery,
    [
      `${manifest.unresolved.length} unresolved SCA diagnostics retained exactly at ${ref.artifact_id} (SHA-256 ${ref.content_digest}), JSON ${pointer}. Read with artifact_read through next_range until complete.`,
    ],
    "SCA exact terminal diagnostic pointer"
  );
}
