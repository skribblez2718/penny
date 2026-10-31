import type { ArtifactStore } from "../../orchestration/dist/artifact-store.js";
import { canonicalJson, sha256 } from "../../orchestration/dist/canonical-json.js";
import type { ArtifactRef } from "../../orchestration/dist/contracts.js";
import {
  validateScaP03AttemptWitnessV1,
  validateScaP03CleanupEvidenceV2,
  validateScaP03IsolationEvidenceV2,
  validateScaP03BootstrapQualificationRecordV3,
} from "../../orchestration/dist/sca/p03-bootstrap-contracts.js";
import { P03_BOOTSTRAP_ROLES, readP03BootstrapBytes } from "./p03-bootstrap.js";

/** Exact canonical immutable write, with a post-insert ref and metadata readback. No selection or activation. */
export function persistScaP03HostEvidenceV3(input: {
  store: ArtifactStore;
  run_id: string;
  operation_id: string;
  kind:
    | "sca-p03-attempt-witness"
    | "sca-p03-cleanup-evidence"
    | "sca-p03-isolation-evidence"
    | "sca-p03-bootstrap-record";
  bytes: Uint8Array;
  upstream_refs: readonly ArtifactRef[];
}): ArtifactRef {
  const { store, bytes } = input;
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength > 1024 * 1024 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.operation_id)
  )
    throw new Error("p03_writer_input_invalid");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const raw: unknown = JSON.parse(text);
  if (canonicalJson(raw) !== text) throw new Error("p03_writer_noncanonical");
  const validated =
    input.kind === "sca-p03-attempt-witness"
      ? validateScaP03AttemptWitnessV1(bytes)
      : input.kind === "sca-p03-cleanup-evidence"
        ? validateScaP03CleanupEvidenceV2(bytes)
        : input.kind === "sca-p03-isolation-evidence"
          ? validateScaP03IsolationEvidenceV2(bytes)
          : validateScaP03BootstrapQualificationRecordV3(raw);
  const producer =
    input.kind === "sca-p03-cleanup-evidence"
      ? P03_BOOTSTRAP_ROLES.cleanup
      : input.kind === "sca-p03-isolation-evidence"
        ? P03_BOOTSTRAP_ROLES.isolation
        : P03_BOOTSTRAP_ROLES.evaluator;
  const upstream = [...input.upstream_refs];
  if (
    upstream.some((ref) => ref.run_id !== input.run_id) ||
    new Set(upstream.map((ref) => ref.artifact_id)).size !== upstream.length
  )
    throw new Error("p03_writer_upstream_invalid");
  // Existing logical slot cannot be overwritten even by a second identical body.
  if (store.lastVersion(input.run_id, "SCA-P03", null, input.kind, input.operation_id) !== 0)
    throw new Error("p03_writer_existing_slot");
  const ref = store.persist({
    metadata: {
      schema_version: 2,
      run_id: input.run_id,
      phase: "SCA-P03",
      branch_id: null,
      kind: input.kind,
      operation_id: input.operation_id,
      version: 1,
      producer,
      media_type: "application/json",
      content_schema: { schema_id: validated.schema_id, schema_version: validated.schema_version },
      parent_ref: null,
      upstream_refs: upstream,
    },
    content: bytes,
  });
  const stored = store.refById(ref.artifact_id);
  if (
    stored === undefined ||
    canonicalJson(stored) !== canonicalJson(ref) ||
    sha256(readP03BootstrapBytes(store, ref)) !== sha256(bytes)
  )
    throw new Error("p03_writer_readback_failed");
  const metadata = store.metadata(ref);
  if (
    metadata.producer !== producer ||
    metadata.content_schema?.schema_id !== validated.schema_id ||
    canonicalJson(metadata.upstream_refs) !== canonicalJson(upstream) ||
    metadata.parent_ref !== null
  )
    throw new Error("p03_writer_metadata_drift");
  return ref;
}
