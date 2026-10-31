import { Type, type Static } from "typebox";

import { currentArtifactRef } from "../artifact-store.js";
import { canonicalJson, sha256 } from "../canonical-json.js";
import { ArtifactRefSchema, validateContract, type ArtifactRef } from "../contracts.js";
import { OpaqueIdSchema, Sha256Schema } from "../skill-contracts/common.js";
import {
  SCA_PHASE_CRITERION_DEFINITION_V1_SCHEMA,
  sealScaPhaseCriterionDefinitionV1,
  type ScaPhaseCriterionDefinitionV1,
  type ScaQualificationCriterionStatus,
} from "./qualification-gate-contracts.js";
import {
  type ScaArtifactBindingV1,
  type ScaArtifactContractV1,
  type ScaCriterionEvidenceClaimsV1,
  type ScaImplementationIdentityClaimsV1,
  type ScaPhaseQualificationDefinitionV1,
} from "./qualification-gate.js";

export const SCA_P03_QUALIFICATION_PHASE = "SCA-P03" as const;
export const SCA_P03_IMPLEMENTATION_IDENTITY_V1_SCHEMA =
  "penny.sca-p03-formal-implementation-identity.v1" as const;
export const SCA_P03_QUALIFICATION_EVIDENCE_V1_SCHEMA =
  "penny.sca-p03-formal-qualification-evidence.v1" as const;

// Freeze owned policy recursively; caller-owned inputs are copied before freezing below.
function freezePolicy<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezePolicy(child);
    Object.freeze(value);
  }
  return value;
}

/** Each entry is mandatory, live, host-bound, and has exactly one evidence artifact. */
export const SCA_P03_QUALIFICATION_CHECKS = freezePolicy({
  "AC-P03.baseline-queries": [
    "exact-query-release-and-source-oracle",
    "live-seven-query-language-matrix",
    "untruncated-source-bound-query-pages",
  ],
  "AC-P03.graph-construction": [
    "current-host-bootstrap-and-predecessor",
    "exact-implementation-source-manifest",
    "live-source-bound-graph-and-fidelity",
  ],
  "AC-P03.recovery-cancellation": [
    "cancellation-and-cleanup-census",
    "exact-restart-adoption-and-recovery",
    "fail-closed-containment-and-complements",
  ],
  "AC-P03.zero-model-ordering": [
    "nonterminal-p04-transition",
    "qualification-before-graph-before-queries",
    "zero-model-dispatch",
  ],
} as const);
export type ScaP03QualificationCriterionId = keyof typeof SCA_P03_QUALIFICATION_CHECKS;
export const SCA_P03_QUALIFICATION_CRITERION_IDS = freezePolicy([
  "AC-P03.baseline-queries",
  "AC-P03.graph-construction",
  "AC-P03.recovery-cancellation",
  "AC-P03.zero-model-ordering",
] as const satisfies readonly ScaP03QualificationCriterionId[]);

