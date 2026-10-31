import { previewArtifactRef, type ArtifactHostStore } from "../artifact-store.js";
import { readScaP01VariantCaptureV1 } from "./p01-source-variants.js";
import { canonicalJson, sha256 } from "../canonical-json.js";
import type { ArtifactRef, InputArtifacts } from "../contracts.js";
import {
  SCA_CAMPAIGN_MANIFEST_CORE_V1_SCHEMA,
  SCA_CAMPAIGN_MANIFEST_V2_SCHEMA,
  SCA_OBLIGATION_LEDGER_V2_SCHEMA,
  SCA_P01_ADMISSION_EVIDENCE_V1_SCHEMA,
  SCA_P01_ADMISSION_REQUEST_V3_SCHEMA,
  SCA_PHASE_GATE_RECORD_V2_SCHEMA,
  SCA_PHASE_QUALIFICATION_RECORD_V2_SCHEMA,
  validateScaCampaignManifestCoreV1,
  validateScaCampaignManifestV2,
  validateScaObligationLedgerV2,
  validateScaP01AdmissionEvidenceV1,
  validateScaP01AdmissionRequestV3,
  validateScaPhaseGateRecordV2,
  validateScaPhaseQualificationRecordV2,
} from "./p01-contracts.js";
import {
  SCA_M1_RECORD_V2_SCHEMA,
  SCA_P02_CANDIDATE_PRODUCER,
  SCA_P02_CANDIDATE_REQUEST_KIND,
  SCA_P02_COVERAGE_MATRIX_V1_SCHEMA,
  SCA_P02_EVIDENCE_MANIFEST_V1_SCHEMA,
  SCA_P02_GATE_V1_SCHEMA,
  SCA_P02_HOST_ATTESTATION_KIND,
  SCA_P02_HOST_ATTESTATION_V1_SCHEMA,
  SCA_P02_ISOLATION_EVIDENCE_PRODUCER,
  SCA_P02_ISOLATION_EVIDENCE_V1_SCHEMA,
  SCA_P02_P03_TRANSITION_V1_SCHEMA,
  SCA_P02_RUNTIME_POLICY_PRODUCER,
  SCA_P02_RUNTIME_POLICY_V1_SCHEMA,
  SCA_P02_SUCCESSOR_LEDGER_V1_SCHEMA,
  validateScaM1AgainstGateV2,
  validateScaM1RecordV2,
  validateScaP02AcceptedP01,
  validateScaP02CoverageMatrixV1,
  validateScaP02EvidenceManifestV1,
  validateScaP02GateAgainstCoverageV1,
  validateScaP02GateV1,
  validateScaP02HostIsolationAttestationV1,
  validateScaP02IsolationEvidenceV1,
  validateScaP02P03TransitionV1,
  validateScaP02RequestV1,
  validateScaP02RuntimePolicyV1,
  validateScaP02SuccessorLedgerAgainstP01V1,
  validateScaP02SuccessorLedgerV1,
  validateScaP02TransitionAgainstM1V1,
  type ScaP02HostIsolationAttestationV1,
  type ScaP02IsolationEvidenceV1,
  type ScaP02P03TransitionV1,
  type ScaP02RequestV1,
  type ScaP02RuntimePolicyV1,
} from "./p02-contracts.js";

const MAX_JSON_BYTES = 64 * 1024 * 1024;
const P01_CANDIDATE_PRODUCER = "host:sca-p01-candidate";

export interface ScaP02AdmissionResultV1 {
  readonly request: ScaP02RequestV1;
  readonly runtime_policy: ScaP02RuntimePolicyV1;
  readonly isolation_evidence: ScaP02IsolationEvidenceV1;
}

export class ScaP02AdmissionError extends Error {
  constructor(
    readonly code:
      | "invalid_request"
      | "missing_ref"
      | "ref_mismatch"
      | "artifact_contract_mismatch"
      | "invalid_p01_binding"
      | "invalid_input_set",
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "ScaP02AdmissionError";
  }
}

function fail(code: ScaP02AdmissionError["code"], message: string, cause?: unknown): never {
  throw new ScaP02AdmissionError(code, message, cause === undefined ? undefined : { cause });
}

function refKey(ref: ArtifactRef): string {
  return canonicalJson(ref);
}

