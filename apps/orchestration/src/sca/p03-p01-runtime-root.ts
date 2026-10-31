import { previewArtifactRef, type ArtifactHostStore } from "../artifact-store.js";
import { canonicalJson, sha256 } from "../canonical-json.js";
import type { ArtifactRef } from "../contracts.js";
import {
  SCA_CAMPAIGN_MANIFEST_CORE_V1_SCHEMA,
  SCA_CAMPAIGN_MANIFEST_V2_SCHEMA,
  SCA_OBLIGATION_LEDGER_V2_SCHEMA,
  SCA_P01_ADMISSION_EVIDENCE_V1_SCHEMA,
  SCA_P01_ADMISSION_REQUEST_V3_SCHEMA,
  SCA_PHASE_GATE_RECORD_V2_SCHEMA,
  SCA_PHASE_QUALIFICATION_RECORD_V2_SCHEMA,
  SCA_P01_TRUSTED_QUALIFICATION_PRODUCERS,
  validateScaCampaignManifestCoreV1,
  validateScaCampaignManifestV2,
  validateScaObligationLedgerV2,
  validateScaP01AdmissionContextV1,
  validateScaP01AdmissionEvidenceV1,
  validateScaP01AdmissionRequestV3,
  validateScaPhaseGateRecordV2,
  validateScaPhaseQualificationRecordV2,
  type ScaCampaignManifestCoreV1,
} from "./p01-contracts.js";
import {
  SCA_P01_TOOL_EXECUTABLE_PACKAGE_V1_SCHEMA,
  SCA_P01_TOOL_MEASUREMENT_RECEIPT_V1_SCHEMA,
  SCA_P01_TRUSTED_PRODUCERS,
  SCA_TOOLCHAIN_IDENTITY_V1_SCHEMA,
  validateScaP01ToolMeasurementReceiptV1,
  validateScaToolchainIdentityV1,
  type ScaP01ToolMeasurementReceiptV1,
  type ScaToolchainIdentityV1,
} from "./p01-policy-contracts.js";
import { scaP02FrozenRefs } from "./p02-contracts.js";

/** Exact-ref verifier reader: no persistence, selection, coordinates, or discovery authority. */
export type ScaP03ExactArtifactReaderV1 = Pick<
  ArtifactHostStore,
  "refById" | "readById" | "metadata"
>;

const MAX_JSON_BYTES = 64 * 1024 * 1024;
const P01_CANDIDATE_PRODUCER = "host:sca-p01-candidate";

export interface ScaP03AcceptedP01BindingsV1 {
  readonly request_ref: ArtifactRef;
  readonly obligation_ledger_ref: ArtifactRef;
  readonly campaign_manifest_core_ref: ArtifactRef;
  readonly admission_evidence_ref: ArtifactRef;
  readonly p01_gate_ref: ArtifactRef;
  readonly campaign_manifest_ref: ArtifactRef;
  readonly frozen_refs: readonly ArtifactRef[];
}

export interface ScaP03P01RuntimeRootSelectionV1 {
  readonly accepted_p01: ScaP03AcceptedP01BindingsV1;
  readonly core: ScaCampaignManifestCoreV1;
  readonly toolchain: ScaToolchainIdentityV1;
  readonly toolchain_ref: ArtifactRef;
  readonly root_tool_id: string;
  readonly root_executable_ref: ArtifactRef;
  readonly root_measurement_ref: ArtifactRef;
  readonly root_measurement: ScaP01ToolMeasurementReceiptV1;
}

export interface ScaP03P01RuntimeIdentityRootV1 {
  readonly root_tool_id: string;
  readonly toolchain_ref: ArtifactRef;
  readonly root_executable_ref: ArtifactRef;
  readonly root_measurement_ref: ArtifactRef;
  readonly joern_version: string;
}

export class ScaP03P01RuntimeRootError extends Error {
  constructor(
    readonly code:
      | "missing_ref"
      | "ref_mismatch"
      | "artifact_contract_mismatch"
      | "invalid_p01_cohort"
      | "invalid_runtime_root",
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "ScaP03P01RuntimeRootError";
  }
}