/** Snapshot selection is fixed; the caller must measure these exact repository files. */
export const SCA_P03_IMPLEMENTATION_SOURCE_PATHS = freezePolicy([
  ".pi/extensions/questionnaire/index.ts",
  ".pi/extensions/questionnaire/tests/helpers.ts",
  ".pi/extensions/questionnaire/tests/integration/questionnaire.integration.test.ts",
  ".pi/extensions/questionnaire/tests/unit/questionnaire.test.ts",
  ".pi/extensions/sca/index.ts",
  ".pi/extensions/sca/src/config.ts",
  ".pi/extensions/sca/src/contracts.ts",
  ".pi/extensions/sca/src/native-operator.ts",
  ".pi/extensions/sca/src/tools.ts",
  ".pi/extensions/sca/tests/integration/direct-agent-compatibility.integration.test.ts",
  ".pi/extensions/sca/tests/unit/config.test.ts",
  ".pi/extensions/sca/tests/unit/native-operator-closure.test.ts",
  ".pi/extensions/sca/tests/unit/native-operator.test.ts",
  ".pi/extensions/sca/tests/unit/tool-registration.test.ts",
  ".pi/extensions/skill/execution-receipts.ts",
  ".pi/extensions/skill/index.ts",
  ".pi/extensions/skill/skill-utils.ts",
  ".pi/extensions/skill/tests/unit/execution-owner-realm.test.ts",
  ".pi/extensions/skill/trusted-gate-driver.ts",
  ".pi/extensions/subagent/agent-runner.ts",
  ".pi/extensions/subagent/tests/unit/runtime-role-environment.test.ts",
  "apps/orchestration/src/artifact-store.ts",
  "apps/orchestration/src/canonical-json.ts",
  "apps/orchestration/src/checkpointer.ts",
  "apps/orchestration/src/contracts.ts",
  "apps/orchestration/src/host-operations/contracts.ts",
  "apps/orchestration/src/host-operations/lease-authority.ts",
  "apps/orchestration/src/host-operations/owner.ts",
  "apps/orchestration/src/host-operations/result-cache.ts",
  "apps/orchestration/src/host-operations/storage.ts",
  "apps/orchestration/src/playbooks/registry.ts",
  "apps/orchestration/src/playbooks/runtime-registration-digest.ts",
  "apps/orchestration/src/sca/activation-host-key.ts",
  "apps/orchestration/src/sca/activation-owner.ts",
  "apps/orchestration/src/sca/p01-contracts.ts",
  "apps/orchestration/src/sca/p01-policy-contracts.ts",
  "apps/orchestration/src/sca/p02-activation-host.ts",
  "apps/orchestration/src/sca/p02-admission.ts",
  "apps/orchestration/src/sca/p02-contracts.ts",
  "apps/orchestration/src/sca/p02-playbook.ts",
  "apps/orchestration/src/sca/p02-qualification.ts",
  "apps/orchestration/src/sca/p03-activation-host.ts",
  "apps/orchestration/src/sca/p03-admission.ts",
  "apps/orchestration/src/sca/p03-bootstrap-contracts.ts",
  "apps/orchestration/src/sca/p03-bootstrap-verification.ts",
  "apps/orchestration/src/sca/p03-contracts.ts",
  "apps/orchestration/src/sca/p03-initial-authorization.ts",
  "apps/orchestration/src/sca/p03-initial-qualification.ts",
  "apps/orchestration/src/sca/p03-operational-replay.ts",
  "apps/orchestration/src/sca/p03-p01-runtime-root.ts",
  "apps/orchestration/src/sca/p03-p02-qualification-guard.ts",
  "apps/orchestration/src/sca/p03-playbook.ts",
  "apps/orchestration/src/sca/p03-qualification-guard.ts",
  "apps/orchestration/src/sca/p03-qualification.ts",
  "apps/orchestration/src/sca/p04-admission.ts",
  "apps/orchestration/src/sca/p04-contracts.ts",
  "apps/orchestration/src/sca/phase-activation.ts",
  "apps/orchestration/src/sca/phase-registry.ts",
  "apps/orchestration/src/sca/qualification-activation-contracts.ts",
  "apps/orchestration/src/sca/qualification-activation.ts",
  "apps/orchestration/src/sca/qualification-gate-contracts.ts",
  "apps/orchestration/src/sca/qualification-gate-p01-compat.ts",
  "apps/orchestration/src/sca/qualification-gate.ts",
  "apps/orchestration/src/service.ts",
  "apps/orchestration/src/skill-contracts/common.ts",
  "apps/orchestration/src/state/catalog.ts",
  "apps/orchestration/src/state/paths.ts",
  "apps/orchestration/src/worker.ts",
  "apps/orchestration/tests/helpers/sca-p03-qualification-fixture.ts",
  "apps/orchestration/tests/host-operation-crash-recovery.test.ts",
  "apps/orchestration/tests/host-operation-result-cache.test.ts",
  "apps/orchestration/tests/host-operations-runtime.test.ts",
  "apps/orchestration/tests/orchestration-service-host-operation-cache.test.ts",
  "apps/orchestration/tests/sca-activation-owner.test.ts",
  "apps/orchestration/tests/sca-p01-admission.test.ts",
  "apps/orchestration/tests/sca-p03-activation-host.test.ts",
  "apps/orchestration/tests/sca-p03-candidate.test.ts",
  "apps/orchestration/tests/sca-p03-initial-authorization.test.ts",
  "apps/orchestration/tests/sca-p03-oracle-authority.test.ts",
  "apps/orchestration/tests/sca-p03-p02-qualification-guard.test.ts",
  "apps/orchestration/tests/sca-p03-path-v2.test.ts",
  "apps/orchestration/tests/sca-p03-qualification-guard.test.ts",
  "apps/orchestration/tests/sca-p03-qualification.test.ts",
  "apps/orchestration/tests/sca-p04-contracts.test.ts",
  "apps/orchestration/tests/sca-p04-playbook.test.ts",
  "apps/orchestration/tests/sca-phase-gates.test.ts",
  "apps/orchestration/tests/sca-qualification-activation.test.ts",
  "apps/sca-service/P03-BOOTSTRAP.md",
  "apps/sca-service/package.json",
  "apps/sca-service/src/config.ts",
  "apps/sca-service/src/contracts.ts",
  "apps/sca-service/src/index.ts",
  "apps/sca-service/src/jobs.ts",
  "apps/sca-service/src/p01-joern-root.ts",
  "apps/sca-service/src/p03-bootstrap-cli-contracts.ts",
  "apps/sca-service/src/p03-bootstrap-cli.ts",
  "apps/sca-service/src/p03-bootstrap-freeze.ts",
  "apps/sca-service/src/p03-bootstrap-host.ts",
  "apps/sca-service/src/p03-bootstrap-issuers.ts",
  "apps/sca-service/src/p03-bootstrap-local-probe.ts",
  "apps/sca-service/src/p03-bootstrap-measure.ts",
  "apps/sca-service/src/p03-bootstrap-v3.ts",
  "apps/sca-service/src/p03-bootstrap-verification.ts",
  "apps/sca-service/src/p03-bootstrap-witness.ts",
  "apps/sca-service/src/p03-bootstrap-workspaces.ts",
  "apps/sca-service/src/p03-bootstrap-writer.ts",
  "apps/sca-service/src/p03-bootstrap.ts",
  "apps/sca-service/src/p03-consumed-fixture-custody.ts",
  "apps/sca-service/src/p03-consumed-fixture-evidence.ts",
  "apps/sca-service/src/p03-consumed-fixture-transcript.ts",
  "apps/sca-service/src/p03-docker-runtime.ts",
  "apps/sca-service/src/p03-initial-cohort.ts",
  "apps/sca-service/src/p03-initial-host.ts",
  "apps/sca-service/src/p03-initial-live.ts",
  "apps/sca-service/src/p03-live-transport.ts",
  "apps/sca-service/src/p03-operations.ts",
  "apps/sca-service/src/p03-oracle-authority.ts",
  "apps/sca-service/src/p03-predecessor-inputs.ts",
  "apps/sca-service/src/p03-production-activation.ts",
  "apps/sca-service/src/p03-production-runtime.ts",
  "apps/sca-service/src/p03-production-sampler.ts",
  "apps/sca-service/src/p03-source-oracle-contracts.ts",
  "apps/sca-service/src/p03-source-oracle-receipt.ts",
  "apps/sca-service/src/p03-source-oracle.ts",
  "apps/sca-service/src/p03-toolchain-version.ts",
  "apps/sca-service/src/p03-verification-reader.ts",
  "apps/sca-service/src/process.ts",
  "apps/sca-service/src/router.ts",
  "apps/sca-service/src/source-custody-materializer.ts",
  "apps/sca-service/tests/fixtures/p03-verification-kill-worker.ts",
  "apps/sca-service/tests/p01-joern-root.test.ts",
  "apps/sca-service/tests/p03-bootstrap-host.test.ts",
  "apps/sca-service/tests/p03-bootstrap-production-host.test.ts",
  "apps/sca-service/tests/p03-bootstrap-verification.test.ts",
  "apps/sca-service/tests/p03-bootstrap.test.ts",
  "apps/sca-service/tests/p03-consumed-fixture-evidence.test.ts",
  "apps/sca-service/tests/p03-consumed-fixture-helper.ts",
  "apps/sca-service/tests/p03-consumed-fixture-integration.ts",
  "apps/sca-service/tests/p03-docker-runtime.test.ts",
  "apps/sca-service/tests/p03-host-owner-regression.ts",
  "apps/sca-service/tests/p03-initial-collector.live.test.ts",
  "apps/sca-service/tests/p03-initial-live.test.ts",
  "apps/sca-service/tests/p03-initial-native.test.ts",
  "apps/sca-service/tests/p03-initial-positive.test.ts",
  "apps/sca-service/tests/p03-live-transport.test.ts",
  "apps/sca-service/tests/p03-operation-recovery.test.ts",
  "apps/sca-service/tests/p03-oracle-assertions.test.ts",
  "apps/sca-service/tests/p03-oracle-authority.test.ts",
  "apps/sca-service/tests/p03-positive-watchdog.ts",
  "apps/sca-service/tests/p03-predecessor-inputs.test.ts",
  "apps/sca-service/tests/p03-production-activation.test.ts",
  "apps/sca-service/tests/p03-production-runtime.test.ts",
  "apps/sca-service/tests/p03-production-sampler-fixture.ts",
  "apps/sca-service/tests/p03-production-sampler.test.ts",
  "apps/sca-service/tests/p03-source-oracle.test.ts",
  "apps/sca-service/tests/p03-toolchain-version.test.ts",
  "apps/sca-service/tests/source-custody-materializer.test.ts",
] as const);

