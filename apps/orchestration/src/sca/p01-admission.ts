import {
  previewArtifactRef,
  type ArtifactHostStore,
  type PersistArtifactInput,
} from "../artifact-store.js";
import { readScaP01VariantCaptureV1 } from "./p01-source-variants.js";
import { canonicalJson, sha256 } from "../canonical-json.js";
import type { ArtifactRef, OutputArtifactMetadata } from "../contracts.js";
import {
  SCA_CAMPAIGN_MANIFEST_CORE_V1_SCHEMA,
  SCA_CAMPAIGN_MANIFEST_V2_SCHEMA,
  SCA_CAMPAIGN_SOURCE_SNAPSHOT_V2_SCHEMA,
  SCA_HOST_BOUNDARY_RECEIPT_V1_SCHEMA,
  SCA_IMPLEMENTATION_IDENTITY_V1_SCHEMA,
  SCA_OBLIGATION_LEDGER_V2_SCHEMA,
  SCA_P01_ADMISSION_EVIDENCE_V1_SCHEMA,
  SCA_P01_ADMISSION_REQUEST_V3_SCHEMA,
  SCA_P01_IMPLEMENTATION_BUILD_BUNDLE_V1_SCHEMA,
  SCA_P01_IMPLEMENTATION_SOURCE_BUNDLE_V1_SCHEMA,
  SCA_P01_QUALIFICATION_FIXTURE_CONTENT_V1_SCHEMA,
  SCA_P01_QUALIFICATION_LOG_CONTENT_V1_SCHEMA,
  SCA_P01_QUALIFICATION_PROFILE_V1_SCHEMA,
  SCA_P01_QUALIFICATION_VARIANT_IDS,
  SCA_P01_REQUIRED_CRITERION_IDS,
  SCA_P01_SOURCE_CUSTODY_CORPUS_V1_SCHEMA,
  SCA_P01_SOURCE_FILE_MANIFEST_V1_SCHEMA,
  SCA_P01_TRUSTED_QUALIFICATION_PRODUCERS,
  SCA_PHASE_GATE_RECORD_V2_SCHEMA,
  SCA_PHASE_QUALIFICATION_RECORD_V2_SCHEMA,
  SCA_QUALIFICATION_EVIDENCE_V1_SCHEMA,
  SCA_QUALIFICATION_FIXTURE_V1_SCHEMA,
  SCA_QUALIFICATION_LOG_V1_SCHEMA,
  SCA_REVIEWER_AUTHORITY_V1_SCHEMA,
  SCA_REVIEW_RECEIPT_V1_SCHEMA,
  SCA_SOURCE_PROVENANCE_V1_SCHEMA,
  ScaP01ContractError,
  appendScaObligationLedgerV2,
  buildScaInitialObligationLedgerV2,
  scaP01AdmissionRequestRefs,
  scaPhaseQualificationEvidenceRefs,
  scaPhaseQualificationRefs,
  validateScaCampaignManifestCoreV1,
  validateScaCampaignManifestV2,
  validateScaCampaignSourceSnapshotV2,
  validateScaHostBoundaryReceiptV1,
  validateScaImplementationIdentityV1,
  validateScaObligationLedgerV2,
  validateScaObligationRevisionOperationV1,
  validateScaP01AdmissionContextV1,
  validateScaP01AdmissionEvidenceV1,
  validateScaP01AdmissionRequestV3,
  validateScaP01QualificationProfileV1,
  validateScaP01SourceCustodyCorpusV1,
  validateScaP01SourceFileManifestV1,
  validateScaP01SourceMaterialV1,
  validateScaPhaseGateRecordV2,
  validateScaPhaseQualificationRecordV2,
  validateScaQualificationEvidenceV1,
  validateScaQualificationFixtureV1,
  validateScaQualificationLogV1,
  validateScaReviewerAuthorityV1,
  validateScaReviewReceiptV1,
  validateScaSourceProvenanceV1,
  type ScaCampaignManifestCoreV1,
  type ScaCampaignManifestV2,
  type ScaObligationLedgerV2,
  type ScaCampaignSourceSnapshotV2,
  type ScaImplementationIdentityV1,
  type ScaP01AdmissionRequestV3,
  type ScaPhaseQualificationRecordV2,
  type ScaQualificationEvidenceV1,
} from "./p01-contracts.js";
import {
  SCA_ANALYSIS_PROFILE_V1_SCHEMA,
  SCA_AUTHORITY_POLICY_V1_SCHEMA,
  SCA_MODEL_DATA_POLICY_V1_SCHEMA,
  SCA_NETWORK_POLICY_V1_SCHEMA,
  SCA_OUTPUT_POLICY_V1_SCHEMA,
  SCA_P01_RULE_BUNDLE_V1_SCHEMA,
  SCA_P01_SELECTED_RULE_MANIFEST_V1_SCHEMA,
  SCA_P01_TOOL_EXECUTABLE_PACKAGE_V1_SCHEMA,
  SCA_P01_TOOL_MEASUREMENT_RECEIPT_V1_SCHEMA,
  SCA_P01_TRUSTED_PRODUCERS,
  SCA_PRIVACY_POLICY_V1_SCHEMA,
  SCA_RESOURCE_POLICY_V1_SCHEMA,
  SCA_RULE_PROFILE_V1_SCHEMA,
  SCA_RULE_RELEASE_V1_SCHEMA,
  SCA_TOOLCHAIN_IDENTITY_V1_SCHEMA,
  ScaP01PolicyContractError,
  validateScaAnalysisProfileV1,
  validateScaAuthorityPolicyV1,
  validateScaModelDataPolicyV1,
  validateScaNetworkPolicyV1,
  validateScaOutputPolicyV1,
  validateScaP01PolicyBundle,
  validateScaP01RuleBundleV1,
  validateScaP01SelectedRuleManifestV1,
  validateScaP01ToolMeasurementReceiptV1,
  validateScaPrivacyPolicyV1,
  validateScaResourcePolicyV1,
  validateScaRuleProfileV1,
  validateScaRuleReleaseV1,
  validateScaToolchainIdentityV1,
  type ScaAuthorityPolicyV1,
  type ScaP01PolicyMaterial,
} from "./p01-policy-contracts.js";

const MAX_CANONICAL_ARTIFACT_BYTES = 4 * 1_048_576;
const MAX_MATERIAL_ARTIFACT_BYTES = 64 * 1_048_576;
const CANDIDATE_PHASE = "sca-p01-candidate-admission";
const CANDIDATE_PRODUCER = "host:sca-p01-candidate";
const CANDIDATE_LEDGER_KIND = "sca-p01-candidate-obligation-ledger";
const CANDIDATE_LEDGER_OPERATION = "sca-p01-candidate-obligation-ledger";

interface PlannedArtifact {
  readonly input: PersistArtifactInput;
  readonly ref: ArtifactRef;
}

interface ArtifactContract {
  readonly kind: string;
  readonly schema_id: string;
  readonly schema_version: number;
  readonly producer: string;
  readonly media_type?: string;
}

export interface ScaP01DispatchSnapshot {
  readonly model: number;
  readonly scanner: number;
  readonly application: number;
}

export interface ScaP01DispatchProbe {
  snapshot(): ScaP01DispatchSnapshot;
}

export type ScaP01AdmissionBoundary =
  | { readonly stage: "before_work" }
  | { readonly stage: "before_artifact_read"; readonly label: string; readonly artifact_id: string }
  | {
      readonly stage: "before_persist";
      readonly operation_id: string;
      readonly ordinal: number;
      readonly final_marker: boolean;
    };

export interface ScaP01AdmissionOptions {
  readonly signal?: AbortSignal;
  readonly onBoundary?: (boundary: ScaP01AdmissionBoundary) => void;
  readonly dispatchProbe?: ScaP01DispatchProbe;
}

export interface ScaP01AdmissionResultV1 {
  readonly request_ref: ArtifactRef;
  readonly obligation_ledger_ref: ArtifactRef;
  readonly manifest_core_ref: ArtifactRef;
  readonly admission_evidence_ref: ArtifactRef;
  readonly p01_gate_ref: ArtifactRef;
  readonly campaign_manifest_ref: ArtifactRef;
}