function fail(code: ScaP03P01RuntimeRootError["code"], message: string, cause?: unknown): never {
  throw new ScaP03P01RuntimeRootError(code, message, cause === undefined ? undefined : { cause });
}

function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function readExact(store: ScaP03ExactArtifactReaderV1, ref: ArtifactRef, label: string): Buffer {
  const stored = store.refById(ref.artifact_id);
  if (stored === undefined) fail("missing_ref", `${label} is absent`);
  if (!same(stored, ref)) fail("ref_mismatch", `${label} exact ref drifted`);
  let metadata;
  let bytes: Buffer;
  try {
    metadata = store.metadata(ref);
    bytes = store.readById(ref.artifact_id);
  } catch (error) {
    fail("ref_mismatch", `${label} could not be read exactly`, error);
  }
  if (
    !same(previewArtifactRef({ metadata, content: bytes }), ref) ||
    bytes.byteLength !== ref.byte_length ||
    sha256(bytes) !== ref.content_digest ||
    ref.store_ref !== `artifact://sha256/${ref.content_digest}`
  ) {
    fail("ref_mismatch", `${label} bytes or metadata drifted`);
  }
  return bytes;
}

function readJson(store: ScaP03ExactArtifactReaderV1, ref: ArtifactRef, label: string): unknown {
  const bytes = readExact(store, ref, label);
  if (bytes.byteLength > MAX_JSON_BYTES) {
    fail("artifact_contract_mismatch", `${label} exceeds the JSON byte limit`);
  }
  let value: unknown;
  const text = bytes.toString("utf8");
  try {
    value = JSON.parse(text);
  } catch (error) {
    fail("artifact_contract_mismatch", `${label} is not JSON`, error);
  }
  if (canonicalJson(value) !== text) {
    fail("artifact_contract_mismatch", `${label} is not canonical JSON`);
  }
  return value;
}

function assertContract(
  ref: ArtifactRef,
  expected: Readonly<{
    kind: string;
    schema_id: string;
    schema_version: number;
    producer?: string;
    media_type?: string;
  }>,
  label: string
): void {
  if (
    ref.kind !== expected.kind ||
    ref.content_schema?.schema_id !== expected.schema_id ||
    ref.content_schema.schema_version !== expected.schema_version ||
    ref.media_type !== (expected.media_type ?? "application/json") ||
    (expected.producer !== undefined && ref.producer !== expected.producer)
  ) {
    fail("artifact_contract_mismatch", `${label} has an unexpected artifact contract`);
  }
}