const SourceFileSchema = freezePolicy(
  Type.Object(
    {
      path: Type.String({ minLength: 1, maxLength: 1024 }),
      sha256: Sha256Schema,
      byte_length: Type.Integer({ minimum: 1, maximum: 64 * 1_048_576 }),
    },
    { additionalProperties: false }
  )
);
export type ScaP03ImplementationSourceFileV1 = Readonly<Static<typeof SourceFileSchema>>;
const Claims = {
  tenant_id: OpaqueIdSchema,
  project_id: OpaqueIdSchema,
  run_id: OpaqueIdSchema,
  phase_id: Type.Literal(SCA_P03_QUALIFICATION_PHASE),
  implementation_revision: OpaqueIdSchema,
  assurance_scope: Type.Literal("host_derived_binding"),
  host_binding_sha256: Sha256Schema,
  implementer_identity_id: OpaqueIdSchema,
  implementer_lineage_id: OpaqueIdSchema,
} as const;

export const ScaP03ImplementationIdentityV1Schema = freezePolicy(
  Type.Object(
    {
      schema_id: Type.Literal(SCA_P03_IMPLEMENTATION_IDENTITY_V1_SCHEMA),
      schema_version: Type.Literal(1),
      ...Claims,
      source_files: Type.Array(SourceFileSchema, {
        minItems: 1,
        maxItems: SCA_P03_IMPLEMENTATION_SOURCE_PATHS.length,
      }),
      source_manifest_sha256: Sha256Schema,
    },
    { additionalProperties: false, $id: SCA_P03_IMPLEMENTATION_IDENTITY_V1_SCHEMA }
  )
);
export type ScaP03ImplementationIdentityV1 = Readonly<
  Static<typeof ScaP03ImplementationIdentityV1Schema>
