import type { ArtifactHostStore } from "../artifact-store.js";
import { readScaP01VariantCaptureV1 } from "./p01-source-variants.js";
import { canonicalJson, sha256 } from "../canonical-json.js";
import type { ArtifactRef } from "../contracts.js";
import {
  admitScaP01Candidate,
  type ScaP01AdmissionOptions,
  type ScaP01AdmissionResultV1,
  type ScaP01DispatchProbe,
  type ScaP01DispatchSnapshot,
} from "./p01-admission.js";
import {
  validateScaCampaignManifestCoreV1,
  validateScaCampaignManifestV2,
  validateScaObligationLedgerV2,
  validateScaP01AdmissionContextV1,
  validateScaP01AdmissionEvidenceV1,
  validateScaP01AdmissionRequestV3,
  validateScaPhaseGateRecordV2,
  validateScaPhaseQualificationRecordV2,
  type ScaP01AdmissionRequestV3,
} from "./p01-contracts.js";

const PHASE = "sca-p01-candidate-admission";
const PRODUCER = "host:sca-p01-candidate";
const OUTPUTS = [
  ["request_ref", "sca-p01-candidate-request", 3, validateScaP01AdmissionRequestV3],
  [
    "obligation_ledger_ref",
    "sca-p01-candidate-obligation-ledger",
    2,
    validateScaObligationLedgerV2,
  ],
  ["manifest_core_ref", "sca-p01-candidate-manifest-core", 1, validateScaCampaignManifestCoreV1],
  [
    "admission_evidence_ref",
    "sca-p01-candidate-admission-evidence",
    1,
    validateScaP01AdmissionEvidenceV1,
  ],
  ["p01_gate_ref", "sca-p01-candidate-gate", 2, validateScaPhaseGateRecordV2],
  [
    "campaign_manifest_ref",
    "sca-p01-candidate-campaign-manifest",
    2,
    validateScaCampaignManifestV2,
  ],
] as const;

function exactJson(
  store: ArtifactHostStore,
  ref: ArtifactRef,
  kind: string,
  version: number,
  producer: string
): unknown {
  const stored = store.refById(ref.artifact_id);
  if (stored === undefined || canonicalJson(stored) !== canonicalJson(ref))
    throw new Error(`${kind}: substituted ref`);
  const meta = store.metadata(ref);
  if (
    meta.run_id !== ref.run_id ||
    meta.phase !== ref.phase ||
    meta.branch_id !== null ||
    meta.kind !== kind ||
    meta.operation_id !== kind ||
    meta.version !== 1 ||
    meta.producer !== producer ||
    meta.media_type !== "application/json" ||
    meta.content_schema?.schema_version !== version ||
    meta.content_schema.schema_id !== ref.content_schema?.schema_id
  )
    throw new Error(`${kind}: invalid metadata`);
  const bytes = store.readById(ref.artifact_id);
  if (
    !bytes.length ||
    bytes.length > 4 * 1_048_576 ||
    bytes.length !== ref.byte_length ||
    sha256(bytes) !== ref.content_digest
  )
    throw new Error(`${kind}: bytes changed`);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const value: unknown = JSON.parse(text);
  if (canonicalJson(value) !== text) throw new Error(`${kind}: noncanonical bytes`);
  return value;
}

function snapshot(probe: ScaP01DispatchProbe): ScaP01DispatchSnapshot {
  const value = probe.snapshot();
  if (
    ![value.model, value.scanner, value.application].every((n) => Number.isSafeInteger(n) && n >= 0)
  )
    throw new Error("dispatch observer unavailable or invalid");
  return value;
}

function unchanged(probe: ScaP01DispatchProbe, before: ScaP01DispatchSnapshot): void {
  if (canonicalJson(snapshot(probe)) !== canonicalJson(before))
    throw new Error("P01 dispatch detected");
}

/** Host-only, inactive issuer. The caller must supply a genuine host-owned probe, never a zero stub.
 * The underlying six version-1 writes are adopt-or-conflict; a partial cohort is never repaired here.
 */