function validateAcceptedP01(input: {
  readonly store: ScaP03ExactArtifactReaderV1;
  readonly accepted_p01: ScaP03AcceptedP01BindingsV1;
}): ScaCampaignManifestCoreV1 {
  const { store, accepted_p01: p01 } = input;
  const contracts = [
    [
      p01.request_ref,
      "sca-p01-candidate-request",
      SCA_P01_ADMISSION_REQUEST_V3_SCHEMA,
      3,
      "P01 request",
    ],
    [
      p01.obligation_ledger_ref,
      "sca-p01-candidate-obligation-ledger",
      SCA_OBLIGATION_LEDGER_V2_SCHEMA,
      2,
      "P01 ledger",
    ],
    [
      p01.campaign_manifest_core_ref,
      "sca-p01-candidate-manifest-core",
      SCA_CAMPAIGN_MANIFEST_CORE_V1_SCHEMA,
      1,
      "P01 manifest core",
    ],
    [
      p01.admission_evidence_ref,
      "sca-p01-candidate-admission-evidence",
      SCA_P01_ADMISSION_EVIDENCE_V1_SCHEMA,
      1,
      "P01 admission evidence",
    ],
    [p01.p01_gate_ref, "sca-p01-candidate-gate", SCA_PHASE_GATE_RECORD_V2_SCHEMA, 2, "P01 gate"],
    [
      p01.campaign_manifest_ref,
      "sca-p01-candidate-campaign-manifest",
      SCA_CAMPAIGN_MANIFEST_V2_SCHEMA,
      2,
      "P01 campaign manifest",
    ],
  ] as const;
  for (const [ref, kind, schema_id, schema_version, label] of contracts) {
    assertContract(
      ref,
      { kind, schema_id, schema_version, producer: P01_CANDIDATE_PRODUCER },
      label
    );
  }
  try {
    const request = validateScaP01AdmissionRequestV3(
      readJson(store, p01.request_ref, "P01 request")
    );
    const ledger = validateScaObligationLedgerV2(
      readJson(store, p01.obligation_ledger_ref, "P01 ledger")
    );
    const core = validateScaCampaignManifestCoreV1(
      readJson(store, p01.campaign_manifest_core_ref, "P01 manifest core")
    );
    const qualificationRef = core.frozen_refs.p01_qualification_ref;
    assertContract(
      qualificationRef,
      {
        kind: "sca-phase-qualification",
        schema_id: SCA_PHASE_QUALIFICATION_RECORD_V2_SCHEMA,
        schema_version: 2,
        producer: SCA_P01_TRUSTED_QUALIFICATION_PRODUCERS.qualification,
      },
      "P01 qualification"
    );
    const qualification = validateScaPhaseQualificationRecordV2(
      readJson(store, qualificationRef, "P01 qualification")
    );
    const admissionEvidence = validateScaP01AdmissionEvidenceV1(
      readJson(store, p01.admission_evidence_ref, "P01 admission evidence")
    );
    const gate = validateScaPhaseGateRecordV2(readJson(store, p01.p01_gate_ref, "P01 gate"));
    const manifest = validateScaCampaignManifestV2(
      readJson(store, p01.campaign_manifest_ref, "P01 campaign manifest")
    );
    validateScaP01AdmissionContextV1({
      request,
      request_ref: p01.request_ref,
      ledger,
      ledger_ref: p01.obligation_ledger_ref,
      core,
      core_ref: p01.campaign_manifest_core_ref,
      frozen_material_refs: core.frozen_refs,
      qualification,
      qualification_ref: qualificationRef,
      admission_evidence: admissionEvidence,
      admission_evidence_ref: p01.admission_evidence_ref,
      gate,
      gate_ref: p01.p01_gate_ref,
      manifest,
    });
    const expected = scaP02FrozenRefs(core)
      .map((ref) => canonicalJson(ref))
      .sort();
    const observed = p01.frozen_refs.map((ref) => canonicalJson(ref)).sort();
    if (
      observed.length !== new Set(observed).size ||
      canonicalJson(observed) !== canonicalJson(expected)
    ) {
      fail("invalid_p01_cohort", "P01 bindings do not contain the exact frozen cohort");
    }
    for (const [index, ref] of p01.frozen_refs.entries()) {
      readExact(store, ref, `P01 frozen ref ${String(index)}`);
    }
    return core;
  } catch (error) {
    if (error instanceof ScaP03P01RuntimeRootError) throw error;
    fail(
      "invalid_p01_cohort",
      error instanceof Error ? error.message : "P01 cohort is invalid",
      error
    );
  }
}

/**
 * Revalidate one accepted P01 cohort and select its exact Joern parser root.
 * This function is read-only: it never admits, persists, wraps, or relabels an artifact.
 */