function readExact(store: ArtifactHostStore, ref: ArtifactRef, label: string): Buffer {
  const stored = store.refById(ref.artifact_id);
  if (stored === undefined) fail("missing_ref", `${label} is absent`);
  if (refKey(stored) !== refKey(ref)) fail("ref_mismatch", `${label} ref drifted`);
  let metadata;
  let bytes: Buffer;
  try {
    metadata = store.metadata(ref);
    bytes = store.readById(ref.artifact_id);
  } catch (error) {
    fail("ref_mismatch", `${label} could not be read exactly`, error);
  }
  if (bytes.byteLength > MAX_JSON_BYTES)
    fail("artifact_contract_mismatch", `${label} is oversized`);
  const preview = previewArtifactRef({ metadata, content: bytes });
  if (
    refKey(preview) !== refKey(ref) ||
    bytes.byteLength !== ref.byte_length ||
    sha256(bytes) !== ref.content_digest
  ) {
    fail("ref_mismatch", `${label} bytes or metadata drifted`);
  }
  return bytes;
}

function readJson(store: ArtifactHostStore, ref: ArtifactRef, label: string): unknown {
  const text = readExact(store, ref, label).toString("utf8");
  let value: unknown;
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
  input: {
    readonly kind: string;
    readonly schemaId: string;
    readonly schemaVersion: number;
    readonly producer?: string;
  },
  label: string
): void {
  if (
    ref.kind !== input.kind ||
    ref.content_schema?.schema_id !== input.schemaId ||
    ref.content_schema.schema_version !== input.schemaVersion ||
    ref.media_type !== "application/json" ||
    (input.producer !== undefined && ref.producer !== input.producer)
  ) {
    fail("artifact_contract_mismatch", `${label} has an unexpected artifact contract`);
  }
}

export function assertScaP02HostAttestationBindingV1(input: {
  readonly request_ref: ArtifactRef | null;
  readonly evidence: ScaP02IsolationEvidenceV1;
  readonly attestation: ScaP02HostIsolationAttestationV1 | null;
}): void {
  const live = input.evidence.qualification_scope === "live_qualified";
  if (live !== (input.request_ref !== null) || live !== (input.attestation !== null)) {
    fail("invalid_p01_binding", "P02 live isolation host attestation is absent or unexpected");
  }
  if (!live || input.request_ref === null || input.attestation === null) return;
  const expected = {
    attestation_id: input.evidence.host_attestation_id,
    runtime_kind: input.evidence.runtime_kind,
    isolation_id: input.evidence.isolation_id,
    runtime_id: input.evidence.runtime_id,
    implementation_identity_sha256: input.evidence.implementation_identity_sha256,
    deployment_identity_sha256: input.evidence.deployment_identity_sha256,
    profile_id: input.evidence.profile_id,
    profile_sha256: input.evidence.profile_sha256,
    operation_profiles: input.evidence.operation_profiles,
    qualification_scope: input.evidence.qualification_scope,
    qualified: input.evidence.qualified,
    attested_at: input.evidence.qualified_at,
  };
  const observed = {
    attestation_id: input.attestation.attestation_id,
    runtime_kind: input.attestation.runtime_kind,
    isolation_id: input.attestation.isolation_id,
    runtime_id: input.attestation.runtime_id,
    implementation_identity_sha256: input.attestation.implementation_identity_sha256,
    deployment_identity_sha256: input.attestation.deployment_identity_sha256,
    profile_id: input.attestation.profile_id,
    profile_sha256: input.attestation.profile_sha256,
    operation_profiles: input.attestation.operation_profiles,
    qualification_scope: input.attestation.qualification_scope,
    qualified: input.attestation.qualified,
    attested_at: input.attestation.attested_at,
  };
  if (
    refKey(input.request_ref) !== refKey(input.evidence.host_attestation_ref) ||
    input.request_ref.content_digest !== input.evidence.host_attestation_sha256 ||
    canonicalJson(observed) !== canonicalJson(expected)
  ) {
    fail("invalid_p01_binding", "P02 live isolation host attestation fields drifted");
  }
}

