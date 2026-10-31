import { Type, type Static } from "typebox";

import { currentArtifactRef } from "../artifact-store.js";
import { canonicalJson, sha256 } from "../canonical-json.js";
import { ArtifactRefSchema, ContractValidationError, validateContract } from "../contracts.js";
import { OpaqueIdSchema, Sha256Schema, assertOpaqueId } from "../skill-contracts/common.js";
import {
  ScaExternalCapabilityStatusSchema,
  ScaModelPolicyV1Schema,
  ScaProviderCapabilityV1Schema,
  scaModelPolicySha256,
  validateScaModelPolicy,
  type ScaModelPolicyV1,
} from "./model-policy.js";

const MAX_PROJECT_RELATIVE_REF_BYTES = 512;
const MAX_PHASE_ROLE_MAP_BYTES = 64 * 1_024;
const MAX_PROFILE_BYTES = 128 * 1_024;
const MAX_POLICY_BYTES = 64 * 1_024;
const MAX_TARGET_BYTES = 64 * 1_024;

const ZERO_SHA256 = "0".repeat(64);
const SCA_SOURCE_SNAPSHOT_SCHEMA_ID = "penny.sca-source-snapshot.v1";
const SCA_SOURCE_MANIFEST_SCHEMA_ID = "penny.sca-source-manifest.v1";
const SCA_SOURCE_CONTENT_SCHEMA_VERSION = 1;

const MIB = 1_048_576;
const GIB = 1_073_741_824;

const ProjectRelativeRefSchema = Type.String({
  minLength: 1,
  maxLength: MAX_PROJECT_RELATIVE_REF_BYTES,
});

const CatalogAgentSchema = Type.Union([
  Type.Literal("annie"),
  Type.Literal("carren"),
  Type.Literal("demetri"),
  Type.Literal("echo"),
  Type.Literal("ida"),
  Type.Literal("piper"),
  Type.Literal("skribble"),
  Type.Literal("synthia"),
  Type.Literal("tabitha"),
  Type.Literal("vera"),
]);

const ScaPhaseIdSchema = Type.Union([
  Type.Literal("integrate_security_model"),
  Type.Literal("generate_hypotheses"),
  Type.Literal("explore_evidence_gap"),
  Type.Literal("analyze_candidate"),
  Type.Literal("select_next_action"),
  Type.Literal("design_verification"),
  Type.Literal("taskify_verification"),
  Type.Literal("verify_evidence"),
  Type.Literal("critique_finding"),
  Type.Literal("synthesize_security_assessment"),
  Type.Literal("verify_security_assessment"),
  Type.Literal("generate_rule_candidate"),
  Type.Literal("verify_coverage"),
  Type.Literal("materialize_report"),
  Type.Literal("critique_report"),
  Type.Literal("verify_final_product"),
]);

const OptionalChildRouteSchema = Type.Union([
  Type.Null(),
  Type.Object(
    {
      workflow: Type.Union([
        Type.Literal("research"),
        Type.Literal("decide"),
        Type.Literal("plan"),
      ]),
      max_calls: Type.Literal(1),
    },
    { additionalProperties: false }
  ),
]);

const ScaPhaseRoleV1Schema = Type.Object(
  {
    phase_id: ScaPhaseIdSchema,
    agent: CatalogAgentSchema,
    class: Type.Union([Type.Literal("production"), Type.Literal("review")]),
    child_route: OptionalChildRouteSchema,
  },
  { additionalProperties: false }
);

export const ScaPhaseRoleMapV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.sca-phase-role-map.v1"),
    schema_version: Type.Literal(1),
    phases: Type.Array(ScaPhaseRoleV1Schema, { minItems: 16, maxItems: 16 }),
  },
  { additionalProperties: false }
);
export type ScaPhaseRoleMapV1 = Readonly<Static<typeof ScaPhaseRoleMapV1Schema>>;

