/** Closed wire mirrors of the separately built native adapters. Schema-parity tests guard drift. */
import { Type, type Static } from "typebox";
import { ArtifactRefSchema } from "../contracts.js";
import { Sha256Schema } from "../skill-contracts/common.js";
import { ScaPointerSchema, ScaToolPathSchema } from "./ordinary-contracts.js";
export const ScaExecutionSchema = Type.Union([
  Type.Literal("RUN"),
  Type.Literal("NOT RUN"),
  Type.Literal("UNKNOWN"),
]);
const CONTROL_BYTES = 1048576;
const Hex = Type.String({ pattern: "^[a-f0-9]{64}$" });
const Id = Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$" });
const Relative = Type.String({ minLength: 1, maxLength: 1024, pattern: "^[A-Za-z0-9._@+/-]+$" });
const Interpreter = Type.Union([
  Type.Literal("php"),
  Type.Literal("node"),
  Type.Literal("node_typescript"),
]);
const Resources = Type.Object(
  {
    vm_timeout_seconds: Type.Integer({ minimum: 1, maximum: 1200 }),
    test_timeout_ms: Type.Integer({ minimum: 100, maximum: 60_000 }),
    cpu_seconds: Type.Integer({ minimum: 1, maximum: 60 }),
    memory_bytes: Type.Integer({ minimum: 16_777_216, maximum: 1_610_612_736 }),
    processes: Type.Integer({ minimum: 1, maximum: 32 }),
    file_bytes: Type.Integer({ minimum: 1024, maximum: 8_388_608 }),
    output_bytes: Type.Integer({ minimum: 1, maximum: 65_536 }),
  },
  { additionalProperties: false }
);
export const OrdinaryApplicationTestPlanSchema = Type.Object(
  {
    schema_id: Type.Literal("penny.sca-ordinary-application-plan.v1"),
    schema_version: Type.Literal(1),
    source_snapshot_sha256: Hex,
    source_corpus_ref: ArtifactRefSchema,
    interpreter: Interpreter,
    source_files: Type.Array(
      Type.Object({ path: Relative, content_sha256: Hex }, { additionalProperties: false }),
      { minItems: 1, maxItems: 128 }
    ),
    harness_ref: ArtifactRefSchema,
    test_inputs: Type.Array(
      Type.Object({ path: Relative, ref: ArtifactRefSchema }, { additionalProperties: false }),
      { maxItems: 8 }
    ),
    stdin_ref: Type.Union([ArtifactRefSchema, Type.Null()]),
    expected_exit_code: Type.Integer({ minimum: 0, maximum: 255 }),
    resources: Resources,
  },
  { additionalProperties: false }
);
export const OrdinaryApplicationTestPolicySchema = Type.Object(
  {
    schema_id: Type.Literal("penny.sca-ordinary-application-policy.v1"),
    schema_version: Type.Literal(1),
    project_id: Id,
    run_id: Id,
    isolation: Type.Literal("vm"),
    network: Type.Literal("none"),
    credentials: Type.Literal("none"),
    profile: Type.Literal("qemu-kvm-nicless-v1"),
    allowed_plan_sha256: Type.Array(Hex, { minItems: 1, maxItems: 64, uniqueItems: true }),
    maxima: Resources,
  },
  { additionalProperties: false }
);
export const ORDINARY_APPLICATION_CONTAINER_PROFILE = "docker-local-no-network-v1";
/** V2 removes VM-specific resource terminology for the explicitly temporary CONTAINER profile.
 * Legacy V1 QEMU/KVM plans/policies remain unchanged. There is no silent fallback.
 */
const ContainerResources = Type.Object(
  {
    ...Resources.properties,
    operation_timeout_seconds: Resources.properties.vm_timeout_seconds,
  },
  { additionalProperties: false }
);
// Omit the legacy VM-only member rather than admitting both spellings.
const { vm_timeout_seconds: _legacyVmTimeout, ...containerResourceProperties } =
  ContainerResources.properties;