function assertPersistedHostAttestationUpstream(input: {
  readonly store: ArtifactHostStore;
  readonly artifact_ref: ArtifactRef;
  readonly expected_ref: ArtifactRef | null;
  readonly label: string;
}): void {
  const observed = input.store
    .metadata(input.artifact_ref)
    .upstream_refs.filter(
      (ref) =>
        ref.kind === SCA_P02_HOST_ATTESTATION_KIND ||
        ref.content_schema?.schema_id === SCA_P02_HOST_ATTESTATION_V1_SCHEMA
    );
  const observedRef = observed[0];
  if (
    (input.expected_ref === null && observed.length !== 0) ||
    (input.expected_ref !== null &&
      (observed.length !== 1 ||
        observedRef === undefined ||
        refKey(observedRef) !== refKey(input.expected_ref)))
  ) {
    fail(
      "invalid_p01_binding",
      `${input.label} does not carry exact host isolation attestation upstream lineage`
    );
  }
}

function exactInputSet(request: ScaP02RequestV1): readonly ArtifactRef[] {
  return [
    request.accepted_p01.request_ref,
    request.accepted_p01.obligation_ledger_ref,
    request.accepted_p01.campaign_manifest_core_ref,
    request.accepted_p01.admission_evidence_ref,
    request.accepted_p01.p01_gate_ref,
    request.accepted_p01.campaign_manifest_ref,
    ...request.accepted_p01.frozen_refs,
    request.runtime_policy_ref,
    request.isolation_evidence_ref,
    ...(request.isolation_host_attestation_ref === null
      ? []
      : [request.isolation_host_attestation_ref]),
  ];
}

export function scaP02InputArtifacts(request: ScaP02RequestV1): InputArtifacts {
  const refs = exactInputSet(request);
  const seen = new Set<string>();
  const artifacts = refs
    .map((ref, index) => {
      const key = refKey(ref);
      if (seen.has(key)) {
        return undefined;
      }
      seen.add(key);
      return { slot: `sca_p02_input_${String(index).padStart(4, "0")}`, ref };
    })
    .filter(
      (binding): binding is { readonly slot: string; readonly ref: ArtifactRef } =>
        binding !== undefined
    );
  return { schema_version: 2, artifacts };
}