const SCA_CANONICAL_PHASE_ROLES = Object.freeze([
  {
    phase_id: "integrate_security_model",
    agent: "synthia",
    class: "production",
    child_route: null,
  },
  { phase_id: "generate_hypotheses", agent: "ida", class: "production", child_route: null },
  {
    phase_id: "explore_evidence_gap",
    agent: "echo",
    class: "production",
    child_route: { workflow: "research", max_calls: 1 },
  },
  { phase_id: "analyze_candidate", agent: "annie", class: "production", child_route: null },
  {
    phase_id: "select_next_action",
    agent: "demetri",
    class: "production",
    child_route: { workflow: "decide", max_calls: 1 },
  },
  {
    phase_id: "design_verification",
    agent: "piper",
    class: "production",
    child_route: { workflow: "plan", max_calls: 1 },
  },
  {
    phase_id: "taskify_verification",
    agent: "tabitha",
    class: "production",
    child_route: null,
  },
  { phase_id: "verify_evidence", agent: "vera", class: "review", child_route: null },
  { phase_id: "critique_finding", agent: "carren", class: "review", child_route: null },
  {
    phase_id: "synthesize_security_assessment",
    agent: "synthia",
    class: "production",
    child_route: null,
  },
  {
    phase_id: "verify_security_assessment",
    agent: "vera",
    class: "review",
    child_route: null,
  },
  {
    phase_id: "generate_rule_candidate",
    agent: "skribble",
    class: "production",
    child_route: null,
  },
  { phase_id: "verify_coverage", agent: "vera", class: "review", child_route: null },
  {
    phase_id: "materialize_report",
    agent: "skribble",
    class: "production",
    child_route: null,
  },
  { phase_id: "critique_report", agent: "carren", class: "review", child_route: null },
  { phase_id: "verify_final_product", agent: "vera", class: "review", child_route: null },
] satisfies readonly Static<typeof ScaPhaseRoleV1Schema>[]);

const RootKindSchema = Type.Union([
  Type.Literal("source"),
  Type.Literal("artifact_store"),
  Type.Literal("report_export"),
  Type.Literal("scratch"),
  Type.Literal("image_store"),
  Type.Literal("tool_cache"),
  Type.Literal("state"),
]);

const BoundedRootV1Schema = Type.Object(
  {
    root_kind: RootKindSchema,
    capability_id: OpaqueIdSchema,
    project_relative_ref: ProjectRelativeRefSchema,
  },
  { additionalProperties: false }
);

const ConfigBindingV1Schema = Type.Object(
  {
    ref: ProjectRelativeRefSchema,
    sha256: Sha256Schema,
  },
  { additionalProperties: false }
);

const NonTimeCampaignQuotasV1Schema = Type.Object(
  {
    target_ids: Type.Literal(1),
    immutable_snapshots: Type.Literal(1),
    sequential_child_calls: Type.Integer({ minimum: 0, maximum: 3 }),
    active_children: Type.Literal(1),
    nesting_depth: Type.Literal(1),
    project_child_concurrency: Type.Literal(1),
    model_turns: Type.Integer({ minimum: 1, maximum: 192 }),
    model_input_tokens: Type.Integer({ minimum: 1, maximum: 4_000_000 }),
    model_output_tokens: Type.Integer({ minimum: 1, maximum: 1_000_000 }),
    priced_model_microusd: Type.Integer({ minimum: 0, maximum: 10_000_000 }),
    tool_calls: Type.Integer({ minimum: 1, maximum: 2_048 }),
    external_requests: Type.Integer({ minimum: 0, maximum: 256 }),
    state_steps: Type.Integer({ minimum: 1, maximum: 2_048 }),
    changed_strategy_repairs: Type.Integer({ minimum: 0, maximum: 8 }),
    retained_evidence_bytes: Type.Integer({ minimum: 1, maximum: 2 * GIB }),
    final_output_reserved_bytes: Type.Integer({ minimum: 1, maximum: 128 * MIB }),
  },
  { additionalProperties: false }
);

const SourceQuotasV1Schema = Type.Object(
  {
    roots: Type.Literal(1),
    files: Type.Integer({ minimum: 1, maximum: 100_000 }),
    path_depth: Type.Integer({ minimum: 1, maximum: 64 }),
    total_bytes: Type.Integer({ minimum: 1, maximum: GIB }),
    per_file_bytes: Type.Integer({ minimum: 1, maximum: 16 * MIB }),
    binary_files: Type.Literal(0),
    history_entries: Type.Literal(0),
    archive_expansion_bytes: Type.Literal(0),
  },
  { additionalProperties: false }
);