> &
  ScaImplementationIdentityClaimsV1;

const ObservationSchema = freezePolicy(
  Type.Object(
    { check_id: OpaqueIdSchema, observed: Type.Boolean() },
    { additionalProperties: false }
  )
);
export const ScaP03QualificationEvidenceV1Schema = freezePolicy(
  Type.Object(
    {
      schema_id: Type.Literal(SCA_P03_QUALIFICATION_EVIDENCE_V1_SCHEMA),
      schema_version: Type.Literal(1),
      ...Claims,
      criterion_id: Type.Union([
        Type.Literal("AC-P03.graph-construction"),
        Type.Literal("AC-P03.baseline-queries"),
        Type.Literal("AC-P03.recovery-cancellation"),
        Type.Literal("AC-P03.zero-model-ordering"),
      ]),
      subject_sha256: Sha256Schema,
      observations: Type.Array(ObservationSchema, { minItems: 1, maxItems: 32 }),
      supporting_refs: Type.Array(ArtifactRefSchema, { minItems: 1, maxItems: 1024 }),
    },
    { additionalProperties: false, $id: SCA_P03_QUALIFICATION_EVIDENCE_V1_SCHEMA }
  )
);
export type ScaP03QualificationEvidenceV1 = Readonly<
  Static<typeof ScaP03QualificationEvidenceV1Schema>