export function admitScaP02Candidate(input: {
  readonly store: ArtifactHostStore;
  readonly request: unknown;
  readonly input_artifacts: InputArtifacts;
}): ScaP02AdmissionResultV1 {
  let request: ScaP02RequestV1;
  try {
    request = validateScaP02RequestV1(input.request);
  } catch (error) {
    fail(
      "invalid_request",
      error instanceof Error ? error.message : "P02 request is invalid",
      error
    );
  }
  const expected = new Map(exactInputSet(request).map((ref) => [refKey(ref), ref]));
  const observed = input.input_artifacts.artifacts.map((binding) => refKey(binding.ref));
  if (
    input.input_artifacts.schema_version !== 2 ||
    new Set(observed).size !== observed.length ||
    observed.length !== expected.size ||
    observed.some((key) => !expected.has(key))
  ) {
    fail("invalid_input_set", "P02 input artifacts must be the exact unique accepted input set");
  }

  const p01 = request.accepted_p01;
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
  for (const [ref, kind, schemaId, schemaVersion, label] of contracts) {
    assertContract(ref, { kind, schemaId, schemaVersion, producer: P01_CANDIDATE_PRODUCER }, label);
  }
  assertContract(
    request.runtime_policy_ref,
    {
      kind: "sca-p02-runtime-policy",
      schemaId: SCA_P02_RUNTIME_POLICY_V1_SCHEMA,
      schemaVersion: 1,
      producer: SCA_P02_RUNTIME_POLICY_PRODUCER,
    },
    "P02 runtime policy"
  );
  assertContract(
    request.isolation_evidence_ref,
    {
      kind: "sca-p02-isolation-evidence",
      schemaId: SCA_P02_ISOLATION_EVIDENCE_V1_SCHEMA,
      schemaVersion: 1,
      producer: SCA_P02_ISOLATION_EVIDENCE_PRODUCER,
    },
    "P02 isolation evidence"
  );
  if (request.isolation_host_attestation_ref !== null) {
    assertContract(
      request.isolation_host_attestation_ref,
      {
        kind: SCA_P02_HOST_ATTESTATION_KIND,
        schemaId: SCA_P02_HOST_ATTESTATION_V1_SCHEMA,
        schemaVersion: 1,
        producer: SCA_P02_ISOLATION_EVIDENCE_PRODUCER,
      },
      "P02 host isolation attestation"
    );
  }

  try {
    const p01Request = validateScaP01AdmissionRequestV3(
      readJson(input.store, p01.request_ref, "P01 request")
    );
    const ledger = validateScaObligationLedgerV2(
      readJson(input.store, p01.obligation_ledger_ref, "P01 ledger")
    );
    const core = validateScaCampaignManifestCoreV1(
      readJson(input.store, p01.campaign_manifest_core_ref, "P01 manifest core")
    );
    const qualificationRef = core.frozen_refs.p01_qualification_ref;
    if (qualificationRef.content_schema?.schema_id !== SCA_PHASE_QUALIFICATION_RECORD_V2_SCHEMA) {
      fail("artifact_contract_mismatch", "P01 qualification ref has an unexpected schema");
    }
    const qualification = validateScaPhaseQualificationRecordV2(
      readJson(input.store, qualificationRef, "P01 qualification")
    );
    const admissionEvidence = validateScaP01AdmissionEvidenceV1(
      readJson(input.store, p01.admission_evidence_ref, "P01 admission evidence")
    );
    const gate = validateScaPhaseGateRecordV2(readJson(input.store, p01.p01_gate_ref, "P01 gate"));
    const manifest = validateScaCampaignManifestV2(
      readJson(input.store, p01.campaign_manifest_ref, "P01 campaign manifest")
    );
    validateScaP02AcceptedP01({
      request,
      p01_request: p01Request,
      ledger,
      core,
      qualification,
      admission_evidence: admissionEvidence,
      gate,
      manifest,
    });
    for (const [index, ref] of request.accepted_p01.frozen_refs.entries()) {
      readExact(input.store, ref, `P01 frozen ref ${index}`);
    }
    if (core.frozen_refs.variant_capture_manifest_ref !== undefined) {
      readScaP01VariantCaptureV1({
        store: input.store,
        manifest_ref: core.frozen_refs.variant_capture_manifest_ref,
        context: p01Request,
        evidence_refs: admissionEvidence.evidence_refs,
        exact_read: (ref, label) => readExact(input.store, ref, label),
      });
    }
    const runtimePolicy = validateScaP02RuntimePolicyV1(
      readJson(input.store, request.runtime_policy_ref, "P02 runtime policy")
    );
    const isolationEvidence = validateScaP02IsolationEvidenceV1(
      readJson(input.store, request.isolation_evidence_ref, "P02 isolation evidence")
    );
    const hostAttestation =
      request.isolation_host_attestation_ref === null
        ? null
        : validateScaP02HostIsolationAttestationV1(
            readJson(
              input.store,
              request.isolation_host_attestation_ref,
              "P02 host isolation attestation"
            )
          );
    assertScaP02HostAttestationBindingV1({
      request_ref: request.isolation_host_attestation_ref,
      evidence: isolationEvidence,
      attestation: hostAttestation,
    });
    if (
      refKey(runtimePolicy.isolation_evidence_ref) !== refKey(request.isolation_evidence_ref) ||
      isolationEvidence.profile_sha256 === "" ||
      isolationEvidence.producer_id !== request.isolation_evidence_ref.producer ||
      request.run_id !== p01Request.run_id
    ) {
      fail(
        "invalid_p01_binding",
        "P02 runtime/isolation binding drifted from the accepted request"
      );
    }
    return { request, runtime_policy: runtimePolicy, isolation_evidence: isolationEvidence };
  } catch (error) {
    if (error instanceof ScaP02AdmissionError) throw error;
    fail(
      "invalid_p01_binding",
      error instanceof Error ? error.message : "P01 binding is invalid",
      error
    );
  }
}

export interface ScaP03TransitionAdmissionV1 {
  consume(input: { readonly transition_ref: ArtifactRef }): ScaP02P03TransitionV1;
}

