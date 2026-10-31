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

export const SCA_P02_QUALIFICATION_PHASE = "SCA-P02" as const;
export const SCA_P02_IMPLEMENTATION_IDENTITY_V1_SCHEMA =
  "penny.sca-p02-implementation-identity.v1" as const;
export const SCA_P02_QUALIFICATION_EVIDENCE_V1_SCHEMA =
  "penny.sca-p02-qualification-evidence.v1" as const;

// Freeze owned policy recursively; caller-owned inputs are copied before freezing below.
function freezePolicy<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezePolicy(child);
    Object.freeze(value);
  }
  return value;
}

/** Each entry is mandatory, live, host-bound, and has exactly one evidence artifact. */
export const SCA_P02_QUALIFICATION_CHECKS = freezePolicy({
  "p02-current-predecessor-and-implementation": [
    "current-host-binding",
    "current-p01-predecessor",
    "exact-implementation-source-manifest",
  ],
  "p02-six-operation-deterministic-coverage": [
    "deterministic-analyzer-coverage",
    "exact-operation-provenance",
    "inventory-and-six-operations",
  ],
  "p02-containment-egress-and-minimization": [
    "host-isolation-and-process-containment",
    "osv-egress-and-freshness",
    "source-custody-and-evidence-minimization",
  ],
  "p02-required-variants-and-lifecycle": [
    "blocked-and-recovery-lifecycle",
    "nonterminal-p03-boundary",
    "required-live-variants",
  ],
} as const);
export type ScaP02QualificationCriterionId = keyof typeof SCA_P02_QUALIFICATION_CHECKS;
export const SCA_P02_QUALIFICATION_CRITERION_IDS = freezePolicy([
  "p02-containment-egress-and-minimization",
  "p02-current-predecessor-and-implementation",
  "p02-required-variants-and-lifecycle",
  "p02-six-operation-deterministic-coverage",
] as const satisfies readonly ScaP02QualificationCriterionId[]);