export class ScaP01AdmissionError extends Error {
  constructor(
    readonly code:
      | "invalid_request"
      | "missing_ref"
      | "current_ref_mismatch"
      | "digest_mismatch"
      | "artifact_contract_mismatch"
      | "semantic_policy_denied"
      | "unqualified_p01"
      | "invalid_reviewer"
      | "dispatch_observer_unavailable"
      | "dispatch_detected"
      | "cancelled"
      | "artifact_conflict"
      | "persistence_failed",
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "ScaP01AdmissionError";
  }
}

function fail(code: ScaP01AdmissionError["code"], message: string, options?: ErrorOptions): never {
  throw new ScaP01AdmissionError(code, message, options);
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function sameRef(left: ArtifactRef, right: ArtifactRef): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function sortedRefs(refs: readonly ArtifactRef[]): ArtifactRef[] {
  const byId = new Map<string, ArtifactRef>();
  for (const ref of refs) {
    const existing = byId.get(ref.artifact_id);
    if (existing !== undefined && !sameRef(existing, ref)) {
      fail(
        "current_ref_mismatch",
        `artifact '${ref.artifact_id}' has contradictory representations`
      );
    }
    byId.set(ref.artifact_id, ref);
  }
  return [...byId.values()].sort((left, right) => compareUtf8(left.artifact_id, right.artifact_id));
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) fail("cancelled", "SCA P01 candidate admission was cancelled");
}

function boundary(options: ScaP01AdmissionOptions, event: ScaP01AdmissionBoundary): void {
  throwIfCancelled(options.signal);
  options.onBoundary?.(event);
  throwIfCancelled(options.signal);
}

function assertCounterValue(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail("invalid_request", `${label} dispatch counter must be a non-negative safe integer`);
  }
}

function dispatchSnapshot(probe: ScaP01DispatchProbe | undefined): ScaP01DispatchSnapshot {
  if (probe === undefined) {
    fail("dispatch_observer_unavailable", "P01 admission requires a host-owned dispatch observer");
  }
  let snapshot: ScaP01DispatchSnapshot;
  try {
    snapshot = probe.snapshot();
  } catch (error) {
    fail("dispatch_observer_unavailable", "P01 admission dispatch observer is unavailable", {
      cause: error,
    });
  }
  assertCounterValue(snapshot.model, "model");
  assertCounterValue(snapshot.scanner, "scanner");
  assertCounterValue(snapshot.application, "application");
  return snapshot;
}

function assertNoDispatchDelta(
  baseline: ScaP01DispatchSnapshot,
  probe: ScaP01DispatchProbe | undefined
): void {
  const current = dispatchSnapshot(probe);
  if (
    current.model !== baseline.model ||
    current.scanner !== baseline.scanner ||
    current.application !== baseline.application
  ) {
    fail("dispatch_detected", "P01 admission observed a model, scanner, or application dispatch");
  }
}

function mapContractError(error: unknown): never {
  if (error instanceof ScaP01PolicyContractError) {
    switch (error.code) {
      case "denied_policy":
      case "authority_denied":
      case "unsafe_network_policy":
      case "unsafe_toolchain":
      case "unsafe_output_policy":
        return fail("semantic_policy_denied", error.message, { cause: error });
      case "invalid_policy_contract":
      case "profile_mismatch":
      case "rule_binding_mismatch":
      case "model_policy_mismatch":
      case "authority_mismatch":
        return fail("artifact_contract_mismatch", error.message, { cause: error });
    }
  }
  if (error instanceof ScaP01ContractError) {
    switch (error.code) {
      case "invalid_qualification":
        return fail("unqualified_p01", error.message, { cause: error });
      case "invalid_reviewer":
        return fail("invalid_reviewer", error.message, { cause: error });
      case "invalid_scope":
      case "invalid_identity":
      case "wrong_model_identity":
      case "ambiguous_authority":
      case "invalid_contract":
        return fail("invalid_request", error.message, { cause: error });
      case "invalid_obligation_ledger":
      case "obligation_policy_denied":
      case "obligation_conflict":
      case "invalid_manifest_binding":
        return fail("artifact_contract_mismatch", error.message, { cause: error });
    }
  }
  throw error;
}

function mapReadContractError(error: unknown): never {
  if (error instanceof ScaP01ContractError) {
    if (error.code === "invalid_qualification") {
      return fail("unqualified_p01", error.message, { cause: error });
    }
    if (error.code === "invalid_reviewer") {
      return fail("invalid_reviewer", error.message, { cause: error });
    }
    return fail("artifact_contract_mismatch", error.message, { cause: error });
  }
  mapContractError(error);
}

function parseCanonicalJson(bytes: Uint8Array, label: string): unknown {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_CANONICAL_ARTIFACT_BYTES) {
    fail(
      "artifact_contract_mismatch",
      `${label} bytes are empty or exceed the bounded parser limit`
    );
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    fail("artifact_contract_mismatch", `${label} bytes are not valid UTF-8`, { cause: error });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    fail("artifact_contract_mismatch", `${label} bytes are not valid JSON`, { cause: error });
  }
  if (canonicalJson(parsed) !== text) {
    fail("artifact_contract_mismatch", `${label} bytes are not canonical JSON`);
  }
  return parsed;
}

function assertRefContract(ref: ArtifactRef, contract: ArtifactContract, label: string): void {
  if (
    ref.kind !== contract.kind ||
    ref.content_schema?.schema_id !== contract.schema_id ||
    ref.content_schema.schema_version !== contract.schema_version ||
    ref.producer !== contract.producer ||
    ref.media_type !== (contract.media_type ?? "application/json")
  ) {
    fail(
      "artifact_contract_mismatch",
      `${label} does not have the exact trusted kind, schema version, producer, and media type`
    );
  }
}

function readExactArtifactBytes(input: {
  readonly store: ArtifactHostStore;
  readonly ref: ArtifactRef;
  readonly contract?: ArtifactContract;
  readonly label: string;
  readonly options: ScaP01AdmissionOptions;
}): Buffer {
  if (input.contract !== undefined) {
    assertRefContract(input.ref, input.contract, input.label);
  }
  boundary(input.options, {
    stage: "before_artifact_read",
    label: input.label,
    artifact_id: input.ref.artifact_id,
  });
  let stored: ArtifactRef | undefined;
  let metadataValue: OutputArtifactMetadata;
  let bytes: Buffer;
  try {
    stored = input.store.refById(input.ref.artifact_id);
    if (stored === undefined) {
      fail("missing_ref", `${input.label} is absent from the artifact store`);
    }
    throwIfCancelled(input.options.signal);
    metadataValue = input.store.metadata(input.ref);
    throwIfCancelled(input.options.signal);
    bytes = input.store.readById(input.ref.artifact_id);
  } catch (error) {
    if (error instanceof ScaP01AdmissionError) throw error;
    fail("digest_mismatch", `${input.label} failed exact metadata/byte verification`, {
      cause: error,
    });
  }
  if (
    stored.content_digest !== input.ref.content_digest ||
    stored.byte_length !== input.ref.byte_length ||
    stored.store_ref !== input.ref.store_ref ||
    !sameRef(stored, input.ref)
  ) {
    fail("current_ref_mismatch", `${input.label} does not match the exact stored ref`);
  }
  let previewed: ArtifactRef;
  try {
    previewed = previewArtifactRef({ metadata: metadataValue, content: bytes });
  } catch (error) {
    fail("digest_mismatch", `${input.label} metadata is not canonical`, { cause: error });
  }
  if (
    bytes.byteLength !== input.ref.byte_length ||
    sha256(bytes) !== input.ref.content_digest ||
    !sameRef(previewed, input.ref)
  ) {
    fail("digest_mismatch", `${input.label} metadata, digest, length, or bytes drifted`);
  }
  throwIfCancelled(input.options.signal);
  return bytes;
}

function readArtifact<Value>(input: {
  readonly store: ArtifactHostStore;
  readonly ref: ArtifactRef;
  readonly contract: ArtifactContract;
  readonly label: string;
  readonly options: ScaP01AdmissionOptions;
  readonly validate: (value: unknown) => Value;
}): Value {
  const bytes = readExactArtifactBytes(input);
  try {
    return input.validate(parseCanonicalJson(bytes, input.label));
  } catch (error) {
    mapReadContractError(error);
  }
}

function readMaterialArtifact(input: {
  readonly store: ArtifactHostStore;
  readonly ref: ArtifactRef;
  readonly contract: ArtifactContract;
  readonly label: string;
  readonly options: ScaP01AdmissionOptions;
}): Buffer {
  const bytes = readExactArtifactBytes(input);
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_MATERIAL_ARTIFACT_BYTES) {
    fail(
      "artifact_contract_mismatch",
      `${input.label} bytes are empty or exceed the bounded material limit`
    );
  }
  return bytes;
}