/** Validates the inactive P02→P03 boundary without implementing or dispatching P03. */
export function createScaP03TransitionAdmissionV1(input: {
  readonly store: ArtifactHostStore;
  readonly trusted_clock: () => Date;
}): ScaP03TransitionAdmissionV1 {
  return {
    consume({ transition_ref }) {
      assertContract(
        transition_ref,
        {
          kind: "sca-p02-p03-transition",
          schemaId: SCA_P02_P03_TRANSITION_V1_SCHEMA,
          schemaVersion: 1,
          producer: SCA_P02_CANDIDATE_PRODUCER,
        },
        "P02 to P03 transition"
      );
      const transition = validateScaP02P03TransitionV1(
        readJson(input.store, transition_ref, "P02 to P03 transition")
      );
      const authorityContracts = [
        [
          transition.p02_request_ref,
          SCA_P02_CANDIDATE_REQUEST_KIND,
          "penny.sca-p02-request.v1",
          SCA_P02_CANDIDATE_PRODUCER,
          "P02 candidate request",
        ],
        [
          transition.runtime_policy_ref,
          "sca-p02-runtime-policy",
          SCA_P02_RUNTIME_POLICY_V1_SCHEMA,
          SCA_P02_RUNTIME_POLICY_PRODUCER,
          "P02 runtime policy",
        ],
        [
          transition.isolation_evidence_ref,
          "sca-p02-isolation-evidence",
          SCA_P02_ISOLATION_EVIDENCE_V1_SCHEMA,
          SCA_P02_ISOLATION_EVIDENCE_PRODUCER,
          "P02 isolation evidence",
        ],
      ] as const;
      for (const [ref, kind, schemaId, producer, label] of authorityContracts) {
        assertContract(ref, { kind, schemaId, schemaVersion: 1, producer }, label);
      }
      const p02Request = validateScaP02RequestV1(
        readJson(input.store, transition.p02_request_ref, "P02 candidate request")
      );
      const runtimePolicy = validateScaP02RuntimePolicyV1(
        readJson(input.store, transition.runtime_policy_ref, "P02 runtime policy")
      );
      const isolation = validateScaP02IsolationEvidenceV1(
        readJson(input.store, transition.isolation_evidence_ref, "P02 isolation evidence")
      );
      const hostAttestation =
        p02Request.isolation_host_attestation_ref === null
          ? null
          : validateScaP02HostIsolationAttestationV1(
              readJson(
                input.store,
                p02Request.isolation_host_attestation_ref,
                "P02 host isolation attestation"
              )
            );
      assertScaP02HostAttestationBindingV1({
        request_ref: p02Request.isolation_host_attestation_ref,
        evidence: isolation,
        attestation: hostAttestation,
      });
      if (
        refKey(p02Request.runtime_policy_ref) !== refKey(transition.runtime_policy_ref) ||
        refKey(p02Request.isolation_evidence_ref) !== refKey(transition.isolation_evidence_ref) ||
        canonicalJson(p02Request.isolation_host_attestation_ref) !==
          canonicalJson(transition.isolation_host_attestation_ref) ||
        refKey(runtimePolicy.isolation_evidence_ref) !==
          refKey(transition.isolation_evidence_ref) ||
        p02Request.run_id !== transition.run_id
      ) {
        fail("invalid_p01_binding", "P03 admission P02 authority lineage is inconsistent");
      }
      for (const [ref, label] of [
        [transition_ref, "P02 to P03 transition"],
        [transition.evidence_manifest_ref, "P02 evidence manifest"],
        [transition.p02_gate_ref, "P02 gate"],
        [transition.m1_ref, "P02 M1 record"],
      ] as const) {
        assertPersistedHostAttestationUpstream({
          store: input.store,
          artifact_ref: ref,
          expected_ref: p02Request.isolation_host_attestation_ref,
          label,
        });
      }

      const outputContracts = [
        [
          transition.evidence_manifest_ref,
          "sca-p02-evidence-manifest",
          SCA_P02_EVIDENCE_MANIFEST_V1_SCHEMA,
          1,
          "P02 evidence manifest",
        ],
        [
          transition.successor_ledger_ref,
          "sca-p02-successor-obligation-ledger",
          SCA_P02_SUCCESSOR_LEDGER_V1_SCHEMA,
          1,
          "P02 successor ledger",
        ],
        [
          transition.coverage_matrix_ref,
          "sca-p02-coverage-matrix",
          SCA_P02_COVERAGE_MATRIX_V1_SCHEMA,
          1,
          "P02 coverage matrix",
        ],
        [transition.p02_gate_ref, "sca-p02-gate", SCA_P02_GATE_V1_SCHEMA, 1, "P02 gate"],
        [transition.m1_ref, "sca-m1-record", SCA_M1_RECORD_V2_SCHEMA, 2, "P02 M1 record"],
      ] as const;
      for (const [ref, kind, schemaId, schemaVersion, label] of outputContracts) {
        assertContract(
          ref,
          { kind, schemaId, schemaVersion, producer: SCA_P02_CANDIDATE_PRODUCER },
          label
        );
      }
      const manifest = validateScaP02EvidenceManifestV1(
        readJson(input.store, transition.evidence_manifest_ref, "P02 evidence manifest")
      );
      const successor = validateScaP02SuccessorLedgerV1(
        readJson(input.store, transition.successor_ledger_ref, "P02 successor ledger")
      );
      const coverage = validateScaP02CoverageMatrixV1(
        readJson(input.store, transition.coverage_matrix_ref, "P02 coverage matrix")
      );
      const gate = validateScaP02GateV1(readJson(input.store, transition.p02_gate_ref, "P02 gate"));
      const m1 = validateScaM1RecordV2(readJson(input.store, transition.m1_ref, "P02 M1 record"));
      const priorLedger = validateScaObligationLedgerV2(
        readJson(input.store, manifest.p01_predecessor_ledger_ref, "P01 predecessor ledger")
      );
      validateScaP02SuccessorLedgerAgainstP01V1({
        successor,
        prior_ledger: priorLedger,
        prior_ledger_ref: manifest.p01_predecessor_ledger_ref,
        p01_campaign_manifest_ref: manifest.p01_campaign_manifest_ref,
      });
      validateScaP02GateAgainstCoverageV1({
        gate,
        coverage,
        coverage_ref: transition.coverage_matrix_ref,
        successor_ledger_ref: transition.successor_ledger_ref,
        evidence_manifest_ref: transition.evidence_manifest_ref,
        evidence_manifest: manifest,
        successor_ledger: successor,
        p02_request_ref: transition.p02_request_ref,
        runtime_policy_ref: transition.runtime_policy_ref,
        isolation_evidence_ref: transition.isolation_evidence_ref,
        isolation_host_attestation_ref: transition.isolation_host_attestation_ref,
        isolation_evidence: isolation,
      });
      validateScaM1AgainstGateV2({
        m1,
        gate,
        gate_ref: transition.p02_gate_ref,
        coverage_ref: transition.coverage_matrix_ref,
        successor_ledger_ref: transition.successor_ledger_ref,
        evidence_manifest_ref: transition.evidence_manifest_ref,
        p02_request_ref: transition.p02_request_ref,
        runtime_policy_ref: transition.runtime_policy_ref,
        isolation_evidence_ref: transition.isolation_evidence_ref,
        isolation_host_attestation_ref: transition.isolation_host_attestation_ref,
      });
      validateScaP02TransitionAgainstM1V1({
        transition,
        m1,
        m1_ref: transition.m1_ref,
        gate_ref: transition.p02_gate_ref,
        coverage_ref: transition.coverage_matrix_ref,
        successor_ledger_ref: transition.successor_ledger_ref,
        evidence_manifest_ref: transition.evidence_manifest_ref,
        evidence_manifest: manifest,
        p01_request_ref: manifest.p01_request_ref,
        p01_campaign_manifest_core_ref: manifest.p01_campaign_manifest_core_ref,
        p01_campaign_manifest_ref: manifest.p01_campaign_manifest_ref,
        p01_predecessor_ledger_ref: manifest.p01_predecessor_ledger_ref,
        p02_request_ref: transition.p02_request_ref,
        runtime_policy_ref: transition.runtime_policy_ref,
        isolation_evidence_ref: transition.isolation_evidence_ref,
        isolation_host_attestation_ref: transition.isolation_host_attestation_ref,
      });
      const now = input.trusted_clock();
      if (!Number.isFinite(now.getTime())) {
        fail("invalid_request", "P03 transition trusted clock is invalid");
      }
      if (
        manifest.osv_evidence.some(
          (entry) => entry.expires_at !== null && now.getTime() > Date.parse(entry.expires_at)
        )
      ) {
        fail(
          "invalid_p01_binding",
          "P02 to P03 transition rejects OSV evidence expired at trusted consumption time"
        );
      }
      return transition;
    },
  };
}