export const OrdinaryApplicationContainerResourcesSchema = Type.Object(
  containerResourceProperties,
  { additionalProperties: false }
);
export const OrdinaryApplicationContainerPlanSchema = Type.Object(
  {
    ...OrdinaryApplicationTestPlanSchema.properties,
    schema_id: Type.Literal("penny.sca-ordinary-application-plan.v2"),
    schema_version: Type.Literal(2),
    resources: OrdinaryApplicationContainerResourcesSchema,
  },
  { additionalProperties: false }
);
export const OrdinaryApplicationContainerPolicySchema = Type.Object(
  {
    ...OrdinaryApplicationTestPolicySchema.properties,
    schema_id: Type.Literal("penny.sca-ordinary-application-policy.v2"),
    schema_version: Type.Literal(2),
    isolation: Type.Literal("container"),
    profile: Type.Literal(ORDINARY_APPLICATION_CONTAINER_PROFILE),
    maxima: OrdinaryApplicationContainerResourcesSchema,
  },
  { additionalProperties: false }
);
export const OrdinaryApplicationExecutionPlanSchema = Type.Union([
  OrdinaryApplicationTestPlanSchema,
  OrdinaryApplicationContainerPlanSchema,
]);
export const OrdinaryApplicationExecutionPolicySchema = Type.Union([
  OrdinaryApplicationTestPolicySchema,
  OrdinaryApplicationContainerPolicySchema,
]);
export type OrdinaryApplicationContainerPlan = Static<
  typeof OrdinaryApplicationContainerPlanSchema
>;
export type OrdinaryApplicationContainerPolicy = Static<
  typeof OrdinaryApplicationContainerPolicySchema
>;
export type OrdinaryApplicationExecutionPlan = Static<
  typeof OrdinaryApplicationExecutionPlanSchema
>;
export type OrdinaryApplicationExecutionPolicy = Static<
  typeof OrdinaryApplicationExecutionPolicySchema
>;
export const OrdinaryApplicationTestRequestSchema = Type.Object(
  {
    schema_id: Type.Literal("penny.sca-ordinary-application-request.v1"),
    schema_version: Type.Literal(1),
    project_id: Id,
    run_id: Id,
    action_id: Id,
    source_snapshot_sha256: Hex,
    execution_plan_ref: ArtifactRefSchema,
    policy_ref: ArtifactRefSchema,
  },
  { additionalProperties: false }
);
export const OrdinaryApplicationTestAuthoritySchema = Type.Object(
  {
    project_id: Id,
    admitted_policy_refs: Type.Array(ArtifactRefSchema, { minItems: 1, maxItems: 64 }),
  },
  { additionalProperties: false }
);
export const OrdinaryApplicationTestResultSchema = Type.Object(
  {
    schema_id: Type.Literal("penny.sca-ordinary-application-result.v1"),
    schema_version: Type.Literal(1),
    request_sha256: Hex,
    source_snapshot_sha256: Hex,
    isolation: Type.Optional(
      Type.Union([Type.Literal("VM"), Type.Literal("CONTAINER"), Type.Null()])
    ),
    status: Type.Union([
      Type.Literal("completed"),
      Type.Literal("denied"),
      Type.Literal("unsupported"),
      Type.Literal("failed"),
      Type.Literal("incomplete"),
    ]),
    reason: Type.Union([
      Type.Literal("observed"),
      Type.Literal("invalid_operands"),
      Type.Literal("policy_denied"),
      Type.Literal("not_configured"),
      Type.Literal("cancelled"),
      Type.Literal("vm_failed"),
      Type.Literal("container_failed"),
      Type.Literal("guest_unsupported"),
      Type.Literal("timeout"),
      Type.Literal("output_limit"),
      Type.Literal("evidence_invalid"),
      Type.Literal("recovery_requires_exact_cache"),
      Type.Literal("containment_unproved"),
    ]),
    execution: ScaExecutionSchema,
    acceptance: Type.Union([
      Type.Literal("not_submitted"),
      Type.Literal("terminal"),
      Type.Literal("ambiguous"),
    ]),
    cleanup: Type.Union([
      Type.Literal("not_needed"),
      Type.Literal("proved"),
      Type.Literal("unproved"),
    ]),
    quarantine_required: Type.Boolean(),
    passed: Type.Union([Type.Boolean(), Type.Null()]),
    exit_code: Type.Union([Type.Integer({ minimum: -255, maximum: 255 }), Type.Null()]),
    stdout_base64: Type.String({ maxLength: 87_384 }),
    stderr_base64: Type.String({ maxLength: 87_384 }),
    raw_receipt_base64: Type.String({ maxLength: 20 * CONTROL_BYTES }),
    retained_workspace: Type.Union([Type.String({ minLength: 1, maxLength: 4096 }), Type.Null()]),
    evidence_scope: Type.Union([
      Type.Literal("untrusted_guest_observation_not_vulnerability_or_isolation_attestation"),
      Type.Literal("untrusted_container_observation_not_vulnerability_or_isolation_attestation"),
    ]),
  },
  { additionalProperties: false }
);
const Absolute = Type.String({ minLength: 1, maxLength: 4096 });
const Pin = Type.Object(
  {
    path: Absolute,
    sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    size_bytes: Type.Integer({ minimum: 1, maximum: 256 * 1_048_576 }),
  },
  { additionalProperties: false }
);
const Image = Type.Union([Type.String({ pattern: "^sha256:[a-f0-9]{64}$" }), Type.Null()]);