function rereadExactRefs(input: {
  readonly store: ArtifactHostStore;
  readonly refs: readonly ArtifactRef[];
  readonly options: ScaP01AdmissionOptions;
}): void {
  for (const ref of sortedRefs(input.refs)) {
    readExactArtifactBytes({
      store: input.store,
      ref,
      label: `prewrite transitive artifact ${ref.artifact_id}`,
      options: input.options,
    });
  }
}

function metadata(input: {
  readonly run_id: string;
  readonly kind: string;
  readonly operation_id: string;
  readonly schema_id: string;
  readonly schema_version: number;
  readonly upstream_refs: readonly ArtifactRef[];
  readonly version?: number;
  readonly parent_ref?: ArtifactRef | null;
}): OutputArtifactMetadata {
  return {
    schema_version: 2,
    run_id: input.run_id,
    phase: CANDIDATE_PHASE,
    branch_id: null,
    kind: input.kind,
    operation_id: input.operation_id,
    version: input.version ?? 1,
    producer: CANDIDATE_PRODUCER,
    media_type: "application/json",
    content_schema: { schema_id: input.schema_id, schema_version: input.schema_version },
    parent_ref: input.parent_ref ?? null,
    upstream_refs: sortedRefs(input.upstream_refs),
  };
}

function planJsonArtifact(metadataValue: OutputArtifactMetadata, value: unknown): PlannedArtifact {
  const input: PersistArtifactInput = { metadata: metadataValue, content: canonicalJson(value) };
  return { input, ref: previewArtifactRef(input) };
}

function assertNoPlannedConflict(
  store: ArtifactHostStore,
  plan: PlannedArtifact,
  options: ScaP01AdmissionOptions
): void {
  throwIfCancelled(options.signal);
  const metadataValue = plan.input.metadata;
  const existing = store.refFor(
    metadataValue.run_id,
    metadataValue.phase,
    metadataValue.branch_id,
    metadataValue.kind,
    metadataValue.operation_id,
    metadataValue.version
  );
  if (existing === null) return;
  if (!sameRef(existing, plan.ref)) {
    fail("artifact_conflict", `candidate artifact '${metadataValue.operation_id}' ref diverged`);
  }
  throwIfCancelled(options.signal);
  let bytes: string;
  let observedMetadata: OutputArtifactMetadata;
  try {
    bytes = store.readById(existing.artifact_id).toString("utf8");
    throwIfCancelled(options.signal);
    observedMetadata = store.metadata(existing);
  } catch (error) {
    if (error instanceof ScaP01AdmissionError) throw error;
    fail("artifact_conflict", `candidate artifact '${metadataValue.operation_id}' is unreadable`, {
      cause: error,
    });
  }
  const plannedContent =
    typeof plan.input.content === "string"
      ? plan.input.content
      : Buffer.from(plan.input.content).toString("utf8");
  if (
    bytes !== plannedContent ||
    canonicalJson(observedMetadata) !== canonicalJson(metadataValue)
  ) {
    fail("artifact_conflict", `candidate artifact '${metadataValue.operation_id}' bytes diverged`);
  }
}

function persistPlan(input: {
  readonly store: ArtifactHostStore;
  readonly plan: PlannedArtifact;
  readonly options: ScaP01AdmissionOptions;
  readonly dispatchBaseline?: ScaP01DispatchSnapshot;
  readonly ordinal: number;
  readonly finalMarker: boolean;
  readonly prewrite_refs?: readonly ArtifactRef[];
  readonly prewrite_validate?: () => void;
}): ArtifactRef {
  boundary(input.options, {
    stage: "before_persist",
    operation_id: input.plan.input.metadata.operation_id,
    ordinal: input.ordinal,
    final_marker: input.finalMarker,
  });
  if (input.prewrite_refs !== undefined) {
    rereadExactRefs({
      store: input.store,
      refs: input.prewrite_refs,
      options: input.options,
    });
  }
  input.prewrite_validate?.();
  if (input.dispatchBaseline !== undefined) {
    assertNoDispatchDelta(input.dispatchBaseline, input.options.dispatchProbe);
  }
  let persisted: ArtifactRef;
  try {
    persisted = input.store.persist(input.plan.input);
  } catch (error) {
    fail(
      "persistence_failed",
      `candidate artifact '${input.plan.input.metadata.operation_id}' could not be persisted`,
      { cause: error }
    );
  }
  if (!sameRef(persisted, input.plan.ref)) {
    fail(
      "artifact_conflict",
      `candidate artifact '${input.plan.input.metadata.operation_id}' ref changed`
    );
  }
  return persisted;
}

function policyRefs(request: ScaP01AdmissionRequestV3): ArtifactRef[] {
  return sortedRefs([
    request.network_policy_ref,
    request.privacy_policy_ref,
    request.model_data_policy_ref,
    request.resource_policy_ref,
    request.output_policy_ref,
    request.authority_policy_ref,
  ]);
}

function readSourceMaterial(input: {
  readonly store: ArtifactHostStore;
  readonly snapshot: ScaCampaignSourceSnapshotV2;
  readonly snapshot_ref: ArtifactRef;
  readonly options: ScaP01AdmissionOptions;
  readonly label: string;
}): readonly ArtifactRef[] {
  const fileManifest = readArtifact({
    store: input.store,
    ref: input.snapshot.file_manifest_ref,
    contract: {
      kind: "sca-p01-source-file-manifest",
      schema_id: SCA_P01_SOURCE_FILE_MANIFEST_V1_SCHEMA,
      schema_version: 1,
      producer: SCA_P01_TRUSTED_QUALIFICATION_PRODUCERS.source,
    },
    label: `${input.label} file manifest`,
    options: input.options,
    validate: validateScaP01SourceFileManifestV1,
  });
  const custody = readArtifact({
    store: input.store,
    ref: input.snapshot.custody_ref,
    contract: {
      kind: "sca-p01-source-custody-corpus",
      schema_id: SCA_P01_SOURCE_CUSTODY_CORPUS_V1_SCHEMA,
      schema_version: 1,
      producer: SCA_P01_TRUSTED_QUALIFICATION_PRODUCERS.source,
    },
    label: `${input.label} sealed custody corpus`,
    options: input.options,
    validate: validateScaP01SourceCustodyCorpusV1,
  });
  try {
    validateScaP01SourceMaterialV1({
      snapshot: input.snapshot,
      file_manifest_ref: input.snapshot.file_manifest_ref,
      file_manifest: fileManifest,
      custody_ref: input.snapshot.custody_ref,
      custody,
    });
  } catch (error) {
    mapReadContractError(error);
  }
  for (const ref of [input.snapshot.file_manifest_ref, input.snapshot.custody_ref]) {
    if (ref.run_id !== input.snapshot_ref.run_id) {
      fail("artifact_contract_mismatch", `${input.label} material belongs to another run`);
    }
  }
  return [input.snapshot.file_manifest_ref, input.snapshot.custody_ref];
}