const StaticJobQuotasV1Schema = Type.Object(
  {
    vcpu: Type.Integer({ minimum: 1, maximum: 4 }),
    memory_bytes: Type.Integer({ minimum: MIB, maximum: 8 * GIB }),
    pids: Type.Integer({ minimum: 1, maximum: 512 }),
    scratch_bytes: Type.Integer({ minimum: MIB, maximum: 16 * GIB }),
    operation_inactivity_ms: Type.Integer({ minimum: 1, maximum: 30 * 60 * 1_000 }),
    log_bytes: Type.Integer({ minimum: 0, maximum: 32 * MIB }),
    result_bytes: Type.Integer({ minimum: 1, maximum: 256 * MIB }),
  },
  { additionalProperties: false }
);

const CpgBuildQuotasV1Schema = Type.Object(
  {
    vcpu: Type.Integer({ minimum: 1, maximum: 8 }),
    memory_bytes: Type.Integer({ minimum: MIB, maximum: 24 * GIB }),
    pids: Type.Integer({ minimum: 1, maximum: 1_024 }),
    scratch_bytes: Type.Integer({ minimum: MIB, maximum: 64 * GIB }),
    operation_inactivity_ms: Type.Integer({ minimum: 1, maximum: 90 * 60 * 1_000 }),
    log_bytes: Type.Integer({ minimum: 0, maximum: 64 * MIB }),
    result_bytes: Type.Integer({ minimum: 1, maximum: GIB }),
  },
  { additionalProperties: false }
);

const CpgQueryQuotasV1Schema = Type.Object(
  {
    vcpu: Type.Integer({ minimum: 1, maximum: 4 }),
    memory_bytes: Type.Integer({ minimum: MIB, maximum: 8 * GIB }),
    pids: Type.Integer({ minimum: 1, maximum: 512 }),
    operation_inactivity_ms: Type.Integer({ minimum: 1, maximum: 5 * 60 * 1_000 }),
    log_bytes: Type.Integer({ minimum: 0, maximum: 16 * MIB }),
    result_bytes: Type.Integer({ minimum: 1, maximum: 64 * MIB }),
    query_artifact_bytes: Type.Integer({ minimum: 1, maximum: 256 * 1_024 }),
    ast_nodes: Type.Integer({ minimum: 1, maximum: 10_000 }),
    traversal_depth: Type.Integer({ minimum: 1, maximum: 16 }),
    rows: Type.Integer({ minimum: 1, maximum: 10_000 }),
    page_size: Type.Integer({ minimum: 1, maximum: 1_000 }),
    pages: Type.Integer({ minimum: 1, maximum: 10 }),
    attempts: Type.Integer({ minimum: 1, maximum: 3 }),
  },
  { additionalProperties: false }
);

const ApplicationVmQuotasV1Schema = Type.Object(
  {
    active_vms: Type.Literal(1),
    concurrent_jobs: Type.Literal(1),
    vcpu: Type.Integer({ minimum: 1, maximum: 8 }),
    memory_bytes: Type.Integer({ minimum: MIB, maximum: 16 * GIB }),
    writable_scratch_bytes: Type.Integer({ minimum: MIB, maximum: 64 * GIB }),
    guest_container_pids: Type.Integer({ minimum: 1, maximum: 1_024 }),
    file_descriptors: Type.Integer({ minimum: 1, maximum: 4_096 }),
    operation_inactivity_ms: Type.Integer({ minimum: 1, maximum: 10 * 60 * 1_000 }),
    cancellation_grace_ms: Type.Integer({ minimum: 0, maximum: 15_000 }),
    cleanup_attempts: Type.Integer({ minimum: 1, maximum: 3 }),
    cleanup_deadline_ms: Type.Integer({ minimum: 1, maximum: 30 * 60 * 1_000 }),
    output_bytes: Type.Integer({ minimum: 0, maximum: 64 * MIB }),
    retained_export_bytes: Type.Integer({ minimum: 0, maximum: GIB }),
    exported_files: Type.Integer({ minimum: 0, maximum: 10_000 }),
    exported_file_bytes: Type.Integer({ minimum: 0, maximum: 64 * MIB }),
    exported_path_depth: Type.Integer({ minimum: 1, maximum: 32 }),
    exact_plan_attempts: Type.Literal(1),
    swap_bytes: Type.Literal(0),
    privileged_containers: Type.Literal(0),
    host_devices: Type.Literal(0),
    host_runtime_sockets: Type.Literal(0),
  },
  { additionalProperties: false }
);