> &
  ScaCriterionEvidenceClaimsV1;

function compare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}
function orderedUnique(values: readonly string[], label: string): void {
  if (
    new Set(values).size !== values.length ||
    values.some((v, i) => i > 0 && compare(values[i - 1] ?? "", v) >= 0)
  ) {
    throw new Error(`${label} must be unique and UTF-8 sorted`);
  }
}
function exactRefs(refs: readonly ArtifactRef[], label: string): void {
  for (const ref of refs) currentArtifactRef(ref, label);
  orderedUnique(
    refs.map((ref) => ref.artifact_id),
    label
  );
}
function sourceFiles(value: unknown): readonly ScaP03ImplementationSourceFileV1[] {
  const files = validateContract(
    Type.Array(SourceFileSchema, {
      minItems: 1,
      maxItems: SCA_P03_IMPLEMENTATION_SOURCE_PATHS.length,
    }),
    value,
    "P03 implementation source files"
  );
  orderedUnique(
    files.map((file) => file.path),
    "P03 source paths"
  );
  for (const file of files) {
    if (
      file.path.startsWith("/") ||
      file.path.includes("\\") ||
      file.path.split("/").some((part) => part === "" || part === "." || part === "..") ||
      /^[A-Za-z]:/u.test(file.path)
    ) {
      throw new Error("P03 source path must be repository-relative and canonical");
    }
  }
  if (
    canonicalJson(files.map((file) => file.path)) !==
    canonicalJson(SCA_P03_IMPLEMENTATION_SOURCE_PATHS)
  ) {
    throw new Error("P03 source manifest must cover the fixed implementation path set");
  }
  return files;
}
/** Pure manifest digest; measurement and current-host comparison belong to the host. */
export function scaP03SourceManifestSha256(
  files: readonly ScaP03ImplementationSourceFileV1[]
): string {
  return sha256(canonicalJson(sourceFiles(files)));
}

export function validateScaP03ImplementationIdentityV1(
  value: unknown
): ScaP03ImplementationIdentityV1 {
  const identity = validateContract(
    ScaP03ImplementationIdentityV1Schema,
    value,
    "P03 implementation identity"
  );
  if (
    identity.implementer_identity_id === identity.implementer_lineage_id ||
    identity.source_manifest_sha256 !== scaP03SourceManifestSha256(identity.source_files)
  ) {
    throw new Error("P03 implementation identity or source manifest is invalid");
  }
  return identity;
}
export function validateScaP03QualificationEvidenceV1(
  value: unknown
): ScaP03QualificationEvidenceV1 {
  const evidence = validateContract(
    ScaP03QualificationEvidenceV1Schema,
    value,
    "P03 qualification evidence"
  );
  const actual = evidence.observations.map((o) => o.check_id);
  orderedUnique(actual, "P03 checks");
  if (
    canonicalJson(actual) !== canonicalJson(SCA_P03_QUALIFICATION_CHECKS[evidence.criterion_id]) ||
    evidence.observations.some((o) => o.observed !== true)
  ) {
    throw new Error("P03 live evidence requires every known check to be true");
  }
  exactRefs(evidence.supporting_refs, "P03 supporting refs");
  return evidence;
}