export const OrdinaryApplicationContainerConfigSchema = Type.Object(
  {
    schema_id: Type.Literal("penny.sca-ordinary-application-container-config.v1"),
    schema_version: Type.Literal(1),
    kind: Type.Literal("docker"),
    isolation: Type.Literal("container"),
    profile: Type.Literal(ORDINARY_APPLICATION_CONTAINER_PROFILE),
    workspace_parent: Absolute,
    docker: Pin,
    daemon_socket: Absolute,
    images: Type.Object({ php: Image, node: Image }, { additionalProperties: false }),
  },
  { additionalProperties: false }
);

const VmPin = Type.Object(
  {
    path: Absolute,
    sha256: Hex,
    size_bytes: Type.Integer({ minimum: 1, maximum: 34_359_738_368 }),
  },
  { additionalProperties: false }
);
export const OrdinaryApplicationVmConfigSchema = Type.Object(
  {
    workspace_parent: Absolute,
    global_lock: Absolute,
    run_job: VmPin,
    run_guest: VmPin,
    output_protocol: VmPin,
    python: VmPin,
    genisoimage: VmPin,
    cp: VmPin,
    qemu: VmPin,
    bwrap: VmPin,
    systemctl: VmPin,
    template: VmPin,
    bridge: VmPin,
    guest: VmPin,
  },
  { additionalProperties: false }
);
export const OrdinaryApplicationRuntimeConfigSchema = Type.Union([
  Type.Object(
    { kind: Type.Literal("qemu-kvm"), vm: OrdinaryApplicationVmConfigSchema },
    { additionalProperties: false }
  ),
  OrdinaryApplicationContainerConfigSchema,
]);
export type OrdinaryApplicationRuntimeConfig = Static<
  typeof OrdinaryApplicationRuntimeConfigSchema
>;
export type OrdinaryApplicationVmConfig = Static<typeof OrdinaryApplicationVmConfigSchema>;
export type OrdinaryApplicationTestResult = Static<typeof OrdinaryApplicationTestResultSchema>;
const ScaEnvironmentEntryV1Schema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Z_][A-Z0-9_]*$" }),
    value: Type.String({ maxLength: 8192 }),
  },
  { additionalProperties: false }
);

export const ScaProcessRequestV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.sca-process-request.v1"),
    schema_version: Type.Literal(1),
    executable: Type.String({ minLength: 1, maxLength: 4_096 }),
    executable_sha256: Sha256Schema,
    arguments: Type.Array(Type.String({ maxLength: 16384 }), {
      maxItems: 256,
    }),
    cwd: Type.String({ minLength: 1, maxLength: 4_096 }),
    environment: Type.Array(ScaEnvironmentEntryV1Schema, {
      maxItems: 64,
    }),
    /** Legacy wire name; enforced as renewable trusted-process inactivity, never total runtime. */
    timeout_ms: Type.Integer({ minimum: 1, maximum: 5400000 }),
    max_stdout_bytes: Type.Integer({ minimum: 1, maximum: 268435456 }),
    max_stderr_bytes: Type.Integer({ minimum: 1, maximum: 268435456 }),
  },
  { additionalProperties: false }
);