const ExternalCapabilityV1Schema = Type.Object(
  {
    capability_id: OpaqueIdSchema,
    capability_class: Type.Union([
      Type.Literal("model_provider"),
      Type.Literal("vm_runtime"),
      Type.Literal("container_runtime"),
      Type.Literal("static_analysis_runtime"),
      Type.Literal("cpg_runtime"),
      Type.Literal("private_test_network"),
    ]),
    status: ScaExternalCapabilityStatusSchema,
    binding_ref: Type.Null(),
    binding_sha256: Type.Null(),
  },
  { additionalProperties: false }
);

const RetentionPolicyV1Schema = Type.Object(
  {
    canonical_days: Type.Integer({ minimum: 1, maximum: 90 }),
    restricted_raw_days: Type.Integer({ minimum: 1, maximum: 14 }),
    restricted_raw_bytes_per_campaign: Type.Integer({ minimum: 0, maximum: GIB }),
    local_model_content_days: Type.Integer({ minimum: 0, maximum: 30 }),
    content_free_model_metadata_days: Type.Integer({ minimum: 1, maximum: 90 }),
    provider_model_data_days: Type.Integer({ minimum: 0, maximum: 30 }),
    policy_and_qualification_days: Type.Integer({ minimum: 1, maximum: 365 }),
    rule_candidate_days: Type.Integer({ minimum: 1, maximum: 90 }),
    superseded_rule_bundle_days: Type.Integer({ minimum: 1, maximum: 365 }),
    retained_rule_predecessors: Type.Integer({ minimum: 0, maximum: 2 }),
    scratch_max_hours: Type.Integer({ minimum: 1, maximum: 24 }),
    vm_cleanup_deadline_minutes: Type.Integer({ minimum: 1, maximum: 30 }),
    deletion_authority: Type.Literal("operator_approved_retention_controller"),
  },
  { additionalProperties: false }
);

export const ScaProfileV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.sca-profile.v1"),
    schema_version: Type.Literal(1),
    profile_id: OpaqueIdSchema,
    resolution_base_ref: ProjectRelativeRefSchema,
    roots: Type.Array(BoundedRootV1Schema, { minItems: 7, maxItems: 7 }),
    bindings: Type.Object(
      {
        phase_role_map: ConfigBindingV1Schema,
        policy: ConfigBindingV1Schema,
        target: ConfigBindingV1Schema,
      },
      { additionalProperties: false }
    ),
    model_policy: ScaModelPolicyV1Schema,
    model_policy_sha256: Sha256Schema,
    campaign_quotas: NonTimeCampaignQuotasV1Schema,
    source_quotas: SourceQuotasV1Schema,
    jobs: Type.Object(
      {
        per_campaign: Type.Integer({ minimum: 1, maximum: 64 }),
        simultaneously_active: Type.Literal(1),
        static_job: StaticJobQuotasV1Schema,
        cpg_build: CpgBuildQuotasV1Schema,
        cpg_query: CpgQueryQuotasV1Schema,
      },
      { additionalProperties: false }
    ),
    analysis_quotas: Type.Object(
      {
        rule_candidates: Type.Integer({ minimum: 0, maximum: 32 }),
        validation_jobs: Type.Integer({ minimum: 0, maximum: 128 }),
        repair_rounds: Type.Integer({ minimum: 0, maximum: 2 }),
        optional_rescans: Type.Integer({ minimum: 0, maximum: 1 }),
      },
      { additionalProperties: false }
    ),
    application_vm_quotas: ApplicationVmQuotasV1Schema,
    retention: RetentionPolicyV1Schema,
    external_capabilities: Type.Array(ExternalCapabilityV1Schema, {
      minItems: 6,
      maxItems: 6,
    }),
  },
  { additionalProperties: false }
);
export type ScaProfileV1 = Readonly<Static<typeof ScaProfileV1Schema>>;