function readQualification(input: {
  readonly store: ArtifactHostStore;
  readonly request: ScaP01AdmissionRequestV3;
  readonly options: ScaP01AdmissionOptions;
}): {
  readonly record: ScaPhaseQualificationRecordV2;
  readonly all_refs: readonly ArtifactRef[];
  readonly evidence_refs: readonly ArtifactRef[];
  readonly source_file_manifest_ref: ArtifactRef;
  readonly source_custody_ref: ArtifactRef;
  readonly implementation: ScaImplementationIdentityV1;
} {
  const record = readArtifact({
    store: input.store,
    ref: input.request.p01_qualification_ref,
    contract: {
      kind: "sca-phase-qualification",
      schema_id: SCA_PHASE_QUALIFICATION_RECORD_V2_SCHEMA,
      schema_version: 2,
      producer: SCA_P01_TRUSTED_QUALIFICATION_PRODUCERS.qualification,
    },
    label: "P01 implementation qualification",
    options: input.options,
    validate: validateScaPhaseQualificationRecordV2,
  });
  if (
    record.status !== "PASS" ||
    record.remaining_gaps.length !== 0 ||
    record.tenant_id !== input.request.tenant_id ||
    record.project_id !== input.request.project_id ||
    record.run_id !== input.request.p01_qualification_ref.run_id ||
    record.run_id === input.request.run_id ||
    record.implementation_revision !== input.request.implementation_revision ||
    Date.parse(record.recorded_at) > Date.parse(input.request.requested_at)
  ) {
    fail("unqualified_p01", "P01 requires one current, gap-free, passed host-issued qualification");
  }

  const profile = readArtifact({
    store: input.store,
    ref: record.qualification_profile_ref,
    contract: {
      kind: "sca-p01-qualification-profile",
      schema_id: SCA_P01_QUALIFICATION_PROFILE_V1_SCHEMA,
      schema_version: 1,
      producer: SCA_P01_TRUSTED_QUALIFICATION_PRODUCERS.qualification_profile,
    },
    label: "P01 qualification profile",
    options: input.options,
    validate: validateScaP01QualificationProfileV1,
  });
  if (
    profile.implementation_revision !== input.request.implementation_revision ||
    canonicalJson(profile.criterion_ids) !== canonicalJson(SCA_P01_REQUIRED_CRITERION_IDS) ||
    canonicalJson(profile.variant_ids) !== canonicalJson(SCA_P01_QUALIFICATION_VARIANT_IDS)
  ) {
    fail(
      "unqualified_p01",
      "qualification profile is stale or has an incomplete criterion/variant set"
    );
  }

  const qualificationSource = readArtifact({
    store: input.store,
    ref: record.source_snapshot_ref,
    contract: {
      kind: "source-snapshot",
      schema_id: SCA_CAMPAIGN_SOURCE_SNAPSHOT_V2_SCHEMA,
      schema_version: 2,
      producer: SCA_P01_TRUSTED_QUALIFICATION_PRODUCERS.source,
    },
    label: "qualification source snapshot",
    options: input.options,
    validate: validateScaCampaignSourceSnapshotV2,
  });
  const qualificationSourceMaterialRefs = readSourceMaterial({
    store: input.store,
    snapshot: qualificationSource,
    snapshot_ref: record.source_snapshot_ref,
    options: input.options,
    label: "qualification source",
  });
  const implementation = readArtifact({
    store: input.store,
    ref: record.implementation_ref,
    contract: {
      kind: "sca-implementation-identity",
      schema_id: SCA_IMPLEMENTATION_IDENTITY_V1_SCHEMA,
      schema_version: 1,
      producer: SCA_P01_TRUSTED_QUALIFICATION_PRODUCERS.implementation,
    },
    label: "qualified implementation identity",
    options: input.options,
    validate: validateScaImplementationIdentityV1,
  });
  if (
    implementation.implementation_revision !== input.request.implementation_revision ||
    implementation.source_ref.run_id !== record.run_id ||
    implementation.build_ref.run_id !== record.run_id
  ) {
    fail("unqualified_p01", "qualified implementation identity is stale or belongs to another run");
  }
  readMaterialArtifact({
    store: input.store,
    ref: implementation.source_ref,
    contract: {
      kind: "sca-p01-implementation-source-bundle",
      schema_id: SCA_P01_IMPLEMENTATION_SOURCE_BUNDLE_V1_SCHEMA,
      schema_version: 1,
      producer: SCA_P01_TRUSTED_QUALIFICATION_PRODUCERS.implementation_source,
      media_type: "application/octet-stream",
    },
    label: "qualified implementation source bundle",
    options: input.options,
  });
  readMaterialArtifact({
    store: input.store,
    ref: implementation.build_ref,
    contract: {
      kind: "sca-p01-implementation-build-bundle",
      schema_id: SCA_P01_IMPLEMENTATION_BUILD_BUNDLE_V1_SCHEMA,
      schema_version: 1,
      producer: SCA_P01_TRUSTED_QUALIFICATION_PRODUCERS.implementation_build,
      media_type: "application/octet-stream",
    },
    label: "qualified implementation build bundle",
    options: input.options,
  });

  const evidenceRefs = scaPhaseQualificationEvidenceRefs(record);
  const evidenceRecords: ScaQualificationEvidenceV1[] = [];
  const executionLineages = new Set<string>();
  for (const criterion of record.criteria) {
    for (const variant of criterion.variants) {
      const fixture = readArtifact({
        store: input.store,
        ref: variant.fixture_ref,
        contract: {
          kind: "sca-qualification-fixture",
          schema_id: SCA_QUALIFICATION_FIXTURE_V1_SCHEMA,
          schema_version: 1,
          producer: SCA_P01_TRUSTED_QUALIFICATION_PRODUCERS.fixture,
        },
        label: `${criterion.criterion_id}.${variant.variant_id} fixture`,
        options: input.options,
        validate: validateScaQualificationFixtureV1,
      });
      readMaterialArtifact({
        store: input.store,
        ref: fixture.fixture_content_ref,
        contract: {
          kind: "sca-p01-qualification-fixture-content",
          schema_id: SCA_P01_QUALIFICATION_FIXTURE_CONTENT_V1_SCHEMA,
          schema_version: 1,
          producer: SCA_P01_TRUSTED_QUALIFICATION_PRODUCERS.fixture_content,
          media_type: "application/octet-stream",
        },
        label: `${criterion.criterion_id}.${variant.variant_id} raw fixture content`,
        options: input.options,
      });
      const evidence = readArtifact({
        store: input.store,
        ref: variant.evidence_ref,
        contract: {
          kind: "sca-qualification-evidence",
          schema_id: SCA_QUALIFICATION_EVIDENCE_V1_SCHEMA,
          schema_version: 1,
          producer: SCA_P01_TRUSTED_QUALIFICATION_PRODUCERS.evidence,
        },
        label: `${criterion.criterion_id}.${variant.variant_id} evidence`,
        options: input.options,
        validate: validateScaQualificationEvidenceV1,
      });
      const log = readArtifact({
        store: input.store,
        ref: evidence.log_ref,
        contract: {
          kind: "sca-qualification-log",
          schema_id: SCA_QUALIFICATION_LOG_V1_SCHEMA,
          schema_version: 1,
          producer: SCA_P01_TRUSTED_QUALIFICATION_PRODUCERS.log,
        },
        label: `${criterion.criterion_id}.${variant.variant_id} log`,
        options: input.options,
        validate: validateScaQualificationLogV1,
      });
      readMaterialArtifact({
        store: input.store,
        ref: log.log_content_ref,
        contract: {
          kind: "sca-p01-qualification-log-content",
          schema_id: SCA_P01_QUALIFICATION_LOG_CONTENT_V1_SCHEMA,
          schema_version: 1,
          producer: SCA_P01_TRUSTED_QUALIFICATION_PRODUCERS.log_content,
          media_type: "text/plain; charset=utf-8",
        },
        label: `${criterion.criterion_id}.${variant.variant_id} raw log content`,
        options: input.options,
      });
      const receipt = readArtifact({
        store: input.store,
        ref: evidence.boundary_receipt_ref,
        contract: {
          kind: "sca-host-boundary-receipt",
          schema_id: SCA_HOST_BOUNDARY_RECEIPT_V1_SCHEMA,
          schema_version: 1,
          producer: SCA_P01_TRUSTED_QUALIFICATION_PRODUCERS.boundary_receipt,
        },
        label: `${criterion.criterion_id}.${variant.variant_id} host-boundary receipt`,
        options: input.options,
        validate: validateScaHostBoundaryReceiptV1,
      });
      if (
        fixture.criterion_id !== criterion.criterion_id ||
        fixture.variant_id !== variant.variant_id ||
        evidence.criterion_id !== criterion.criterion_id ||
        evidence.variant_id !== variant.variant_id ||
        evidence.qualification_run_id !== record.run_id ||
        evidence.implementation_revision !== record.implementation_revision ||
        !sameRef(evidence.implementation_ref, record.implementation_ref) ||
        !sameRef(evidence.qualification_profile_ref, record.qualification_profile_ref) ||
        !sameRef(evidence.fixture_ref, variant.fixture_ref) ||
        !sameRef(evidence.fixture_content_ref, fixture.fixture_content_ref) ||
        evidence.applicability !== variant.applicability ||
        evidence.result !== variant.status ||
        evidence.execution_lineage_id !== record.implementer_lineage_id ||
        log.criterion_id !== criterion.criterion_id ||
        log.variant_id !== variant.variant_id ||
        log.job_id !== evidence.job_id ||
        !sameRef(evidence.log_content_ref, log.log_content_ref) ||
        receipt.job_id !== evidence.job_id ||
        receipt.implementation_revision !== record.implementation_revision ||
        receipt.execution_lineage_id !== record.implementer_lineage_id ||
        !sameRef(receipt.implementation_ref, record.implementation_ref) ||
        !sameRef(receipt.implementation_source_ref, implementation.source_ref) ||
        !sameRef(receipt.implementation_build_ref, implementation.build_ref) ||
        receipt.configuration_sha256 !== evidence.configuration_sha256 ||
        receipt.command_sha256 !== sha256(evidence.command_id) ||
        !sameRef(receipt.fixture_ref, variant.fixture_ref) ||
        !sameRef(receipt.fixture_content_ref, fixture.fixture_content_ref) ||
        !sameRef(receipt.log_ref, evidence.log_ref) ||
        !sameRef(receipt.log_content_ref, log.log_content_ref) ||
        receipt.expected_result_sha256 !== evidence.expected_result_sha256 ||
        receipt.observed_result_sha256 !== evidence.observed_result_sha256 ||
        receipt.terminal_status !== evidence.result ||
        (receipt.dispatch_measurement === undefined) !==
          (evidence.dispatch_measurement === undefined) ||
        (receipt.dispatch_measurement !== undefined &&
          (evidence.dispatch_measurement === undefined ||
            canonicalJson(receipt.dispatch_measurement) !==
              canonicalJson(evidence.dispatch_measurement) ||
            receipt.dispatch_measurement.delta.model !== 0 ||
            receipt.dispatch_measurement.delta.scanner !== 0 ||
            receipt.dispatch_measurement.delta.application !== 0))
      ) {
        fail(
          "unqualified_p01",
          `${criterion.criterion_id}.${variant.variant_id} evidence is stale, reused, or semantically misbound`
        );
      }
      executionLineages.add(receipt.execution_lineage_id);
      evidenceRecords.push(evidence);
    }
  }
  if (executionLineages.size !== 1 || !executionLineages.has(record.implementer_lineage_id)) {
    fail(
      "unqualified_p01",
      "qualification evidence does not share the exact implementer execution lineage"
    );
  }

  const reviewerAuthority = readArtifact({
    store: input.store,
    ref: record.reviewer_authority_ref,
    contract: {
      kind: "sca-reviewer-authority",
      schema_id: SCA_REVIEWER_AUTHORITY_V1_SCHEMA,
      schema_version: 1,
      producer: SCA_P01_TRUSTED_QUALIFICATION_PRODUCERS.reviewer_authority,
    },
    label: "P01 reviewer authority",
    options: input.options,
    validate: validateScaReviewerAuthorityV1,
  });
  const reviewReceipt = readArtifact({
    store: input.store,
    ref: record.reviewer_receipt_ref,
    contract: {
      kind: "sca-review-receipt",
      schema_id: SCA_REVIEW_RECEIPT_V1_SCHEMA,
      schema_version: 1,
      producer: SCA_P01_TRUSTED_QUALIFICATION_PRODUCERS.review_receipt,
    },
    label: "P01 independent review receipt",
    options: input.options,
    validate: validateScaReviewReceiptV1,
  });
  if (
    reviewerAuthority.decision !== "authorized" ||
    reviewerAuthority.implementation_revision !== record.implementation_revision ||
    reviewerAuthority.reviewer_identity_id === record.implementer_identity_id ||
    reviewerAuthority.reviewer_lineage_id === record.implementer_lineage_id ||
    !sameRef(reviewReceipt.reviewer_authority_ref, record.reviewer_authority_ref) ||
    reviewReceipt.reviewer_identity_id !== reviewerAuthority.reviewer_identity_id ||
    reviewReceipt.reviewer_lineage_id !== reviewerAuthority.reviewer_lineage_id ||
    reviewReceipt.implementation_revision !== record.implementation_revision ||
    !sameRef(reviewReceipt.qualification_profile_ref, record.qualification_profile_ref) ||
    reviewReceipt.decision !== "PASS" ||
    canonicalJson(reviewReceipt.evidence_refs) !== canonicalJson(sortedRefs(evidenceRefs))
  ) {
    fail(
      "invalid_reviewer",
      "reviewer authority, lineage separation, receipt, or evidence binding is invalid"
    );
  }
  const allRefs = sortedRefs([
    ...scaPhaseQualificationRefs(record),
    ...qualificationSourceMaterialRefs,
    implementation.source_ref,
    implementation.build_ref,
    ...evidenceRecords.flatMap((evidence) => [
      evidence.fixture_content_ref,
      evidence.log_ref,
      evidence.log_content_ref,
      evidence.boundary_receipt_ref,
    ]),
  ]);
  if (allRefs.some((ref) => ref.run_id !== record.run_id)) {
    fail("unqualified_p01", "qualification transitive material belongs to another run");
  }
  return {
    record,
    all_refs: allRefs,
    evidence_refs: evidenceRefs,
    source_file_manifest_ref: qualificationSource.file_manifest_ref,
    source_custody_ref: qualificationSource.custody_ref,
    implementation,
  };
}