/** No I/O or issuance: callers supply measurements and subject-bound observations. */
export function buildScaP03ImplementationIdentityV1(
  input: Omit<
    ScaP03ImplementationIdentityV1,
    "schema_id" | "schema_version" | "phase_id" | "assurance_scope" | "source_manifest_sha256"
  >
): ScaP03ImplementationIdentityV1 {
  return validateScaP03ImplementationIdentityV1({
    ...input,
    schema_id: SCA_P03_IMPLEMENTATION_IDENTITY_V1_SCHEMA,
    schema_version: 1,
    phase_id: SCA_P03_QUALIFICATION_PHASE,
    assurance_scope: "host_derived_binding",
    source_manifest_sha256: scaP03SourceManifestSha256(input.source_files),
  });
}
export function buildScaP03CriterionDefinitionV1(input: {
  readonly tenant_id: string;
  readonly project_id: string;
  readonly run_id: string;
  readonly implementation_revision: string;
  readonly criterion_id: ScaP03QualificationCriterionId;
}): ScaPhaseCriterionDefinitionV1 {
  if (!Object.hasOwn(SCA_P03_QUALIFICATION_CHECKS, input.criterion_id))
    throw new Error("Unknown P03 criterion");
  return sealScaPhaseCriterionDefinitionV1({
    schema_id: SCA_PHASE_CRITERION_DEFINITION_V1_SCHEMA,
    schema_version: 1,
    ...input,
    phase_id: SCA_P03_QUALIFICATION_PHASE,
    required_assurance_scope: "host_derived_binding",
    required_evidence_class: "live",
    required_evidence_count: 1,
  });
}
export function buildScaP03QualificationEvidenceV1(
  input: Omit<
    ScaP03QualificationEvidenceV1,
    "schema_id" | "schema_version" | "phase_id" | "assurance_scope"
  >
): ScaP03QualificationEvidenceV1 {
  return validateScaP03QualificationEvidenceV1({
    ...input,
    schema_id: SCA_P03_QUALIFICATION_EVIDENCE_V1_SCHEMA,
    schema_version: 1,
    phase_id: SCA_P03_QUALIFICATION_PHASE,
    assurance_scope: "host_derived_binding",
  });
}

export const SCA_P03_QUALIFICATION_ARTIFACTS = freezePolicy({
  identity: {
    artifact_kind: "sca-p03-formal-implementation-identity",
    schema_id: SCA_P03_IMPLEMENTATION_IDENTITY_V1_SCHEMA,
    schema_version: 1,
    producer: "host:sca-p03-qualification",
  },
  definition: {
    artifact_kind: "sca-p03-criterion-definition",
    schema_id: SCA_PHASE_CRITERION_DEFINITION_V1_SCHEMA,
    schema_version: 1,
    producer: "host:sca-p03-qualification",
  },
  evidence: {
    artifact_kind: "sca-p03-formal-qualification-evidence",
    schema_id: SCA_P03_QUALIFICATION_EVIDENCE_V1_SCHEMA,
    schema_version: 1,
    producer: "host:sca-p03-live-evidence",
  },
});

function copyRef(ref: ArtifactRef): ArtifactRef {
  const current = currentArtifactRef(ref);
  return {
    ...current,
    ...(current.content_schema === undefined
      ? {}
      : { content_schema: { ...current.content_schema } }),
  };
}
function copyBinding(binding: ScaArtifactBindingV1): ScaArtifactBindingV1 {
  return {
    ref: copyRef(binding.ref),
    parent_ref: binding.parent_ref === null ? null : copyRef(binding.parent_ref),
    upstream_refs: binding.upstream_refs.map(copyRef),
  };
}

export interface ScaP03QualificationDefinitionInputV1 {
  readonly tenant_id: string;
  readonly project_id: string;
  readonly run_id: string;
  readonly implementation_revision: string;
  readonly current_host_binding_sha256: string;
  readonly current_source_manifest_sha256: string;
  readonly max_unique_artifact_bytes: number;
  readonly reviewer_authority_id: string;
  readonly reviewer_identity_id: string;
  readonly reviewer_lineage_id: string;
  readonly implementation_identity: ScaArtifactBindingV1;
  readonly qualified_inputs: readonly ScaArtifactBindingV1[];
  readonly criterion_definition_refs: Readonly<Record<ScaP03QualificationCriterionId, ArtifactRef>>;
  readonly reviewer_authority_contract: ScaArtifactContractV1;
  readonly reviewer_receipt_contract: ScaArtifactContractV1;
  readonly qualification_record_contract: ScaArtifactContractV1;
  readonly gate_record_contract: ScaArtifactContractV1;
  readonly max_json_artifact_bytes: number;
}