const DisabledOriginV1Schema = Type.Object(
  {
    status: Type.Literal("disabled"),
    origin: Type.Literal("https://api.osv.dev"),
    redirects: Type.Literal(0),
  },
  { additionalProperties: false }
);

export const ScaPolicyV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.sca-policy.v1"),
    schema_version: Type.Literal(1),
    policy_id: OpaqueIdSchema,
    destination: Type.Object(
      {
        default: Type.Literal("deny"),
        canonical_artifact_store: Type.Literal("allow"),
        deterministic_analysis_runtime: Type.Literal("qualification_required"),
        cloud_model: ScaProviderCapabilityV1Schema,
        osv_api: DisabledOriginV1Schema,
        research_web: Type.Object(
          {
            status: Type.Literal("disabled"),
            allowed_origins: Type.Array(Type.Never(), { maxItems: 0 }),
            max_origins_per_call: Type.Literal(8),
            max_requests_per_call: Type.Literal(32),
          },
          { additionalProperties: false }
        ),
        private_application_network: Type.Object(
          {
            status: Type.Literal("qualification_required"),
            endpoint_bindings: Type.Array(Type.Never(), { maxItems: 0 }),
          },
          { additionalProperties: false }
        ),
        package_registry: Type.Literal("disabled"),
        third_party_sandbox: Type.Literal("disabled"),
        report_publication: Type.Literal("disabled"),
      },
      { additionalProperties: false }
    ),
    network: Type.Object(
      {
        default: Type.Literal("deny"),
        scanner_and_cpg_egress: Type.Literal("deny"),
        public_dns: Type.Literal("deny"),
        lan: Type.Literal("deny"),
        metadata_services: Type.Literal("deny"),
        host_services: Type.Literal("deny"),
        redirects: Type.Literal(0),
        credential_forwarding: Type.Literal("deny"),
      },
      { additionalProperties: false }
    ),
    consequence: Type.Object(
      {
        default: Type.Literal("deny"),
        target_mutation: Type.Literal("deny"),
        host_execution: Type.Literal("deny"),
        host_docker_fallback: Type.Literal("deny"),
        rule_promotion: Type.Literal("deny"),
        report_submission: Type.Literal("deny"),
        migration: Type.Literal("deny"),
        production_registration: Type.Literal("deny"),
      },
      { additionalProperties: false }
    ),
    approval: Type.Object(
      {
        default: Type.Literal("deny"),
        active_approval_refs: Type.Array(Type.Never(), { maxItems: 0 }),
        runtime_capability_bindings: Type.Array(Type.Never(), { maxItems: 0 }),
      },
      { additionalProperties: false }
    ),
  },
  { additionalProperties: false }
);
export type ScaPolicyV1 = Readonly<Static<typeof ScaPolicyV1Schema>>;

export const ScaTargetV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.sca-target.v1"),
    schema_version: Type.Literal(1),
    target_id: OpaqueIdSchema,
    source_visibility: Type.Union([Type.Literal("public"), Type.Literal("public_synthetic")]),
    source_root_ref: ProjectRelativeRefSchema,
    snapshot_ref: ArtifactRefSchema,
    snapshot_sha256: Sha256Schema,
    snapshot_manifest_ref: ArtifactRefSchema,
    snapshot_manifest_sha256: Sha256Schema,
    target_policy_ref: ProjectRelativeRefSchema,
    target_policy_sha256: Sha256Schema,
    target_execution: Type.Literal("disabled"),
    target_network: Type.Literal("disabled"),
    third_party_interaction: Type.Literal("deny"),
    evaluator_oracle_access: Type.Literal("disabled"),
  },
  { additionalProperties: false }
);
export type ScaTargetV1 = Readonly<Static<typeof ScaTargetV1Schema>>;

export interface ScaConfigBundleV1 {
  readonly phaseRoleMap: ScaPhaseRoleMapV1;
  readonly profile: ScaProfileV1;
  readonly policy: ScaPolicyV1;
  readonly target: ScaTargetV1;
}