export function issueScaP01CampaignGate(input: {
  readonly store: ArtifactHostStore;
  readonly request: ScaP01AdmissionRequestV3;
  readonly dispatchProbe: ScaP01DispatchProbe;
  readonly signal?: AbortSignal;
  readonly onBoundary?: ScaP01AdmissionOptions["onBoundary"];
}): ScaP01AdmissionResultV1 {
  const { store, dispatchProbe, signal } = input;
  const before = snapshot(dispatchProbe);
  const check = (): void => {
    if (signal?.aborted === true) throw new Error("P01 campaign issuance cancelled");
    unchanged(dispatchProbe, before);
  };
  check();
  const request = validateScaP01AdmissionRequestV3(input.request);
  // An existing cohort is replayable only as a complete set of exact version-1 slots.
  const existing = OUTPUTS.map(([, kind]) => {
    if (store.lastVersion(request.run_id, PHASE, null, kind, kind) > 1)
      throw new Error("P01 output has unexpected version");
    return store.refFor(request.run_id, PHASE, null, kind, kind, 1);
  });
  if (existing.some((ref) => ref !== null) && existing.some((ref) => ref === null))
    throw new Error("partial P01 cohort");
  check();
  const result = admitScaP01Candidate({
    store,
    request,
    options: {
      dispatchProbe,
      ...(signal === undefined ? {} : { signal }),
      onBoundary: (event) => {
        check();
        input.onBoundary?.(event);
        check();
      },
    },
  });
  check();
  OUTPUTS.forEach(([key, kind, version, validate], index) => {
    check();
    const ref = result[key];
    const slot = store.refFor(request.run_id, PHASE, null, kind, kind, 1);
    if (
      slot === null ||
      canonicalJson(slot) !== canonicalJson(ref) ||
      (existing[index] !== null && canonicalJson(existing[index]) !== canonicalJson(ref)) ||
      store.lastVersion(request.run_id, PHASE, null, kind, kind) !== 1 ||
      ref.phase !== PHASE ||
      ref.run_id !== request.run_id ||
      ref.producer !== PRODUCER
    )
      throw new Error(`${kind}: output substitution`);
    const value = validate(exactJson(store, ref, kind, version, PRODUCER));
    if (ref.content_schema?.schema_id !== value.schema_id)
      throw new Error(`${kind}: schema substitution`);
  });
  const issuedRequest = validateScaP01AdmissionRequestV3(
    exactJson(store, result.request_ref, OUTPUTS[0][1], 3, PRODUCER)
  );
  const ledger = validateScaObligationLedgerV2(
    exactJson(store, result.obligation_ledger_ref, OUTPUTS[1][1], 2, PRODUCER)
  );
  const core = validateScaCampaignManifestCoreV1(
    exactJson(store, result.manifest_core_ref, OUTPUTS[2][1], 1, PRODUCER)
  );
  const evidence = validateScaP01AdmissionEvidenceV1(
    exactJson(store, result.admission_evidence_ref, OUTPUTS[3][1], 1, PRODUCER)
  );
  const gate = validateScaPhaseGateRecordV2(
    exactJson(store, result.p01_gate_ref, OUTPUTS[4][1], 2, PRODUCER)
  );
  const manifest = validateScaCampaignManifestV2(
    exactJson(store, result.campaign_manifest_ref, OUTPUTS[5][1], 2, PRODUCER)
  );
  if (
    canonicalJson(issuedRequest) !== canonicalJson(request) ||
    gate.status !== "passed" ||
    manifest.campaign_status !== "admitted" ||
    evidence.status !== "passed" ||
    Object.values(evidence.dispatch_delta).some((n) => n !== 0)
  )
    throw new Error("P01 campaign gate not admitted");
  const qualificationRef = request.p01_qualification_ref;
  const qualificationStored = store.refById(qualificationRef.artifact_id);
  const qualificationBytes = store.readById(qualificationRef.artifact_id);
  if (
    qualificationStored === undefined ||
    canonicalJson(qualificationStored) !== canonicalJson(qualificationRef) ||
    qualificationBytes.length !== qualificationRef.byte_length ||
    sha256(qualificationBytes) !== qualificationRef.content_digest
  )
    throw new Error("qualification bytes changed");
  const qualificationText = new TextDecoder("utf-8", { fatal: true }).decode(qualificationBytes);
  const qualificationValue: unknown = JSON.parse(qualificationText);
  if (canonicalJson(qualificationValue) !== qualificationText)
    throw new Error("qualification bytes are not canonical");
  const qualification = validateScaPhaseQualificationRecordV2(qualificationValue);
  validateScaP01AdmissionContextV1({
    request,
    request_ref: result.request_ref,
    ledger,
    ledger_ref: result.obligation_ledger_ref,
    core,
    core_ref: result.manifest_core_ref,
    frozen_material_refs: core.frozen_refs,
    qualification,
    qualification_ref: request.p01_qualification_ref,
    admission_evidence: evidence,
    admission_evidence_ref: result.admission_evidence_ref,
    gate,
    gate_ref: result.p01_gate_ref,
    manifest,
  });
  // Re-read all admitted transitive evidence, not only the six outputs: an input
  // changed during post-admission validation must not be returned as a passed gate.
  for (const ref of evidence.evidence_refs) {
    check();
    const current = store.refById(ref.artifact_id);
    const bytes = store.readById(ref.artifact_id);
    if (
      current === undefined ||
      canonicalJson(current) !== canonicalJson(ref) ||
      bytes.length !== ref.byte_length ||
      sha256(bytes) !== ref.content_digest
    )
      throw new Error("P01 input changed after admission");
    store.metadata(ref);
  }
  if (request.source.variant_capture_manifest_ref !== undefined) {
    readScaP01VariantCaptureV1({
      store,
      manifest_ref: request.source.variant_capture_manifest_ref,
      context: request,
      evidence_refs: evidence.evidence_refs,
      exact_read: (ref) => {
        check();
        return store.readById(ref.artifact_id);
      },
    });
  }
  for (const [key, kind, version] of OUTPUTS) {
    check();
    exactJson(store, result[key], kind, version, PRODUCER);
  }
  check();
  return result;
}
