import { currentArtifactRef } from "../artifact-store.js";
import { canonicalJson } from "../canonical-json.js";
import type { ArtifactRef } from "../contracts.js";
import {
  SCA_P01_REQUIRED_CRITERION_IDS,
  SCA_PHASE_GATE_RECORD_V2_SCHEMA,
  SCA_PHASE_QUALIFICATION_RECORD_V2_SCHEMA,
  scaPhaseQualificationEvidenceRefs,
  scaPhaseQualificationRefs,
  validateScaPhaseGateRecordV2,
  validateScaPhaseQualificationRecordV2,
  type ScaPhaseGateRecordV2,
} from "./p01-contracts.js";
import type { ScaImplementationAssuranceScope } from "./qualification-gate-contracts.js";

export interface LegacyScaP01QualificationViewV1 {
  readonly source_schema_id: typeof SCA_PHASE_QUALIFICATION_RECORD_V2_SCHEMA;
  readonly phase_id: "SCA-P01";
  readonly tenant_id: string;
  readonly project_id: string;
  readonly qualification_run_id: string;
  readonly implementation_revision: string;
  readonly implementation_assurance_scope: ScaImplementationAssuranceScope;
  readonly input_refs: readonly ArtifactRef[];
  readonly evidence_refs: readonly ArtifactRef[];
  readonly reviewer_authority_ref: ArtifactRef;
  readonly reviewer_receipt_ref: ArtifactRef;
  readonly criterion_results: readonly {
    readonly criterion_id: string;
    readonly status: "PASS" | "FAIL" | "BLOCKED" | "NOT RUN";
  }[];
  readonly status: "PASS" | "FAIL" | "BLOCKED" | "NOT RUN";
  readonly remaining_gaps: readonly string[];
  readonly recorded_at: string;
}

export interface LegacyScaP01GateViewV1 {
  readonly source_schema_id: typeof SCA_PHASE_GATE_RECORD_V2_SCHEMA;
  readonly phase_id: "SCA-P01";
  readonly tenant_id: string;
  readonly project_id: string;
  readonly gate_run_id: string;
  readonly qualification_run_id: string;
  readonly implementation_revision: string;
  readonly qualification_ref: ArtifactRef;
  readonly criterion_results: ScaPhaseGateRecordV2["criterion_results"];
  readonly status: "passed";
  readonly evaluated_at: string;
}

/**
 * Project a validated historical P01 V2 record into a read-only common view.
 * The legacy object is never rewritten, sealed, normalized in place, or serialized by this adapter.
 */
export function inspectLegacyScaP01QualificationV2(
  value: unknown
): LegacyScaP01QualificationViewV1 {
  const record = validateScaPhaseQualificationRecordV2(value);
  return {
    source_schema_id: SCA_PHASE_QUALIFICATION_RECORD_V2_SCHEMA,
    phase_id: record.phase_id,
    tenant_id: record.tenant_id,
    project_id: record.project_id,
    qualification_run_id: record.run_id,
    implementation_revision: record.implementation_revision,
    // The record-only adapter cannot prove the transitive host admission closure. Historical
    // P01 admission remains authoritative; this normalized view deliberately does not upgrade it.
    implementation_assurance_scope: "declaration_only",
    input_refs: scaPhaseQualificationRefs(record),
    evidence_refs: scaPhaseQualificationEvidenceRefs(record),
    reviewer_authority_ref: record.reviewer_authority_ref,
    reviewer_receipt_ref: record.reviewer_receipt_ref,
    criterion_results: record.criteria.map((criterion) => ({
      criterion_id: criterion.criterion_id,
      status: criterion.status,
    })),
    status: record.status,
    remaining_gaps: record.remaining_gaps,
    recorded_at: record.recorded_at,
  };
}

/** Validate only the V2 qualification ↔ gate record relationship. Not P01 admission authority: this does not read stored bytes or verify request, ledger, manifest core, or admission evidence. */
export function inspectLegacyScaP01GateRecordRelationshipV2(input: {
  readonly qualification: unknown;
  readonly qualification_ref: ArtifactRef;
  readonly gate: unknown;
}): LegacyScaP01GateViewV1 {
  const qualification = validateScaPhaseQualificationRecordV2(input.qualification);
  const qualificationRef = currentArtifactRef(input.qualification_ref, "P01 qualification ref");
  const gate = validateScaPhaseGateRecordV2(input.gate);
  const expectedCriteria = SCA_P01_REQUIRED_CRITERION_IDS.map((criterion_id) => ({
    criterion_id,
    status: "PASS" as const,
  }));
  if (
    qualification.status !== "PASS" ||
    qualification.remaining_gaps.length !== 0 ||
    qualification.run_id !== qualificationRef.run_id ||
    qualification.tenant_id !== gate.tenant_id ||
    qualification.project_id !== gate.project_id ||
    qualification.phase_id !== gate.phase_id ||
    qualification.implementation_revision !== gate.implementation_revision ||
    canonicalJson(gate.qualification_ref) !== canonicalJson(qualificationRef) ||
    canonicalJson(gate.criterion_results) !== canonicalJson(expectedCriteria)
  ) {
    throw new Error("historical P01 gate does not bind the exact passed V2 qualification");
  }
  return {
    source_schema_id: SCA_PHASE_GATE_RECORD_V2_SCHEMA,
    phase_id: gate.phase_id,
    tenant_id: gate.tenant_id,
    project_id: gate.project_id,
    gate_run_id: gate.run_id,
    qualification_run_id: qualification.run_id,
    implementation_revision: gate.implementation_revision,
    qualification_ref: gate.qualification_ref,
    criterion_results: gate.criterion_results,
    status: gate.status,
    evaluated_at: gate.evaluated_at,
  };
}