const REQUIRED_ROOT_KINDS = [
  "artifact_store",
  "image_store",
  "report_export",
  "scratch",
  "source",
  "state",
  "tool_cache",
] as const;

const REQUIRED_EXTERNAL_CAPABILITY_CLASSES = [
  "container_runtime",
  "cpg_runtime",
  "model_provider",
  "private_test_network",
  "static_analysis_runtime",
  "vm_runtime",
] as const;

function fail(label: string, issue: string): never {
  throw new ContractValidationError(label, [issue]);
}

function assertNonZeroSha256(value: string, label: string): void {
  if (value === ZERO_SHA256) fail(label, "SHA-256 digest must not be the all-zero placeholder");
}

function assertCanonicalBytes(value: unknown, label: string, maximum: number): void {
  if (Buffer.byteLength(canonicalJson(value), "utf8") > maximum) {
    fail(label, `canonical value exceeds ${maximum} UTF-8 bytes`);
  }
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) fail(label, "values must be unique");
}

function assertExactOrderedValues(
  actual: readonly string[],
  expected: readonly string[],
  label: string
): void {
  if (
    actual.length !== expected.length ||
    actual.some((value, index) => value !== expected[index])
  ) {
    fail(label, "values must equal the canonical ordered set");
  }
}

function hasDisallowedRefControl(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return (
      codePoint !== undefined &&
      ((codePoint >= 0 && codePoint <= 0x1f) || (codePoint >= 0x7f && codePoint <= 0x9f))
    );
  });
}

function assertSafeProjectRelativeRef(value: string, label: string): void {
  if (
    value !== value.normalize("NFC") ||
    Buffer.byteLength(value, "utf8") > MAX_PROJECT_RELATIVE_REF_BYTES ||
    value.startsWith("/") ||
    value.startsWith("\\") ||
    /^[A-Za-z]:/u.test(value) ||
    value.includes("\\") ||
    value.includes("%") ||
    hasDisallowedRefControl(value)
  ) {
    fail(label, "ref must be a bounded canonical project-relative path");
  }
  const segments = value.split("/");
  if (
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(segment)
    )
  ) {
    fail(label, "ref contains an unsafe or non-canonical path segment");
  }
}

function rootByKind(profile: ScaProfileV1, kind: Static<typeof RootKindSchema>): string {
  const root = profile.roots.find((candidate) => candidate.root_kind === kind);
  if (root === undefined) fail("SCA profile", `required ${kind} root is absent`);
  return root.project_relative_ref;
}

function modelProviderCapability(
  profile: ScaProfileV1
): ScaProfileV1["external_capabilities"][number] {
  const capability = profile.external_capabilities.find(
    (candidate) => candidate.capability_class === "model_provider"
  );
  if (capability === undefined) fail("SCA profile", "required model_provider capability is absent");
  return capability;
}

function assertProfileRoots(profile: ScaProfileV1): void {
  assertSafeProjectRelativeRef(profile.resolution_base_ref, "SCA profile resolution_base_ref");
  assertUnique(
    profile.roots.map((root) => root.root_kind),
    "SCA profile root kinds"
  );
  assertUnique(
    profile.roots.map((root) => root.capability_id),
    "SCA profile root capability IDs"
  );
  assertUnique(
    profile.roots.map((root) => root.project_relative_ref),
    "SCA profile root refs"
  );
  assertExactOrderedValues(
    [...profile.roots.map((root) => root.root_kind)].sort(),
    REQUIRED_ROOT_KINDS,
    "SCA profile root kinds"
  );
  for (const root of profile.roots) {
    assertOpaqueId(root.capability_id, `SCA ${root.root_kind} root capability_id`);
    assertSafeProjectRelativeRef(root.project_relative_ref, `SCA ${root.root_kind} root`);
    if (!root.project_relative_ref.startsWith(`${profile.resolution_base_ref}/`)) {
      fail("SCA profile", `${root.root_kind} root escapes the declared resolution base`);
    }
  }
  for (const [index, left] of profile.roots.entries()) {
    for (const right of profile.roots.slice(index + 1)) {
      if (
        left.project_relative_ref.startsWith(`${right.project_relative_ref}/`) ||
        right.project_relative_ref.startsWith(`${left.project_relative_ref}/`)
      ) {
        fail("SCA profile", "bounded roots must not overlap");
      }
    }
  }
}