export function validateScaP03P01RuntimeRootV1(input: {
  readonly store: ScaP03ExactArtifactReaderV1;
  readonly accepted_p01: ScaP03AcceptedP01BindingsV1;
  readonly root_tool_id: string;
  readonly toolchain_ref: ArtifactRef;
  readonly root_executable_ref: ArtifactRef;
  readonly root_measurement_ref: ArtifactRef;
}): ScaP03P01RuntimeRootSelectionV1 {
  const core = validateAcceptedP01(input);
  if (!same(input.toolchain_ref, core.frozen_refs.toolchain_ref)) {
    fail("invalid_runtime_root", "P03 toolchain ref is not the exact accepted P01 toolchain");
  }
  assertContract(
    input.toolchain_ref,
    {
      kind: "sca-toolchain",
      schema_id: SCA_TOOLCHAIN_IDENTITY_V1_SCHEMA,
      schema_version: 1,
      producer: SCA_P01_TRUSTED_PRODUCERS.toolchain,
    },
    "P03 P01 toolchain"
  );
  const toolchain = validateScaToolchainIdentityV1(
    readJson(input.store, input.toolchain_ref, "P03 P01 toolchain")
  );
  const matches = toolchain.tools.filter((tool) => tool.tool_id === input.root_tool_id);
  const rootTool = matches[0];
  if (
    matches.length !== 1 ||
    rootTool === undefined ||
    rootTool.role !== "parser" ||
    !(["php", "javascript", "typescript"] as const).every((language) =>
      rootTool.languages.includes(language)
    ) ||
    !same(rootTool.executable_ref, input.root_executable_ref) ||
    !same(rootTool.measurement_receipt_ref, input.root_measurement_ref) ||
    !core.frozen_refs.tool_executable_refs.some((ref) => same(ref, input.root_executable_ref)) ||
    !core.frozen_refs.tool_measurement_receipt_refs.some((ref) =>
      same(ref, input.root_measurement_ref)
    )
  ) {
    fail(
      "invalid_runtime_root",
      "P03 Joern root is not one exact complete parser entry in the accepted P01 cohort"
    );
  }
  assertContract(
    input.root_executable_ref,
    {
      kind: "sca-p01-tool-executable-package",
      schema_id: SCA_P01_TOOL_EXECUTABLE_PACKAGE_V1_SCHEMA,
      schema_version: 1,
      producer: SCA_P01_TRUSTED_PRODUCERS.tool_executable,
      media_type: "application/octet-stream",
    },
    "P03 Joern root executable package"
  );
  assertContract(
    input.root_measurement_ref,
    {
      kind: "sca-p01-tool-measurement-receipt",
      schema_id: SCA_P01_TOOL_MEASUREMENT_RECEIPT_V1_SCHEMA,
      schema_version: 1,
      producer: SCA_P01_TRUSTED_PRODUCERS.tool_measurement,
    },
    "P03 Joern root measurement"
  );
  readExact(input.store, input.root_executable_ref, "P03 Joern root executable package");
  const rootMeasurement = validateScaP01ToolMeasurementReceiptV1(
    readJson(input.store, input.root_measurement_ref, "P03 Joern root measurement")
  );
  if (
    rootMeasurement.tool_id !== rootTool.tool_id ||
    rootMeasurement.role !== rootTool.role ||
    rootMeasurement.version !== rootTool.version ||
    !same(rootMeasurement.executable_ref, rootTool.executable_ref) ||
    rootMeasurement.executable_sha256 !== rootTool.executable_sha256 ||
    rootTool.executable_sha256 !== input.root_executable_ref.content_digest
  ) {
    fail(
      "invalid_runtime_root",
      "P03 Joern toolchain, executable package, and measurement do not bind one exact root"
    );
  }
  return {
    accepted_p01: input.accepted_p01,
    core,
    toolchain,
    toolchain_ref: input.toolchain_ref,
    root_tool_id: rootTool.tool_id,
    root_executable_ref: input.root_executable_ref,
    root_measurement_ref: input.root_measurement_ref,
    root_measurement: rootMeasurement,
  };
}

/** Bind a P03 runtime identity to the exact accepted P01 root, including its measured version. */
export function validateScaP03P01RuntimeIdentityRootV1(input: {
  readonly store: ScaP03ExactArtifactReaderV1;
  readonly accepted_p01: ScaP03AcceptedP01BindingsV1;
  readonly runtime: ScaP03P01RuntimeIdentityRootV1;
}): ScaP03P01RuntimeRootSelectionV1 {
  const selected = validateScaP03P01RuntimeRootV1({
    store: input.store,
    accepted_p01: input.accepted_p01,
    root_tool_id: input.runtime.root_tool_id,
    toolchain_ref: input.runtime.toolchain_ref,
    root_executable_ref: input.runtime.root_executable_ref,
    root_measurement_ref: input.runtime.root_measurement_ref,
  });
  if (selected.root_measurement.version !== input.runtime.joern_version) {
    fail(
      "invalid_runtime_root",
      "P03 Joern runtime version differs from the accepted P01 measurement"
    );
  }
  return selected;
}