function readPolicyBundle(input: {
  readonly store: ArtifactHostStore;
  readonly request: ScaP01AdmissionRequestV3;
  readonly options: ScaP01AdmissionOptions;
}): {
  readonly authority: ScaAuthorityPolicyV1;
  readonly material: ScaP01PolicyMaterial;
  readonly all_refs: readonly ArtifactRef[];
} {
  const analysisProfile = readArtifact({
    store: input.store,
    ref: input.request.analysis_profile.profile_ref,
    contract: {
      kind: "sca-analysis-profile",
      schema_id: SCA_ANALYSIS_PROFILE_V1_SCHEMA,
      schema_version: 1,
      producer: SCA_P01_TRUSTED_PRODUCERS.profile,
    },
    label: "analysis profile",
    options: input.options,
    validate: validateScaAnalysisProfileV1,
  });
  const ruleRelease = readArtifact({
    store: input.store,
    ref: input.request.rule_release_ref,
    contract: {
      kind: "sca-rule-release",
      schema_id: SCA_RULE_RELEASE_V1_SCHEMA,
      schema_version: 1,
      producer: SCA_P01_TRUSTED_PRODUCERS.rules,
    },
    label: "immutable rule release",
    options: input.options,
    validate: validateScaRuleReleaseV1,
  });
  const ruleBundle = readArtifact({
    store: input.store,
    ref: ruleRelease.rule_bundle_ref,
    contract: {
      kind: "sca-p01-rule-bundle",
      schema_id: SCA_P01_RULE_BUNDLE_V1_SCHEMA,
      schema_version: 1,
      producer: SCA_P01_TRUSTED_PRODUCERS.rule_bundle,
    },
    label: "immutable rule-bundle bytes",
    options: input.options,
    validate: validateScaP01RuleBundleV1,
  });
  const ruleProfile = readArtifact({
    store: input.store,
    ref: input.request.rule_profile_ref,
    contract: {
      kind: "sca-rule-profile",
      schema_id: SCA_RULE_PROFILE_V1_SCHEMA,
      schema_version: 1,
      producer: SCA_P01_TRUSTED_PRODUCERS.rules,
    },
    label: "rule profile",
    options: input.options,
    validate: validateScaRuleProfileV1,
  });
  const selectedRuleManifest = readArtifact({
    store: input.store,
    ref: ruleProfile.selected_rule_manifest_ref,
    contract: {
      kind: "sca-p01-selected-rule-manifest",
      schema_id: SCA_P01_SELECTED_RULE_MANIFEST_V1_SCHEMA,
      schema_version: 1,
      producer: SCA_P01_TRUSTED_PRODUCERS.rules,
    },
    label: "selected-rule manifest",
    options: input.options,
    validate: validateScaP01SelectedRuleManifestV1,
  });
  const toolchain = readArtifact({
    store: input.store,
    ref: input.request.toolchain_ref,
    contract: {
      kind: "sca-toolchain",
      schema_id: SCA_TOOLCHAIN_IDENTITY_V1_SCHEMA,
      schema_version: 1,
      producer: SCA_P01_TRUSTED_PRODUCERS.toolchain,
    },
    label: "scanner/parser toolchain",
    options: input.options,
    validate: validateScaToolchainIdentityV1,
  });
  const toolMaterial: ScaP01PolicyMaterial["tools"][number][] = [];
  for (const tool of toolchain.tools) {
    readMaterialArtifact({
      store: input.store,
      ref: tool.executable_ref,
      contract: {
        kind: "sca-p01-tool-executable-package",
        schema_id: SCA_P01_TOOL_EXECUTABLE_PACKAGE_V1_SCHEMA,
        schema_version: 1,
        producer: SCA_P01_TRUSTED_PRODUCERS.tool_executable,
        media_type: "application/octet-stream",
      },
      label: `${tool.tool_id} immutable executable package`,
      options: input.options,
    });
    const measurementReceipt = readArtifact({
      store: input.store,
      ref: tool.measurement_receipt_ref,
      contract: {
        kind: "sca-p01-tool-measurement-receipt",
        schema_id: SCA_P01_TOOL_MEASUREMENT_RECEIPT_V1_SCHEMA,
        schema_version: 1,
        producer: SCA_P01_TRUSTED_PRODUCERS.tool_measurement,
      },
      label: `${tool.tool_id} host measurement receipt`,
      options: input.options,
      validate: validateScaP01ToolMeasurementReceiptV1,
    });
    toolMaterial.push({
      executable_ref: tool.executable_ref,
      measurement_receipt_ref: tool.measurement_receipt_ref,
      measurement_receipt: measurementReceipt,
    });
  }
  const networkPolicy = readArtifact({
    store: input.store,
    ref: input.request.network_policy_ref,
    contract: {
      kind: "sca-network-policy",
      schema_id: SCA_NETWORK_POLICY_V1_SCHEMA,
      schema_version: 1,
      producer: SCA_P01_TRUSTED_PRODUCERS.policy,
    },
    label: "network policy",
    options: input.options,
    validate: validateScaNetworkPolicyV1,
  });
  const privacyPolicy = readArtifact({
    store: input.store,
    ref: input.request.privacy_policy_ref,
    contract: {
      kind: "sca-privacy-policy",
      schema_id: SCA_PRIVACY_POLICY_V1_SCHEMA,
      schema_version: 1,
      producer: SCA_P01_TRUSTED_PRODUCERS.policy,
    },
    label: "privacy policy",
    options: input.options,
    validate: validateScaPrivacyPolicyV1,
  });
  const modelDataPolicy = readArtifact({
    store: input.store,
    ref: input.request.model_data_policy_ref,
    contract: {
      kind: "sca-model-data-policy",
      schema_id: SCA_MODEL_DATA_POLICY_V1_SCHEMA,
      schema_version: 1,
      producer: SCA_P01_TRUSTED_PRODUCERS.policy,
    },
    label: "model-data disclosure policy",
    options: input.options,
    validate: validateScaModelDataPolicyV1,
  });
  const resourcePolicy = readArtifact({
    store: input.store,
    ref: input.request.resource_policy_ref,
    contract: {
      kind: "sca-resource-policy",
      schema_id: SCA_RESOURCE_POLICY_V1_SCHEMA,
      schema_version: 1,
      producer: SCA_P01_TRUSTED_PRODUCERS.policy,
    },
    label: "resource policy",
    options: input.options,
    validate: validateScaResourcePolicyV1,
  });
  const outputPolicy = readArtifact({
    store: input.store,
    ref: input.request.output_policy_ref,
    contract: {
      kind: "sca-output-policy",
      schema_id: SCA_OUTPUT_POLICY_V1_SCHEMA,
      schema_version: 1,
      producer: SCA_P01_TRUSTED_PRODUCERS.policy,
    },
    label: "output policy",
    options: input.options,
    validate: validateScaOutputPolicyV1,
  });
  const authority = readArtifact({
    store: input.store,
    ref: input.request.authority_policy_ref,
    contract: {
      kind: "sca-authority-policy",
      schema_id: SCA_AUTHORITY_POLICY_V1_SCHEMA,
      schema_version: 1,
      producer: SCA_P01_TRUSTED_PRODUCERS.authority,
    },
    label: "authority policy and admission decision",
    options: input.options,
    validate: validateScaAuthorityPolicyV1,
  });
  const material: ScaP01PolicyMaterial = {
    rule_release_ref: input.request.rule_release_ref,
    rule_bundle_ref: ruleRelease.rule_bundle_ref,
    rule_bundle: ruleBundle,
    selected_rule_manifest_ref: ruleProfile.selected_rule_manifest_ref,
    selected_rule_manifest: selectedRuleManifest,
    tools: toolMaterial,
  };
  if (
    material.rule_bundle_ref.run_id !== input.request.rule_release_ref.run_id ||
    material.selected_rule_manifest_ref.run_id !== input.request.rule_profile_ref.run_id ||
    material.tools.some(
      (tool) =>
        tool.executable_ref.run_id !== input.request.toolchain_ref.run_id ||
        tool.measurement_receipt_ref.run_id !== input.request.toolchain_ref.run_id
    )
  ) {
    fail("artifact_contract_mismatch", "rule or tool material belongs to another frozen run");
  }
  try {
    validateScaP01PolicyBundle({
      bundle: {
        analysis_profile: analysisProfile,
        rule_release: ruleRelease,
        rule_profile: ruleProfile,
        toolchain,
        network_policy: networkPolicy,
        privacy_policy: privacyPolicy,
        model_data_policy: modelDataPolicy,
        resource_policy: resourcePolicy,
        output_policy: outputPolicy,
        authority_policy: authority,
      },
      material,
      inline_profile: input.request.analysis_profile,
      inline_authorities: input.request.authorities,
      tenant_id: input.request.tenant_id,
      project_id: input.request.project_id,
      report_namespace: input.request.report_namespace,
    });
  } catch (error) {
    mapContractError(error);
  }
  return {
    authority,
    material,
    all_refs: sortedRefs([
      ruleRelease.rule_bundle_ref,
      ruleProfile.selected_rule_manifest_ref,
      ...toolMaterial.flatMap((tool) => [tool.executable_ref, tool.measurement_receipt_ref]),
    ]),
  };
}