export function validateScaPhaseRoleMap(value: unknown): ScaPhaseRoleMapV1 {
  const roleMap = validateContract(ScaPhaseRoleMapV1Schema, value, "SCA phase-role map");
  assertUnique(
    roleMap.phases.map((phase) => phase.phase_id),
    "SCA phase-role map phase IDs"
  );
  for (const [index, expected] of SCA_CANONICAL_PHASE_ROLES.entries()) {
    const actual = roleMap.phases[index];
    if (actual === undefined || canonicalJson(actual) !== canonicalJson(expected)) {
      fail("SCA phase-role map", `phase ${index + 1} must equal '${expected.phase_id}'`);
    }
  }
  assertCanonicalBytes(roleMap, "SCA phase-role map", MAX_PHASE_ROLE_MAP_BYTES);
  return roleMap;
}

export function validateScaProfile(value: unknown): ScaProfileV1 {
  const parsed = validateContract(ScaProfileV1Schema, value, "SCA profile");
  assertOpaqueId(parsed.profile_id, "SCA profile profile_id");
  assertProfileRoots(parsed);
  for (const [name, binding] of Object.entries(parsed.bindings)) {
    assertSafeProjectRelativeRef(binding.ref, `SCA profile ${name} binding ref`);
    assertNonZeroSha256(binding.sha256, `SCA profile ${name} binding`);
  }
  const modelPolicy = validateScaModelPolicy(parsed.model_policy);
  assertNonZeroSha256(parsed.model_policy_sha256, "SCA profile model_policy_sha256");
  if (parsed.model_policy_sha256 !== scaModelPolicySha256(modelPolicy)) {
    fail("SCA profile", "model_policy_sha256 does not bind the accepted model policy");
  }
  assertUnique(
    parsed.external_capabilities.map((capability) => capability.capability_id),
    "SCA external capability IDs"
  );
  assertUnique(
    parsed.external_capabilities.map((capability) => capability.capability_class),
    "SCA external capability classes"
  );
  assertExactOrderedValues(
    [...parsed.external_capabilities.map((capability) => capability.capability_class)].sort(),
    REQUIRED_EXTERNAL_CAPABILITY_CLASSES,
    "SCA external capability classes"
  );
  for (const capability of parsed.external_capabilities) {
    assertOpaqueId(capability.capability_id, "SCA external capability_id");
  }
  const normalized: ScaProfileV1 = {
    ...parsed,
    roots: [...parsed.roots].sort((left, right) => left.root_kind.localeCompare(right.root_kind)),
    external_capabilities: [...parsed.external_capabilities].sort((left, right) =>
      left.capability_class.localeCompare(right.capability_class)
    ),
  };
  const profileModelProvider = modelProviderCapability(normalized);
  if (
    profileModelProvider.capability_id !== modelPolicy.provider_capability.capability_id ||
    profileModelProvider.status !== modelPolicy.provider_capability.status
  ) {
    fail("SCA profile", "model_provider capability ID/status must match the embedded model policy");
  }
  assertCanonicalBytes(normalized, "SCA profile", MAX_PROFILE_BYTES);
  return normalized;
}

export function validateScaPolicy(value: unknown): ScaPolicyV1 {
  const policy = validateContract(ScaPolicyV1Schema, value, "SCA policy");
  assertOpaqueId(policy.policy_id, "SCA policy policy_id");
  assertOpaqueId(
    policy.destination.cloud_model.capability_id,
    "SCA policy cloud model capability_id"
  );
  assertCanonicalBytes(policy, "SCA policy", MAX_POLICY_BYTES);
  return policy;
}