const ScaProcessStatusV1Schema = Type.Union([
  Type.Literal("succeeded"),
  Type.Literal("nonzero_exit"),
  Type.Literal("timed_out"),
  Type.Literal("cancelled"),
  Type.Literal("output_limit"),
  Type.Literal("spawn_failed"),
]);

export const ScaProcessResultV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.sca-process-result.v1"),
    schema_version: Type.Literal(1),
    request_sha256: Sha256Schema,
    status: ScaProcessStatusV1Schema,
    exit_code: Type.Union([Type.Integer({ minimum: 0, maximum: 255 }), Type.Null()]),
    signal: Type.Union([Type.String({ minLength: 1, maxLength: 64 }), Type.Null()]),
    stdout: Type.String(),
    stderr: Type.String(),
    stdout_sha256: Sha256Schema,
    stderr_sha256: Sha256Schema,
    stdout_bytes: Type.Integer({ minimum: 0, maximum: 268435456 }),
    stderr_bytes: Type.Integer({ minimum: 0, maximum: 268435456 }),
    stdout_truncated: Type.Boolean(),
    stderr_truncated: Type.Boolean(),
    failure_code: Type.Union([
      Type.Literal("none"),
      Type.Literal("nonzero_exit"),
      Type.Literal("timeout"),
      Type.Literal("cancelled"),
      Type.Literal("output_limit"),
      Type.Literal("spawn_failed"),
      Type.Literal("cleanup_failed"),
    ]),
  },
  { additionalProperties: false }
);

export type ScaProcessRequestV1 = Static<typeof ScaProcessRequestV1Schema>;
export type ScaProcessResultV1 = Static<typeof ScaProcessResultV1Schema>;
const closed = { additionalProperties: false } as const;
const digest = Type.String({ pattern: "^[a-f0-9]{64}$" });
const text = Type.String({ minLength: 1, maxLength: 16384 });
const id = Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$" });
const filePath = Type.String({ minLength: 1, maxLength: 4096 });
const lines = Type.Array(Type.Integer({ minimum: 1, maximum: 1000000 }), {
  maxItems: 4096,
});
const status = Type.Union([
  Type.Literal("validated"),
  Type.Literal("quarantined"),
  Type.Literal("not_feasible"),
  Type.Literal("denied"),
  Type.Literal("failed"),
]);
export const ScaRuleLearningLimitsSchema = Type.Object(
  {
    inactivity_ms: Type.Integer({ minimum: 1, maximum: 5400000 }),
    max_output_bytes: Type.Integer({ minimum: 1, maximum: 1048576 }),
    max_file_bytes: Type.Integer({ minimum: 1, maximum: 1048576 }),
    max_input_bytes: Type.Integer({ minimum: 1, maximum: 67108864 }),
    max_memory_mb: Type.Integer({ minimum: 1, maximum: 65536 }),
    max_processes: Type.Integer({ minimum: 1, maximum: 513 }),
    performance_bound_ms: Type.Integer({ minimum: 1, maximum: 5400000 }),
  },
  closed
);
export const ScaRuleLearningFixtureSchema = Type.Object(
  {
    id,
    case_class: Type.Union([
      Type.Literal("vulnerable"),
      Type.Literal("fixed"),
      Type.Literal("negative_neighbor"),
      Type.Literal("benign"),
      Type.Literal("generalized"),
      Type.Literal("retained_vulnerable"),
      Type.Literal("held_out"),
      Type.Literal("broader_regression"),
      Type.Literal("performance"),
    ]),
    file_name: Type.String({
      pattern: "^[A-Za-z0-9][A-Za-z0-9_-]*\\.(php|js|ts)$",
      maxLength: 256,
    }),
    content_base64: Type.String({ minLength: 1, maxLength: 1398104 }),
    content_sha256: digest,
    // Native --test omits negative-only checks. A separate declared positive control makes
    // a skipped test observable; independent scans must still prove every negative assertion.
    control_lines: lines,
    baseline_matches: Type.Array(
      Type.Object({ rule_id: id, line: Type.Integer({ minimum: 1, maximum: 1000000 }) }, closed),
      { maxItems: 4096 }
    ),
    assertions: Type.Array(
      Type.Object(
        {
          line: Type.Integer({ minimum: 1, maximum: 1000000 }),
          match: Type.Boolean(),
        },
        closed
      ),
      { minItems: 1, maxItems: 4096 }
    ),
  },
  closed
);
/** Optional host-admitted pins: no implicit acquisition or alternate toolchain. */
export const ScaRuleLearningOfflineValidationSchema = Type.Object(
  {
    python: ScaToolPathSchema,
    core: ScaToolPathSchema,
    core_library_directory: Type.Optional(filePath),
    metachecks: Type.Object(
      {
        rules_path: filePath,
        rules_sha256: digest,
        rule_ids: Type.Array(id, { minItems: 1, maxItems: 256, uniqueItems: true }),
      },
      closed
    ),
  },
  closed
);
export type ScaRuleLearningOfflineValidation = Static<
  typeof ScaRuleLearningOfflineValidationSchema