/**
 * Inactive deterministic P01 candidate. The canonical engine/checkpointer remains the future caller
 * and admission marker owner at cutover; this function does not claim that integration or register a
 * playbook. It performs no model, scanner, parser, broker, package, target, or application dispatch.
 */
export function admitScaP01Candidate(input: {
  readonly store: ArtifactHostStore;
  readonly request: unknown;
  readonly options?: ScaP01AdmissionOptions;
}): ScaP01AdmissionResultV1 {
  const options = input.options ?? {};
  const dispatchBaseline = dispatchSnapshot(options.dispatchProbe);
  boundary(options, { stage: "before_work" });

  let request: ScaP01AdmissionRequestV3;
  try {
    request = validateScaP01AdmissionRequestV3(input.request);
  } catch (error) {
    mapContractError(error);
  }

  const sourceSnapshot = readArtifact({
    store: input.store,
    ref: request.source.snapshot_ref,
    contract: {
      kind: "source-snapshot",
      schema_id: SCA_CAMPAIGN_SOURCE_SNAPSHOT_V2_SCHEMA,
      schema_version: 2,
      producer: SCA_P01_TRUSTED_QUALIFICATION_PRODUCERS.source,
    },
    label: "campaign source snapshot",
    options,
    validate: validateScaCampaignSourceSnapshotV2,
  });
  const campaignSourceMaterialRefs = readSourceMaterial({
    store: input.store,
    snapshot: sourceSnapshot,
    snapshot_ref: request.source.snapshot_ref,
    options,
    label: "campaign source",
  });
  const sourceProvenance = readArtifact({
    store: input.store,
    ref: request.source.provenance_ref,
    contract: {
      kind: "source-provenance",
      schema_id: SCA_SOURCE_PROVENANCE_V1_SCHEMA,
      schema_version: 1,
      producer: SCA_P01_TRUSTED_QUALIFICATION_PRODUCERS.source,
    },
    label: "campaign source provenance",
    options,
    validate: validateScaSourceProvenanceV1,
  });
  if (
    !sameRef(sourceProvenance.snapshot_ref, request.source.snapshot_ref) ||
    !sameRef(sourceProvenance.file_manifest_ref, sourceSnapshot.file_manifest_ref) ||
    !sameRef(sourceProvenance.custody_ref, sourceSnapshot.custody_ref) ||
    sourceProvenance.custody_sha256 !== sourceSnapshot.custody_sha256 ||
    sourceSnapshot.status !== "frozen"
  ) {
    fail("artifact_contract_mismatch", "source provenance does not bind the exact frozen snapshot");
  }
  if (canonicalJson(sourceSnapshot.scope) !== canonicalJson(request.scope)) {
    fail(
      "artifact_contract_mismatch",
      "campaign source snapshot scope does not match request scope"
    );
  }

  const readVariants = (): readonly ArtifactRef[] => {
    if (request.source.variant_capture_manifest_ref === undefined) return [];
    try {
      return readScaP01VariantCaptureV1({
        store: input.store,
        manifest_ref: request.source.variant_capture_manifest_ref,
        context: request,
        exact_read: (ref, label) =>
          readExactArtifactBytes({ store: input.store, ref, label, options }),
      }).all_refs;
    } catch (error) {
      if (error instanceof ScaP01AdmissionError) throw error;
      fail("artifact_contract_mismatch", "variant capture closure is invalid", { cause: error });
    }
  };
  const variantRefs = readVariants();
  const policy = readPolicyBundle({ store: input.store, request, options });
  const qualification = readQualification({ store: input.store, request, options });
  assertNoDispatchDelta(dispatchBaseline, options.dispatchProbe);

  const requestRefs = scaP01AdmissionRequestRefs(request);
  const allInputRefs = sortedRefs([
    ...requestRefs,
    ...campaignSourceMaterialRefs,
    ...variantRefs,
    ...policy.all_refs,
    ...qualification.all_refs,
  ]);
  const requestPlan = planJsonArtifact(
    metadata({
      run_id: request.run_id,
      kind: "sca-p01-candidate-request",
      operation_id: "sca-p01-candidate-request",
      schema_id: SCA_P01_ADMISSION_REQUEST_V3_SCHEMA,
      schema_version: 3,
      upstream_refs: requestRefs,
    }),
    request
  );
  const ledger = buildScaInitialObligationLedgerV2({
    tenant_id: request.tenant_id,
    project_id: request.project_id,
    run_id: request.run_id,
    created_at: request.requested_at,
    assigning_authority_id: policy.authority.admission_authority_id,
    policy_refs: policyRefs(request),
    supporting_evidence_refs: sortedRefs([requestPlan.ref, request.p01_qualification_ref]),
  });
  const ledgerPlan = planJsonArtifact(
    metadata({
      run_id: request.run_id,
      kind: CANDIDATE_LEDGER_KIND,
      operation_id: CANDIDATE_LEDGER_OPERATION,
      schema_id: SCA_OBLIGATION_LEDGER_V2_SCHEMA,
      schema_version: 2,
      upstream_refs: [requestPlan.ref, request.authority_policy_ref, request.resource_policy_ref],
    }),
    ledger
  );
  const frozenRefs: ScaCampaignManifestCoreV1["frozen_refs"] = {
    source_snapshot_ref: request.source.snapshot_ref,
    source_file_manifest_ref: sourceSnapshot.file_manifest_ref,
    source_custody_ref: sourceSnapshot.custody_ref,
    source_provenance_ref: request.source.provenance_ref,
    ...(request.source.variant_capture_manifest_ref === undefined
      ? {}
      : { variant_capture_manifest_ref: request.source.variant_capture_manifest_ref }),
    analysis_profile_ref: request.analysis_profile.profile_ref,
    rule_release_ref: request.rule_release_ref,
    rule_bundle_ref: policy.material.rule_bundle_ref,
    rule_profile_ref: request.rule_profile_ref,
    selected_rule_manifest_ref: policy.material.selected_rule_manifest_ref,
    toolchain_ref: request.toolchain_ref,
    tool_executable_refs: sortedRefs(policy.material.tools.map((tool) => tool.executable_ref)),
    tool_measurement_receipt_refs: sortedRefs(
      policy.material.tools.map((tool) => tool.measurement_receipt_ref)
    ),
    network_policy_ref: request.network_policy_ref,
    privacy_policy_ref: request.privacy_policy_ref,
    model_data_policy_ref: request.model_data_policy_ref,
    resource_policy_ref: request.resource_policy_ref,
    output_policy_ref: request.output_policy_ref,
    authority_policy_ref: request.authority_policy_ref,
    p01_qualification_ref: request.p01_qualification_ref,
    qualification_source_file_manifest_ref: qualification.source_file_manifest_ref,
    qualification_source_custody_ref: qualification.source_custody_ref,
    implementation_source_ref: qualification.implementation.source_ref,
    implementation_build_ref: qualification.implementation.build_ref,
  };
  const coreUnsigned: Omit<ScaCampaignManifestCoreV1, "binding_sha256"> = {
    schema_id: SCA_CAMPAIGN_MANIFEST_CORE_V1_SCHEMA,
    schema_version: 1,
    tenant_id: request.tenant_id,
    project_id: request.project_id,
    run_id: request.run_id,
    request_ref: requestPlan.ref,
    obligation_ledger_ref: ledgerPlan.ref,
    implementation_revision: request.implementation_revision,
    runtime_cognition: request.runtime_cognition,
    report_namespace: request.report_namespace,
    authorities: request.authorities,
    frozen_refs: frozenRefs,
    status: "pending_gate",
    sca_completion_claimed: false,
  };
  const core = validateScaCampaignManifestCoreV1({
    ...coreUnsigned,
    binding_sha256: sha256(canonicalJson(coreUnsigned)),
  });
  const corePlan = planJsonArtifact(
    metadata({
      run_id: request.run_id,
      kind: "sca-p01-candidate-manifest-core",
      operation_id: "sca-p01-candidate-manifest-core",
      schema_id: SCA_CAMPAIGN_MANIFEST_CORE_V1_SCHEMA,
      schema_version: 1,
      upstream_refs: [requestPlan.ref, ledgerPlan.ref, ...allInputRefs],
    }),
    core
  );
  const admissionEvidence = validateScaP01AdmissionEvidenceV1({
    schema_id: SCA_P01_ADMISSION_EVIDENCE_V1_SCHEMA,
    schema_version: 1,
    tenant_id: request.tenant_id,
    project_id: request.project_id,
    run_id: request.run_id,
    request_ref: requestPlan.ref,
    obligation_ledger_ref: ledgerPlan.ref,
    manifest_core_ref: corePlan.ref,
    qualification_ref: request.p01_qualification_ref,
    evidence_refs: allInputRefs,
    checks: [
      { check_id: "artifact-bindings", status: "PASS" },
      { check_id: "semantic-policies", status: "PASS" },
      { check_id: "trusted-qualification", status: "PASS" },
      { check_id: "zero-dispatch", status: "PASS" },
    ],
    dispatch_delta: { model: 0, scanner: 0, application: 0 },
    status: "passed",
    evaluated_at: request.requested_at,
  });
  const evidencePlan = planJsonArtifact(
    metadata({
      run_id: request.run_id,
      kind: "sca-p01-candidate-admission-evidence",
      operation_id: "sca-p01-candidate-admission-evidence",
      schema_id: SCA_P01_ADMISSION_EVIDENCE_V1_SCHEMA,
      schema_version: 1,
      upstream_refs: [
        requestPlan.ref,
        ledgerPlan.ref,
        corePlan.ref,
        ...admissionEvidence.evidence_refs,
      ],
    }),
    admissionEvidence
  );
  const gate = validateScaPhaseGateRecordV2({
    schema_id: SCA_PHASE_GATE_RECORD_V2_SCHEMA,
    schema_version: 2,
    tenant_id: request.tenant_id,
    project_id: request.project_id,
    run_id: request.run_id,
    phase_id: "SCA-P01",
    implementation_revision: request.implementation_revision,
    request_ref: requestPlan.ref,
    obligation_ledger_ref: ledgerPlan.ref,
    manifest_core_ref: corePlan.ref,
    qualification_ref: request.p01_qualification_ref,
    admission_evidence_ref: evidencePlan.ref,
    criterion_results: SCA_P01_REQUIRED_CRITERION_IDS.map((criterion_id) => ({
      criterion_id,
      status: "PASS",
    })),
    status: "passed",
    evaluated_at: request.requested_at,
  });
  const gatePlan = planJsonArtifact(
    metadata({
      run_id: request.run_id,
      kind: "sca-p01-candidate-gate",
      operation_id: "sca-p01-candidate-gate",
      schema_id: SCA_PHASE_GATE_RECORD_V2_SCHEMA,
      schema_version: 2,
      upstream_refs: [
        requestPlan.ref,
        ledgerPlan.ref,
        corePlan.ref,
        evidencePlan.ref,
        request.p01_qualification_ref,
      ],
    }),
    gate
  );
  const manifestUnsigned: Omit<ScaCampaignManifestV2, "admission_binding_sha256"> = {
    schema_id: SCA_CAMPAIGN_MANIFEST_V2_SCHEMA,
    schema_version: 2,
    tenant_id: request.tenant_id,
    project_id: request.project_id,
    run_id: request.run_id,
    manifest_core_ref: corePlan.ref,
    p01_gate_ref: gatePlan.ref,
    request_ref: requestPlan.ref,
    obligation_ledger_ref: ledgerPlan.ref,
    authority_policy_ref: request.authority_policy_ref,
    admitted_phase_id: "SCA-P01",
    m1_status: "not_reached",
    campaign_status: "admitted",
    sca_completion_claimed: false,
    admitted_at: request.requested_at,
  };
  const manifest = validateScaCampaignManifestV2({
    ...manifestUnsigned,
    admission_binding_sha256: sha256(canonicalJson(manifestUnsigned)),
  });
  const manifestPlan = planJsonArtifact(
    metadata({
      run_id: request.run_id,
      kind: "sca-p01-candidate-campaign-manifest",
      operation_id: "sca-p01-candidate-campaign-manifest",
      schema_id: SCA_CAMPAIGN_MANIFEST_V2_SCHEMA,
      schema_version: 2,
      upstream_refs: [corePlan.ref, gatePlan.ref, requestPlan.ref, ledgerPlan.ref],
    }),
    manifest
  );

  try {
    validateScaP01AdmissionContextV1({
      request,
      request_ref: requestPlan.ref,
      ledger,
      ledger_ref: ledgerPlan.ref,
      core,
      core_ref: corePlan.ref,
      frozen_material_refs: frozenRefs,
      qualification: qualification.record,
      qualification_ref: request.p01_qualification_ref,
      admission_evidence: admissionEvidence,
      admission_evidence_ref: evidencePlan.ref,
      gate,
      gate_ref: gatePlan.ref,
      manifest,
    });
  } catch (error) {
    mapContractError(error);
  }

  const plans = [requestPlan, ledgerPlan, corePlan, evidencePlan, gatePlan, manifestPlan];
  for (const plan of plans) assertNoPlannedConflict(input.store, plan, options);
  assertNoDispatchDelta(dispatchBaseline, options.dispatchProbe);
  const persisted = plans.map((plan, index) =>
    persistPlan({
      store: input.store,
      plan,
      options,
      dispatchBaseline,
      ordinal: index + 1,
      finalMarker: index === plans.length - 1,
      ...(index === 0
        ? {
            prewrite_refs: allInputRefs,
            ...(variantRefs.length === 0
              ? {}
              : {
                  prewrite_validate: () => {
                    readVariants();
                  },
                }),
          }
        : {}),
    })
  );
  const [requestRef, ledgerRef, coreRef, evidenceRef, gateRef, manifestRef] = persisted;
  if (
    requestRef === undefined ||
    ledgerRef === undefined ||
    coreRef === undefined ||
    evidenceRef === undefined ||
    gateRef === undefined ||
    manifestRef === undefined
  ) {
    fail("persistence_failed", "candidate persistence result set is incomplete");
  }
  return {
    request_ref: requestRef,
    obligation_ledger_ref: ledgerRef,
    manifest_core_ref: coreRef,
    admission_evidence_ref: evidenceRef,
    p01_gate_ref: gateRef,
    campaign_manifest_ref: manifestRef,
  };
}