/** In-process qualification policy, not a registry entry or an activation authority. */
export function createScaP03QualificationDefinitionV1(
  input: ScaP03QualificationDefinitionInputV1
): ScaPhaseQualificationDefinitionV1 {
  if (
    !Number.isSafeInteger(input.max_json_artifact_bytes) ||
    input.max_json_artifact_bytes < 1 ||
    input.max_json_artifact_bytes > 16 * 1_048_576
  ) {
    throw new Error("P03 JSON byte limit is invalid");
  }
  const contract = (part: keyof typeof SCA_P03_QUALIFICATION_ARTIFACTS): ScaArtifactContractV1 => ({
    ...SCA_P03_QUALIFICATION_ARTIFACTS[part],
    media_type: "application/json",
    max_bytes: input.max_json_artifact_bytes,
  });
  const currentSourceManifestSha256 = validateContract(
    Sha256Schema,
    input.current_source_manifest_sha256,
    "current P03 source manifest SHA-256"
  );
  const qualifiedRefs = freezePolicy(
    input.qualified_inputs
      .map((binding) => copyRef(binding.ref))
      .sort((a, b) => compare(a.artifact_id, b.artifact_id))
  );
  exactRefs(qualifiedRefs, "P03 qualified inputs");
  if (qualifiedRefs.length === 0) throw new Error("P03 requires qualified inputs");
  const definition: ScaPhaseQualificationDefinitionV1 = {
    schema_version: 1,
    tenant_id: input.tenant_id,
    project_id: input.project_id,
    run_id: input.run_id,
    phase_id: SCA_P03_QUALIFICATION_PHASE,
    implementation_revision: input.implementation_revision,
    required_assurance_scope: "host_derived_binding",
    current_host_binding_sha256: input.current_host_binding_sha256,
    max_unique_artifact_bytes: input.max_unique_artifact_bytes,
    reviewer_authority_id: input.reviewer_authority_id,
    reviewer_identity_id: input.reviewer_identity_id,
    reviewer_lineage_id: input.reviewer_lineage_id,
    implementation_identity: copyBinding(input.implementation_identity),
    implementation_identity_contract: {
      ...contract("identity"),
      validate: (value: unknown) => {
        const identity = validateScaP03ImplementationIdentityV1(value);
        if (identity.source_manifest_sha256 !== currentSourceManifestSha256) {
          throw new Error("P03 source manifest is stale relative to the host measurement");
        }
        return identity;
      },
    },
    qualified_inputs: input.qualified_inputs.map(copyBinding),
    criteria: SCA_P03_QUALIFICATION_CRITERION_IDS.map((criterion_id) => ({
      criterion_id,
      definition_ref: copyRef(input.criterion_definition_refs[criterion_id]),
      definition_contract: contract("definition"),
      evidence_contract: {
        ...contract("evidence"),
        evidence_class: "live",
        validate: (value: unknown) => {
          const evidence = validateScaP03QualificationEvidenceV1(value);
          if (
            evidence.criterion_id !== criterion_id ||
            canonicalJson(evidence.supporting_refs) !== canonicalJson(qualifiedRefs)
          ) {
            throw new Error("P03 evidence criterion or exact qualified supporting refs mismatch");
          }
          return evidence;
        },
        evaluate: (
          claims: readonly ScaCriterionEvidenceClaimsV1[]
        ): ScaQualificationCriterionStatus => {
          // The generic evaluator's three-valued rule remains defined for incomplete observations;
          // production validation above deliberately refuses to admit false/null as formal live evidence.
          if (claims.some((claim) => claim.observations.some((o) => o.observed === false)))
            return "FAIL";
          if (claims.some((claim) => claim.observations.some((o) => o.observed === null)))
            return "BLOCKED";
          return claims.length === 1 &&
            claims[0]?.observations.length === SCA_P03_QUALIFICATION_CHECKS[criterion_id].length &&
            canonicalJson(claims[0].observations.map((o) => o.check_id)) ===
              canonicalJson(SCA_P03_QUALIFICATION_CHECKS[criterion_id]) &&
            claims[0].observations.every((o) => o.observed === true)
            ? "PASS"
            : "BLOCKED";
        },
      },
    })),
    reviewer_authority_contract: { ...input.reviewer_authority_contract },
    reviewer_receipt_contract: { ...input.reviewer_receipt_contract },
    qualification_record_contract: { ...input.qualification_record_contract },
    gate_record_contract: { ...input.gate_record_contract },
  };
  // Persisted definitions are inspected by the host/generic gate after construction.
  return freezePolicy(definition);
}