>;
export const ScaRuleLearningRequestSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    run_id: id,
    source_snapshot_sha256: digest,
    source_corpus_sha256: digest,
    reconciliation_sha256: digest,
    hypothesis_sha256: digest,
    disposition_sha256: digest,
    evidence_sha256: digest,
    hypothesis_id: id,
    root_cause: text,
    evidence_pointers: Type.Array(ScaPointerSchema, {
      minItems: 1,
      maxItems: 64,
    }),
    baseline: Type.Object(
      {
        release_sha256: digest,
        rules_path: filePath,
        rules_sha256: digest,
        rule_ids: Type.Array(id, { maxItems: 256, uniqueItems: true }),
      },
      closed
    ),
    tool: ScaToolPathSchema,
    offline_validation: Type.Optional(ScaRuleLearningOfflineValidationSchema),
    candidate: Type.Union([
      Type.Object(
        {
          rule_id: id,
          language: Type.Union([
            Type.Literal("php"),
            Type.Literal("javascript"),
            Type.Literal("typescript"),
          ]),
          rules_path: filePath,
          rules_sha256: digest,
        },
        closed
      ),
      Type.Null(),
    ]),
    no_rule_reason: Type.Union([text, Type.Null()]),
    fixtures: Type.Array(ScaRuleLearningFixtureSchema, { maxItems: 256 }),
    fixture_truth_sha256: digest,
    limits: ScaRuleLearningLimitsSchema,
  },
  closed
);
export type ScaRuleLearningRequest = Static<typeof ScaRuleLearningRequestSchema>;
export const ScaRuleLearningHostAdmissionSchema = Type.Object(
  {
    request_sha256: digest,
    decision: Type.Union([Type.Literal("allow"), Type.Literal("deny")]),
    // Issued only by the trusted host after checking exact reconciliation, confirmed eligible
    // hypothesis/evidence and independently reviewed fixture truth. A model cannot issue this.
    reconciliation_sha256: digest,
    hypothesis_sha256: digest,
    disposition_sha256: digest,
    evidence_sha256: digest,
    fixture_truth_sha256: digest,
    reason: text,
  },
  closed
);
export type ScaRuleLearningHostAdmission = Static<typeof ScaRuleLearningHostAdmissionSchema>;
export const ScaRuleLearningProcessReceiptSchema = Type.Object(
  {
    kind: Type.Union([
      Type.Literal("validate"),
      Type.Literal("validate_schema"),
      Type.Literal("test"),
      Type.Literal("scan"),
      Type.Literal("rescan"),
    ]),
    fixture_id: Type.Union([id, Type.Null()]),
    workspace_path: filePath,
    request_sha256: digest,
    started_at: Type.String({ minLength: 1, maxLength: 64 }),
    finished_at: Type.String({ minLength: 1, maxLength: 64 }),
    elapsed_ms: Type.Number({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    invocation: ScaProcessRequestV1Schema,
    result: ScaProcessResultV1Schema,
  },
  closed
);
export type ScaRuleLearningProcessReceipt = Static<typeof ScaRuleLearningProcessReceiptSchema>;
export const ScaRuleLearningResultSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    request_sha256: digest,
    status,
    reasons: Type.Array(text, { minItems: 1, maxItems: 512 }),
    baseline_unchanged: Type.Boolean(),
    validation_passed: Type.Boolean(),
    cases: Type.Array(
      Type.Object(
        {
          fixture_id: id,
          case_class: ScaRuleLearningFixtureSchema.properties.case_class,
          status: Type.Union([
            Type.Literal("passed"),
            Type.Literal("failed"),
            Type.Literal("unrun"),
          ]),
          test_passed: Type.Boolean(),
          scan_complete: Type.Boolean(),
          baseline_matches_passed: Type.Boolean(),
          assertions: Type.Array(
            Type.Object(
              {
                line: Type.Integer({ minimum: 1 }),
                expected: Type.Boolean(),
                observed: Type.Union([Type.Boolean(), Type.Null()]),
              },
              closed
            ),
            { maxItems: 4096 }
          ),
          unexpected_lines: lines,
          elapsed_ms: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
        },
        closed
      ),
      { maxItems: 256 }
    ),
    elapsed_ms: Type.Number({ minimum: 0 }),
    performance_passed: Type.Boolean(),
    private_receipts_sha256: digest,
    result_sha256: digest,
  },
  closed
);
export type ScaRuleLearningResult = Static<typeof ScaRuleLearningResultSchema>;
export const ScaRuleLearningRecordSchema = Type.Object(
  {
    request: ScaRuleLearningRequestSchema,
    result: ScaRuleLearningResultSchema,
    admission: ScaRuleLearningHostAdmissionSchema,
    receipts: Type.Array(ScaRuleLearningProcessReceiptSchema, {
      maxItems: 513,
    }),
  },
  closed
);
export type ScaRuleLearningRecord = Static<typeof ScaRuleLearningRecordSchema>;
export const ScaRulePromotionRequestSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    run_id: id,
    validation_sha256: digest,
    namespace: filePath,
    predecessor_release_sha256: digest,
    successor_revision: Type.Integer({ minimum: 1, maximum: 1000000 }),
    authority: Type.Object(
      {
        decision: Type.Union([Type.Literal("allow"), Type.Literal("deny")]),
        authority_sha256: digest,
        explicit_caller_authority: Type.Literal(true),
      },
      closed
    ),
  },
  closed
);
export type ScaRulePromotionRequest = Static<typeof ScaRulePromotionRequestSchema>;
export const ScaLearnedRuleReleaseSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    kind: Type.Literal("ordinary-sca-learned-rule-release"),
    request_sha256: digest,
    validation_sha256: digest,
    private_receipts_sha256: digest,
    source_snapshot_sha256: digest,
    source_corpus_sha256: digest,
    reconciliation_sha256: digest,
    hypothesis_sha256: digest,
    fixture_truth_sha256: digest,
    predecessor_release_sha256: digest,
    predecessor_rules_sha256: digest,
    retained_rule_content_base64: Type.String({ minLength: 1, maxLength: 1398104 }),
    retained_rule_sha256: digest,
    retained_rule_ids: Type.Array(id, { maxItems: 256, uniqueItems: true }),
    successor_revision: Type.Integer({ minimum: 1, maximum: 1000000 }),
    tool: ScaToolPathSchema,
    offline_validation: Type.Optional(ScaRuleLearningOfflineValidationSchema),
    rule_id: id,
    language: Type.Union([
      Type.Literal("php"),
      Type.Literal("javascript"),
      Type.Literal("typescript"),
    ]),
    rule_content_base64: Type.String({ minLength: 1, maxLength: 1398104 }),
    rule_sha256: digest,
    authority_sha256: digest,
    future_only: Type.Literal(true),
    immutable: Type.Literal(true),
    restored_from_release_sha256: Type.Optional(digest),
  },
  closed
);
export type ScaLearnedRuleRelease = Static<typeof ScaLearnedRuleReleaseSchema>;
export const ScaRulePromotionResultSchema = Type.Object(
  {
    status: Type.Union([
      Type.Literal("promoted"),
      Type.Literal("adopted"),
      Type.Literal("conflict"),
      Type.Literal("denied"),
      Type.Literal("failed"),
    ]),
    request_sha256: digest,
    reason: text,
    release_path: Type.Union([filePath, Type.Null()]),
    release_sha256: Type.Union([digest, Type.Null()]),
    baseline_unchanged: Type.Boolean(),
  },
  closed
);
export type ScaRulePromotionResult = Static<typeof ScaRulePromotionResultSchema>;
export const ScaRuleRollbackRequestSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    run_id: id,
    namespace: filePath,
    predecessor_release_path: filePath,
    predecessor_release_sha256: digest,
    restore_release_path: filePath,
    restore_release_sha256: digest,
    successor_revision: Type.Integer({ minimum: 1, maximum: 1000000 }),
    authority: ScaRulePromotionRequestSchema.properties.authority,
    limits: ScaRuleLearningLimitsSchema,
  },
  closed
);
export type ScaRuleRollbackRequest = Static<typeof ScaRuleRollbackRequestSchema>;
export const ScaRuleRescanRequestSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    run_id: id,
    release_path: filePath,
    release_sha256: digest,
    source_snapshot_sha256: digest,
    source_corpus_sha256: digest,
    retained_baseline_sha256: digest,
    predecessor_investigation_sha256: digest,
    rescan_revision: Type.Integer({ minimum: 1, maximum: 1000000 }),
    authority: ScaRulePromotionRequestSchema.properties.authority,
    limits: ScaRuleLearningLimitsSchema,
  },
  closed
);
export type ScaRuleRescanRequest = Static<typeof ScaRuleRescanRequestSchema>;
export const ScaRuleRescanResultSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    request_sha256: digest,
    status: Type.Union([Type.Literal("completed"), Type.Literal("denied"), Type.Literal("failed")]),
    reason: text,
    release_sha256: digest,
    retained_baseline_sha256: digest,
    predecessor_investigation_sha256: digest,
    rescan_revision: Type.Integer({ minimum: 1 }),
    source_snapshot_sha256: digest,
    source_corpus_sha256: digest,
    findings: Type.Array(
      Type.Object(
        {
          rule_id: id,
          path: filePath,
          start_line: Type.Integer({ minimum: 1 }),
          end_line: Type.Integer({ minimum: 1 }),
        },
        closed
      ),
      { maxItems: 32768 }
    ),
    reenter_investigation: Type.Boolean(),
    private_receipts_sha256: digest,
  },
  closed
);
export type ScaRuleRescanResult = Static<typeof ScaRuleRescanResultSchema>;