/**
 * Deterministically append one discovered obligation or promotion to the inactive candidate ledger.
 * Exact replay adopts the existing revision; changed replay operands conflict.
 */
export function reviseScaP01ObligationLedgerCandidate(input: {
  readonly store: ArtifactHostStore;
  readonly prior_ledger_ref: ArtifactRef;
  readonly operation: unknown;
  readonly authority_policy_ref: ArtifactRef;
  readonly resource_policy_ref: ArtifactRef;
  readonly options?: ScaP01AdmissionOptions;
}): ArtifactRef {
  const options = input.options ?? {};
  boundary(options, { stage: "before_work" });
  const prior = readArtifact({
    store: input.store,
    ref: input.prior_ledger_ref,
    contract: {
      kind: CANDIDATE_LEDGER_KIND,
      schema_id: SCA_OBLIGATION_LEDGER_V2_SCHEMA,
      schema_version: 2,
      producer: CANDIDATE_PRODUCER,
    },
    label: "prior candidate obligation ledger",
    options,
    validate: validateScaObligationLedgerV2,
  });
  const authority = readArtifact({
    store: input.store,
    ref: input.authority_policy_ref,
    contract: {
      kind: "sca-authority-policy",
      schema_id: SCA_AUTHORITY_POLICY_V1_SCHEMA,
      schema_version: 1,
      producer: SCA_P01_TRUSTED_PRODUCERS.authority,
    },
    label: "obligation revision authority policy",
    options,
    validate: validateScaAuthorityPolicyV1,
  });
  const resource = readArtifact({
    store: input.store,
    ref: input.resource_policy_ref,
    contract: {
      kind: "sca-resource-policy",
      schema_id: SCA_RESOURCE_POLICY_V1_SCHEMA,
      schema_version: 1,
      producer: SCA_P01_TRUSTED_PRODUCERS.policy,
    },
    label: "obligation revision resource policy",
    options,
    validate: validateScaResourcePolicyV1,
  });
  let operation: ReturnType<typeof validateScaObligationRevisionOperationV1>;
  try {
    operation = validateScaObligationRevisionOperationV1(input.operation);
  } catch (error) {
    mapContractError(error);
  }
  const initialAdmissionEntry = prior.entries[0];
  if (initialAdmissionEntry === undefined) {
    fail("artifact_contract_mismatch", "prior obligation ledger has no admission authority");
  }
  if (
    authority.status !== "approved" ||
    authority.admission_decision !== "allow" ||
    authority.grants.some((grant) => grant.posture !== "separate-gate-required") ||
    resource.status !== "approved"
  ) {
    fail("semantic_policy_denied", "obligation revision authority or resource policy is denied");
  }
  if (
    authority.tenant_id !== prior.tenant_id ||
    authority.project_id !== prior.project_id ||
    authority.admission_authority_id !== initialAdmissionEntry.assigning_authority_id ||
    canonicalJson(authority.grants.map((grant) => grant.role)) !==
      canonicalJson(["execution", "promotion", "release"])
  ) {
    fail(
      "artifact_contract_mismatch",
      "obligation revision policy does not match the exact campaign admission authority"
    );
  }
  if (operation.assigning_authority_id !== authority.admission_authority_id) {
    fail(
      "semantic_policy_denied",
      "obligation revision was not assigned by the exact campaign admission authority"
    );
  }
  for (const requiredPolicyRef of [input.authority_policy_ref, input.resource_policy_ref]) {
    if (!operation.policy_refs.some((ref) => sameRef(ref, requiredPolicyRef))) {
      fail(
        "semantic_policy_denied",
        "obligation revision omits an exact authority or resource policy ref"
      );
    }
  }
  let revised: ScaObligationLedgerV2;
  try {
    revised = appendScaObligationLedgerV2({
      prior_ledger: prior,
      prior_ledger_ref: input.prior_ledger_ref,
      operation,
      authority_policy_ref: input.authority_policy_ref,
      resource_policy_ref: input.resource_policy_ref,
    });
  } catch (error) {
    mapContractError(error);
  }
  const plan = planJsonArtifact(
    metadata({
      run_id: prior.run_id,
      kind: CANDIDATE_LEDGER_KIND,
      operation_id: CANDIDATE_LEDGER_OPERATION,
      schema_id: SCA_OBLIGATION_LEDGER_V2_SCHEMA,
      schema_version: 2,
      upstream_refs: [
        input.prior_ledger_ref,
        input.authority_policy_ref,
        input.resource_policy_ref,
      ],
      version: input.prior_ledger_ref.version + 1,
      parent_ref: input.prior_ledger_ref,
    }),
    revised
  );
  assertNoPlannedConflict(input.store, plan, options);
  return persistPlan({
    store: input.store,
    plan,
    options,
    ...(options.dispatchProbe === undefined
      ? {}
      : { dispatchBaseline: dispatchSnapshot(options.dispatchProbe) }),
    ordinal: 1,
    finalMarker: false,
  });
}