function assertTargetArtifactBinding(
  value: ScaTargetV1["snapshot_ref"],
  digest: string,
  expectedKind: "source-snapshot" | "source-snapshot-manifest",
  expectedSchemaId: typeof SCA_SOURCE_SNAPSHOT_SCHEMA_ID | typeof SCA_SOURCE_MANIFEST_SCHEMA_ID,
  label: string
): void {
  let ref: ReturnType<typeof currentArtifactRef>;
  try {
    ref = currentArtifactRef(value, `SCA target ${label}`);
  } catch (error) {
    fail("SCA target", error instanceof Error ? error.message : `${label} ref is not canonical`);
  }
  assertNonZeroSha256(ref.content_digest, `${label} content_digest`);
  assertNonZeroSha256(digest, `${label} digest`);
  if (ref.kind !== expectedKind || ref.content_digest !== digest) {
    fail("SCA target", `${label} ref and digest must bind one ${expectedKind} artifact`);
  }
  const contentSchema = ref.content_schema;
  if (
    contentSchema === undefined ||
    contentSchema.schema_id !== expectedSchemaId ||
    contentSchema.schema_version !== SCA_SOURCE_CONTENT_SCHEMA_VERSION
  ) {
    fail(
      "SCA target",
      `${label} content_schema must equal ${expectedSchemaId} v${SCA_SOURCE_CONTENT_SCHEMA_VERSION}`
    );
  }
}

export function validateScaTarget(value: unknown): ScaTargetV1 {
  const target = validateContract(ScaTargetV1Schema, value, "SCA target");
  assertOpaqueId(target.target_id, "SCA target target_id");
  assertSafeProjectRelativeRef(target.source_root_ref, "SCA target source_root_ref");
  assertSafeProjectRelativeRef(target.target_policy_ref, "SCA target target_policy_ref");
  assertTargetArtifactBinding(
    target.snapshot_ref,
    target.snapshot_sha256,
    "source-snapshot",
    SCA_SOURCE_SNAPSHOT_SCHEMA_ID,
    "snapshot"
  );
  assertTargetArtifactBinding(
    target.snapshot_manifest_ref,
    target.snapshot_manifest_sha256,
    "source-snapshot-manifest",
    SCA_SOURCE_MANIFEST_SCHEMA_ID,
    "snapshot manifest"
  );
  assertNonZeroSha256(target.target_policy_sha256, "SCA target target_policy_sha256");
  assertCanonicalBytes(target, "SCA target", MAX_TARGET_BYTES);
  return target;
}

/** Canonical semantic digest helpers hash only values that pass the complete boundary validator. */
export function scaPhaseRoleMapSha256(value: unknown): string {
  return sha256(canonicalJson(validateScaPhaseRoleMap(value)));
}

export function scaProfileSha256(value: unknown): string {
  return sha256(canonicalJson(validateScaProfile(value)));
}

export function scaPolicySha256(value: unknown): string {
  return sha256(canonicalJson(validateScaPolicy(value)));
}

export function scaTargetSha256(value: unknown): string {
  return sha256(canonicalJson(validateScaTarget(value)));
}

export function validateScaConfigBundle(input: {
  readonly phaseRoleMap: unknown;
  readonly profile: unknown;
  readonly policy: unknown;
  readonly target: unknown;
}): ScaConfigBundleV1 {
  const phaseRoleMap = validateScaPhaseRoleMap(input.phaseRoleMap);
  const profile = validateScaProfile(input.profile);
  const policy = validateScaPolicy(input.policy);
  const target = validateScaTarget(input.target);
  if (profile.bindings.phase_role_map.sha256 !== scaPhaseRoleMapSha256(phaseRoleMap)) {
    fail("SCA config bundle", "phase_role_map binding digest does not match its accepted value");
  }
  if (profile.bindings.policy.sha256 !== scaPolicySha256(policy)) {
    fail("SCA config bundle", "policy binding digest does not match its accepted value");
  }
  if (profile.bindings.target.sha256 !== scaTargetSha256(target)) {
    fail("SCA config bundle", "target binding digest does not match its accepted value");
  }
  if (target.source_root_ref !== rootByKind(profile, "source")) {
    fail("SCA config bundle", "target source root does not match the bounded profile source root");
  }
  const profileModelProvider = modelProviderCapability(profile);
  if (
    profileModelProvider.capability_id !== policy.destination.cloud_model.capability_id ||
    profileModelProvider.status !== policy.destination.cloud_model.status
  ) {
    fail(
      "SCA config bundle",
      "model_provider capability ID/status must match the default-deny policy"
    );
  }
  return { phaseRoleMap, profile, policy, target };
}

export type { ScaModelPolicyV1 };