/** Caller templates omit owner-minted run/corpus addresses. Intake seals them into native operands. */
const FileInput = Type.Object({ path: filePath, sha256: digest }, closed);
const ApplicationInputFields = {
  id,
  source_snapshot_sha256: digest,
  interpreter: Interpreter,
  source_files: OrdinaryApplicationTestPlanSchema.properties.source_files,
  harness: FileInput,
  test_inputs: Type.Array(Type.Object({ name: Relative, file: FileInput }, closed), {
    maxItems: 8,
  }),
  stdin: Type.Union([FileInput, Type.Null()]),
  expected_exit_code: OrdinaryApplicationTestPlanSchema.properties.expected_exit_code,
};
export const ScaApplicationInputSchema = Type.Union([
  Type.Object(
    {
      ...ApplicationInputFields,
      isolation: Type.Optional(Type.Literal("vm")),
      resources: Resources,
      maxima: Resources,
    },
    closed
  ),
  Type.Object(
    {
      ...ApplicationInputFields,
      isolation: Type.Literal("container"),
      profile: Type.Literal(ORDINARY_APPLICATION_CONTAINER_PROFILE),
      resources: OrdinaryApplicationContainerResourcesSchema,
      maxima: OrdinaryApplicationContainerResourcesSchema,
    },
    closed
  ),
]);
export const ScaLearningInputSchema = Type.Object(
  {
    offline_validation: Type.Optional(ScaRuleLearningOfflineValidationSchema),
    id,
    source_snapshot_sha256: digest,
    baseline: ScaRuleLearningRequestSchema.properties.baseline,
    tool: ScaToolPathSchema,
    language: Type.Union([
      Type.Literal("php"),
      Type.Literal("javascript"),
      Type.Literal("typescript"),
    ]),
    rule_id: id,
    fixtures: ScaRuleLearningRequestSchema.properties.fixtures,
    fixture_truth_sha256: digest,
    limits: ScaRuleLearningLimitsSchema,
  },
  closed
);
const PromotionInput = Type.Object(
  {
    validation_id: id,
    candidate_sha256: digest,
    namespace: filePath,
    predecessor_release_sha256: digest,
    successor_revision: Type.Integer({ minimum: 1, maximum: 1000000 }),
    authority_sha256: digest,
  },
  closed
);
const RescanInput = Type.Object(
  {
    validation_id: id,
    source_snapshot_sha256: digest,
    rescan_revision: Type.Integer({ minimum: 1, maximum: 1000000 }),
    authority_sha256: digest,
  },
  closed
);
export const ScaAdvancedInputsSchema = Type.Object(
  {
    application_tests: Type.Array(ScaApplicationInputSchema, { maxItems: 16 }),
    learning: Type.Array(ScaLearningInputSchema, { maxItems: 16 }),
    promotions: Type.Array(PromotionInput, { maxItems: 16 }),
    rescans: Type.Array(RescanInput, { maxItems: 16 }),
  },
  closed
);
export type ScaAdvancedInputs = Static<typeof ScaAdvancedInputsSchema>;
export const ScaAdvancedStageSchema = Type.Union([
  Type.Literal("application"),
  Type.Literal("validation"),
  Type.Literal("promotion"),
  Type.Literal("rescan"),
]);
export type ScaAdvancedStage = Static<typeof ScaAdvancedStageSchema>;
export const ScaAdvancedRequestSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    stage: ScaAdvancedStageSchema,
    run_id: id,
    selection_id: id,
    action_id: id,
    hypothesis_id: id,
    input_bindings: Type.Array(Type.Object({ slot: id, ref: ArtifactRefSchema }, closed), {
      minItems: 1,
      maxItems: 32,
    }),
    input_sha256: digest,
    native_request: Type.Union([
      OrdinaryApplicationTestRequestSchema,
      ScaRuleLearningRequestSchema,
      ScaRulePromotionRequestSchema,
      ScaRuleRescanRequestSchema,
    ]),
  },
  closed
);
export type ScaAdvancedRequest = Static<typeof ScaAdvancedRequestSchema>;
export const ScaAdvancedResultSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    stage: ScaAdvancedStageSchema,
    selection_id: id,
    action_id: id,
    hypothesis_id: id,
    request_sha256: digest,
    status: Type.Union([
      Type.Literal("completed"),
      Type.Literal("validated"),
      Type.Literal("quarantined"),
      Type.Literal("not_feasible"),
      Type.Literal("promoted"),
      Type.Literal("adopted"),
      Type.Literal("denied"),
      Type.Literal("not_requested"),
      Type.Literal("failed"),
      Type.Literal("unsupported"),
      Type.Literal("incomplete"),
      Type.Literal("conflict"),
    ]),
    execution: ScaExecutionSchema,
    isolation: OrdinaryApplicationTestResultSchema.properties.isolation,
    evidence_scope: Type.Optional(OrdinaryApplicationTestResultSchema.properties.evidence_scope),
    passed: Type.Union([Type.Boolean(), Type.Null()]),
    exit_code: Type.Union([Type.Integer(), Type.Null()]),
    cleanup: Type.Union([
      Type.Literal("proved"),
      Type.Literal("unproved"),
      Type.Literal("not_needed"),
    ]),
    quarantine_required: Type.Boolean(),
    result_sha256: digest,
    validation_sha256: Type.Union([digest, Type.Null()]),
    release_sha256: Type.Union([digest, Type.Null()]),
    findings_count: Type.Integer({ minimum: 0 }),
    baseline_unchanged: Type.Boolean(),
  },
  closed
);
export type ScaAdvancedResult = Static<typeof ScaAdvancedResultSchema>;
export const ScaAdvancedSummarySchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    operations: Type.Array(ScaAdvancedResultSchema, { maxItems: 128 }),
  },
  closed
);
export type ScaAdvancedSummary = Static<typeof ScaAdvancedSummarySchema>;
export const ScaApplicationBindingsSchema = Type.Array(
  Type.Object(
    {
      id,
      plan_ref: ArtifactRefSchema,
      policy_ref: ArtifactRefSchema,
      closure: Type.Array(ArtifactRefSchema, { minItems: 2, maxItems: 11 }),
    },
    closed
  ),
  { maxItems: 16 }
);
export type OrdinaryApplicationTestRequest = Static<typeof OrdinaryApplicationTestRequestSchema>;