/** Snapshot selection is fixed; the caller must measure these exact repository files. */
export const SCA_P02_IMPLEMENTATION_SOURCE_PATHS = freezePolicy([
  "apps/orchestration/src/artifact-store.ts",
  "apps/orchestration/src/checkpointer.ts",
  "apps/orchestration/src/host-operations/contracts.ts",
  "apps/orchestration/src/host-operations/lease-authority.ts",
  "apps/orchestration/src/host-operations/owner.ts",
  "apps/orchestration/src/host-operations/result-cache.ts",
  "apps/orchestration/src/playbooks/registry.ts",
  "apps/orchestration/src/playbooks/runtime-registration-digest.ts",
  "apps/orchestration/src/sca/activation-host-key.ts",
  "apps/orchestration/src/sca/activation-owner.ts",
  "apps/orchestration/src/sca/p01-contracts.ts",
  "apps/orchestration/src/sca/p01-source-variants.ts",
  "apps/orchestration/src/sca/p02-activation-host.ts",
  "apps/orchestration/src/sca/p02-admission.ts",
  "apps/orchestration/src/sca/p02-contracts.ts",
  "apps/orchestration/src/sca/p02-playbook.ts",
  "apps/orchestration/src/sca/p02-qualification.ts",
  "apps/orchestration/src/sca/p03-p02-qualification-guard.ts",
  "apps/orchestration/src/sca/phase-activation.ts",
  "apps/orchestration/src/sca/phase-registry.ts",
  "apps/orchestration/src/sca/qualification-activation-contracts.ts",
  "apps/orchestration/src/sca/qualification-activation.ts",
  "apps/orchestration/src/sca/qualification-gate-contracts.ts",
  "apps/orchestration/src/sca/qualification-gate.ts",
  "apps/orchestration/src/service.ts",
  "apps/orchestration/src/state/catalog.ts",
  "apps/orchestration/src/state/paths.ts",
  "apps/orchestration/tests/host-operation-crash-recovery.test.ts",
  "apps/orchestration/tests/host-operation-result-cache.test.ts",
  "apps/orchestration/tests/sca-p02-candidate.test.ts",
  "apps/orchestration/tests/sca-p02-host-sequence.test.ts",
  "apps/orchestration/tests/sca-p02-qualification.test.ts",
  "apps/orchestration/tests/sca-qualification-activation.test.ts",
  "apps/sca-service/package.json",
  "apps/sca-service/src/adapters/dependency-inventory-v2.ts",
  "apps/sca-service/src/adapters/gitleaks.ts",
  "apps/sca-service/src/adapters/osv-v2-fixed-ip.ts",
  "apps/sca-service/src/adapters/osv-v2.ts",
  "apps/sca-service/src/adapters/osv.ts",
  "apps/sca-service/src/adapters/semgrep.ts",
  "apps/sca-service/src/adapters/tree-sitter-index.ts",
  "apps/sca-service/src/config.ts",
  "apps/sca-service/src/contracts.ts",
  "apps/sca-service/src/index.ts",
  "apps/sca-service/src/jobs.ts",
  "apps/sca-service/src/p02-component-authority.ts",
  "apps/sca-service/src/p02-component-inputs.ts",
  "apps/sca-service/src/p02-host-harness.ts",
  "apps/sca-service/src/p02-host-inventory-runner.ts",
  "apps/sca-service/src/p02-host-process-runner.ts",
  "apps/sca-service/src/p02-host-tree.ts",
  "apps/sca-service/src/p02-host-worker.mjs",
  "apps/sca-service/src/p02-inventory-worker.ts",
  "apps/sca-service/src/p02-operations.ts",
  "apps/sca-service/src/p02-osv-host.ts",
  "apps/sca-service/src/p02-osv-pin.ts",
  "apps/sca-service/src/p02-osv-worker.mjs",
  "apps/sca-service/src/p02-production-runtime.ts",
  "apps/sca-service/src/p02-scratch-launcher.d.mts",
  "apps/sca-service/src/p02-scratch-launcher.mjs",
  "apps/sca-service/src/process.ts",
  "apps/sca-service/src/router.ts",
  "apps/sca-service/src/source-custody-materializer.ts",
  "apps/sca-service/tests/p02-host-factory.test.ts",
  "apps/sca-service/tests/p02-host-harness.test.ts",
  "apps/sca-service/tests/p02-inventory-operation.test.ts",
  "apps/sca-service/tests/p02-operation-failclosed.test.ts",
  "apps/sca-service/tests/p02-operations.test.ts",
  "apps/sca-service/tests/p02-osv-evidence.test.ts",
  "apps/sca-service/tests/p02-osv-host.test.ts",
  "apps/sca-service/tests/p02-production-runtime.test.ts",
  "apps/sca-service/tests/p02-scratch-launcher.test.ts",
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
export type ScaP02ImplementationSourceFileV1 = Readonly<Static<typeof SourceFileSchema>>;
const Claims = {
  tenant_id: OpaqueIdSchema,
  project_id: OpaqueIdSchema,
  run_id: OpaqueIdSchema,
  phase_id: Type.Literal(SCA_P02_QUALIFICATION_PHASE),
  implementation_revision: OpaqueIdSchema,
  assurance_scope: Type.Literal("host_derived_binding"),
  host_binding_sha256: Sha256Schema,
  implementer_identity_id: OpaqueIdSchema,
  implementer_lineage_id: OpaqueIdSchema,
} as const;

export const ScaP02ImplementationIdentityV1Schema = freezePolicy(
  Type.Object(
    {
      schema_id: Type.Literal(SCA_P02_IMPLEMENTATION_IDENTITY_V1_SCHEMA),
      schema_version: Type.Literal(1),
      ...Claims,
      source_files: Type.Array(SourceFileSchema, { minItems: 1, maxItems: 128 }),
      source_manifest_sha256: Sha256Schema,
    },
    { additionalProperties: false, $id: SCA_P02_IMPLEMENTATION_IDENTITY_V1_SCHEMA }
  )
);
export type ScaP02ImplementationIdentityV1 = Readonly<
  Static<typeof ScaP02ImplementationIdentityV1Schema>
> &
  ScaImplementationIdentityClaimsV1;

const ObservationSchema = freezePolicy(
  Type.Object(
    { check_id: OpaqueIdSchema, observed: Type.Boolean() },
    { additionalProperties: false }
  )
);
export const ScaP02QualificationEvidenceV1Schema = freezePolicy(
  Type.Object(
    {
      schema_id: Type.Literal(SCA_P02_QUALIFICATION_EVIDENCE_V1_SCHEMA),
      schema_version: Type.Literal(1),
      ...Claims,
      criterion_id: Type.Union([
        Type.Literal("p02-current-predecessor-and-implementation"),
        Type.Literal("p02-six-operation-deterministic-coverage"),
        Type.Literal("p02-containment-egress-and-minimization"),
        Type.Literal("p02-required-variants-and-lifecycle"),
      ]),
      subject_sha256: Sha256Schema,
      observations: Type.Array(ObservationSchema, { minItems: 1, maxItems: 32 }),
      supporting_refs: Type.Array(ArtifactRefSchema, { minItems: 1, maxItems: 1024 }),
    },
    { additionalProperties: false, $id: SCA_P02_QUALIFICATION_EVIDENCE_V1_SCHEMA }
  )
);
export type ScaP02QualificationEvidenceV1 = Readonly<
  Static<typeof ScaP02QualificationEvidenceV1Schema>
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
function sourceFiles(value: unknown): readonly ScaP02ImplementationSourceFileV1[] {
  const files = validateContract(
    Type.Array(SourceFileSchema, { minItems: 1, maxItems: 128 }),
    value,
    "P02 implementation source files"
  );
  orderedUnique(
    files.map((file) => file.path),
    "P02 source paths"
  );
  for (const file of files) {
    if (
      file.path.startsWith("/") ||
      file.path.includes("\\") ||
      file.path.split("/").some((part) => part === "" || part === "." || part === "..") ||
      /^[A-Za-z]:/u.test(file.path)
    ) {
      throw new Error("P02 source path must be repository-relative and canonical");
    }
  }
  if (
    canonicalJson(files.map((file) => file.path)) !==
    canonicalJson(SCA_P02_IMPLEMENTATION_SOURCE_PATHS)
  ) {
    throw new Error("P02 source manifest must cover the fixed implementation path set");
  }
  return files;
}
/** Pure manifest digest; measurement and current-host comparison belong to the host. */
export function scaP02SourceManifestSha256(
  files: readonly ScaP02ImplementationSourceFileV1[]
): string {
  return sha256(canonicalJson(sourceFiles(files)));
}

export function validateScaP02ImplementationIdentityV1(
  value: unknown
): ScaP02ImplementationIdentityV1 {
  const identity = validateContract(
    ScaP02ImplementationIdentityV1Schema,
    value,
    "P02 implementation identity"
  );
  if (
    identity.implementer_identity_id === identity.implementer_lineage_id ||
    identity.source_manifest_sha256 !== scaP02SourceManifestSha256(identity.source_files)
  ) {
    throw new Error("P02 implementation identity or source manifest is invalid");
  }
  return identity;
}
export function validateScaP02QualificationEvidenceV1(
  value: unknown
): ScaP02QualificationEvidenceV1 {
  const evidence = validateContract(
    ScaP02QualificationEvidenceV1Schema,
    value,
    "P02 qualification evidence"
  );
  const actual = evidence.observations.map((o) => o.check_id);
  orderedUnique(actual, "P02 checks");
  if (
    canonicalJson(actual) !== canonicalJson(SCA_P02_QUALIFICATION_CHECKS[evidence.criterion_id]) ||
    evidence.observations.some((o) => o.observed !== true)
  ) {
    throw new Error("P02 live evidence requires every known check to be true");
  }
  exactRefs(evidence.supporting_refs, "P02 supporting refs");
  return evidence;
}

/** No I/O or issuance: callers supply measurements and subject-bound observations. */
export function buildScaP02ImplementationIdentityV1(
  input: Omit<
    ScaP02ImplementationIdentityV1,
    "schema_id" | "schema_version" | "phase_id" | "assurance_scope" | "source_manifest_sha256"
  >
): ScaP02ImplementationIdentityV1 {
  return validateScaP02ImplementationIdentityV1({
    ...input,
    schema_id: SCA_P02_IMPLEMENTATION_IDENTITY_V1_SCHEMA,
    schema_version: 1,
    phase_id: SCA_P02_QUALIFICATION_PHASE,
    assurance_scope: "host_derived_binding",
    source_manifest_sha256: scaP02SourceManifestSha256(input.source_files),
  });
}
export function buildScaP02CriterionDefinitionV1(input: {
  readonly tenant_id: string;
  readonly project_id: string;
  readonly run_id: string;
  readonly implementation_revision: string;
  readonly criterion_id: ScaP02QualificationCriterionId;
}): ScaPhaseCriterionDefinitionV1 {
  if (!Object.hasOwn(SCA_P02_QUALIFICATION_CHECKS, input.criterion_id))
    throw new Error("Unknown P02 criterion");
  return sealScaPhaseCriterionDefinitionV1({
    schema_id: SCA_PHASE_CRITERION_DEFINITION_V1_SCHEMA,
    schema_version: 1,
    ...input,
    phase_id: SCA_P02_QUALIFICATION_PHASE,
    required_assurance_scope: "host_derived_binding",
    required_evidence_class: "live",
    required_evidence_count: 1,
  });
}
export function buildScaP02QualificationEvidenceV1(
  input: Omit<
    ScaP02QualificationEvidenceV1,
    "schema_id" | "schema_version" | "phase_id" | "assurance_scope"
  >
): ScaP02QualificationEvidenceV1 {
  return validateScaP02QualificationEvidenceV1({
    ...input,
    schema_id: SCA_P02_QUALIFICATION_EVIDENCE_V1_SCHEMA,
    schema_version: 1,
    phase_id: SCA_P02_QUALIFICATION_PHASE,
    assurance_scope: "host_derived_binding",
  });
}

export const SCA_P02_QUALIFICATION_ARTIFACTS = freezePolicy({
  identity: {
    artifact_kind: "sca-p02-implementation-identity",
    schema_id: SCA_P02_IMPLEMENTATION_IDENTITY_V1_SCHEMA,
    schema_version: 1,
    producer: "host:sca-p02-qualification",
  },
  definition: {
    artifact_kind: "sca-p02-criterion-definition",
    schema_id: SCA_PHASE_CRITERION_DEFINITION_V1_SCHEMA,
    schema_version: 1,
    producer: "host:sca-p02-qualification",
  },
  evidence: {
    artifact_kind: "sca-p02-qualification-evidence",
    schema_id: SCA_P02_QUALIFICATION_EVIDENCE_V1_SCHEMA,
    schema_version: 1,
    producer: "host:sca-p02-live-evidence",
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

export interface ScaP02QualificationDefinitionInputV1 {
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
  readonly criterion_definition_refs: Readonly<Record<ScaP02QualificationCriterionId, ArtifactRef>>;
  readonly reviewer_authority_contract: ScaArtifactContractV1;
  readonly reviewer_receipt_contract: ScaArtifactContractV1;
  readonly qualification_record_contract: ScaArtifactContractV1;
  readonly gate_record_contract: ScaArtifactContractV1;
  readonly max_json_artifact_bytes: number;
}

/** In-process qualification policy, not a registry entry or an activation authority. */
export function createScaP02QualificationDefinitionV1(
  input: ScaP02QualificationDefinitionInputV1
): ScaPhaseQualificationDefinitionV1 {
  if (
    !Number.isSafeInteger(input.max_json_artifact_bytes) ||
    input.max_json_artifact_bytes < 1 ||
    input.max_json_artifact_bytes > 16 * 1_048_576
  ) {
    throw new Error("P02 JSON byte limit is invalid");
  }
  const contract = (part: keyof typeof SCA_P02_QUALIFICATION_ARTIFACTS): ScaArtifactContractV1 => ({
    ...SCA_P02_QUALIFICATION_ARTIFACTS[part],
    media_type: "application/json",
    max_bytes: input.max_json_artifact_bytes,
  });
  const currentSourceManifestSha256 = validateContract(
    Sha256Schema,
    input.current_source_manifest_sha256,
    "current P02 source manifest SHA-256"
  );
  const qualifiedRefs = freezePolicy(
    input.qualified_inputs
      .map((binding) => copyRef(binding.ref))
      .sort((a, b) => compare(a.artifact_id, b.artifact_id))
  );
  exactRefs(qualifiedRefs, "P02 qualified inputs");
  if (qualifiedRefs.length === 0) throw new Error("P02 requires qualified inputs");
  const definition: ScaPhaseQualificationDefinitionV1 = {
    schema_version: 1,
    tenant_id: input.tenant_id,
    project_id: input.project_id,
    run_id: input.run_id,
    phase_id: SCA_P02_QUALIFICATION_PHASE,
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
        const identity = validateScaP02ImplementationIdentityV1(value);
        if (identity.source_manifest_sha256 !== currentSourceManifestSha256) {
          throw new Error("P02 source manifest is stale relative to the host measurement");
        }
        return identity;
      },
    },
    qualified_inputs: input.qualified_inputs.map(copyBinding),
    criteria: SCA_P02_QUALIFICATION_CRITERION_IDS.map((criterion_id) => ({
      criterion_id,
      definition_ref: copyRef(input.criterion_definition_refs[criterion_id]),
      definition_contract: contract("definition"),
      evidence_contract: {
        ...contract("evidence"),
        evidence_class: "live",
        validate: (value: unknown) => {
          const evidence = validateScaP02QualificationEvidenceV1(value);
          if (
            evidence.criterion_id !== criterion_id ||
            canonicalJson(evidence.supporting_refs) !== canonicalJson(qualifiedRefs)
          ) {
            throw new Error("P02 evidence criterion or exact qualified supporting refs mismatch");
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
            claims[0]?.observations.length === SCA_P02_QUALIFICATION_CHECKS[criterion_id].length &&
            canonicalJson(claims[0].observations.map((o) => o.check_id)) ===
              canonicalJson(SCA_P02_QUALIFICATION_CHECKS[criterion_id]) &&
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
