import path from "node:path";
import { Type, type Static } from "typebox";
import {
  ScaP10NativeCollectionV1Schema,
  validateScaP10ValidateEvidenceV1,
  P10_NATIVE_STREAM_BYTES,
  parseScaP10NativeJson,
  validateScaP10NativeTestEvidenceV1,
} from "./p10-native-tests.js";

import { canonicalJson, sha256 } from "../canonical-json.js";
import {
  ArtifactRefSchema,
  validateContract,
  type HostOperationArtifactContractV1,
} from "../contracts.js";
import {
  hostOperationLeaseProfileSha256,
  type HostOperationDeclarationV1,
} from "../host-operations/contracts.js";
import { OpaqueIdSchema, Sha256Schema } from "../skill-contracts/common.js";
import {
  SCA_P10_EXPECTED_CASE_OUTCOME,
  ScaP10InvocationPerformanceV1Schema,
  deriveScaP10PerformanceCaseV1,
  SCA_P10_RULE_VALIDATION_OPERATION_KIND,
  SCA_P10_VALIDATION_CASE_CLASSES,
  validateScaP10RuleValidationResultsV1,
  withP10Digest,
  type ScaP10RuleValidationResultsV1,
  type ScaP10ValidationCaseClassV1,
} from "./p10-contracts.js";

/**
 * Deterministic, host/broker-owned Semgrep `--validate` / `--test` validation contract (`SCA-P10`
 * R6). The model never executes, interprets, or bypasses validation; the host operation produces
 * exact per-case records and the manifest is derived from them.
 */
export const SCA_P10_RULE_VALIDATION_REQUEST_SCHEMA =
  "penny.sca-p10-rule-validation-request.v1" as const;
export const SCA_P10_RULE_VALIDATION_RESULT_SCHEMA =
  "penny.sca-p10-rule-validation-result.v1" as const;

export const SCA_P10_RULE_VALIDATION_ADAPTER_ID = "sca-p10-rule-validation-adapter-v1" as const;
export const SCA_P10_RULE_VALIDATION_BACKEND_ID = "sca-p10-rule-validation-backend-v1" as const;
export const SCA_P10_RULE_VALIDATION_REQUEST_KIND = "sca-p10-rule-validation-request" as const;
export const SCA_P10_RULE_VALIDATION_RESULT_KIND = "sca-p10-rule-validation-result" as const;

const CaseClassSchema = Type.Union([
  Type.Literal("vulnerable"),
  Type.Literal("fixed"),
  Type.Literal("negative_neighbor"),
  Type.Literal("generalized"),
  Type.Literal("retained_vulnerable"),
  Type.Literal("held_out"),
  Type.Literal("broader_regression"),
  Type.Literal("performance"),
]);
const ExpectedCaseOutcomeSchema = Type.Union([
  Type.Literal("match"),
  Type.Literal("no_match"),
  Type.Literal("within_bound"),
]);
const ObservedCaseOutcomeSchema = Type.Union([
  Type.Literal("match"),
  Type.Literal("no_match"),
  Type.Literal("within_bound"),
  Type.Literal("regression"),
  Type.Literal("exceeded"),
]);
const CaseResultStatusSchema = Type.Union([
  Type.Literal("passed"),
  Type.Literal("failed"),
  Type.Literal("unrun"),
]);
const LanguageSchema = Type.Union([
  Type.Literal("php"),
  Type.Literal("javascript"),
  Type.Literal("typescript"),
]);

const RuntimeSchema = Type.Object(
  {
    state: Type.Union([Type.Literal("available"), Type.Literal("unavailable")]),
    executable: Type.Union([Type.String({ minLength: 1, maxLength: 4_096 }), Type.Null()]),
    executable_sha256: Type.Union([Sha256Schema, Type.Null()]),
    fixed_arguments: Type.Array(Type.String({ maxLength: 4_096 }), { maxItems: 0 }),
    tool_version: Type.Union([Type.String({ minLength: 1, maxLength: 256 }), Type.Null()]),
    unavailable_reason: Type.Union([
      Type.Literal("missing_runtime"),
      Type.Literal("unqualified_runtime"),
      Type.Literal("unsupported_platform"),
      Type.Null(),
    ]),
  },
  { additionalProperties: false }
);

/** Exact host operation request for one candidate's deterministic validation. */
export const ScaP10RuleValidationRequestV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P10_RULE_VALIDATION_REQUEST_SCHEMA),
    schema_version: Type.Literal(1),
    run_id: OpaqueIdSchema,
    candidate_id: Type.String({ pattern: "^p10cand_[a-f0-9]{64}$" }),
    rule_revision_ref: ArtifactRefSchema,
    rule_revision_sha256: Sha256Schema,
    rule_id: Type.String({ minLength: 1, maxLength: 256 }),
    rule_language: LanguageSchema,
    rule_content_base64: Type.String({ minLength: 1, maxLength: 4_194_304 }),
    rule_sha256: Sha256Schema,
    fixture_directory: Type.String({ minLength: 1, maxLength: 4_096 }),
    fixtures: Type.Array(
      Type.Object(
        {
          case_class: CaseClassSchema,
          file_name: Type.String({ minLength: 1, maxLength: 1_024 }),
          fixture_ref: ArtifactRefSchema,
          expected_outcome: ExpectedCaseOutcomeSchema,
        },
        { additionalProperties: false }
      ),
      { minItems: 8, maxItems: 8 }
    ),
    runtime: RuntimeSchema,
    performance_bound_ms: Type.Integer({ minimum: 1, maximum: 5_400_000 }),
    timeout_ms: Type.Integer({ minimum: 1, maximum: 5_400_000 }),
    max_output_bytes: Type.Integer({ minimum: 1, maximum: P10_NATIVE_STREAM_BYTES }),
    request_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P10_RULE_VALIDATION_REQUEST_SCHEMA }
);
export type ScaP10RuleValidationRequestV1 = Readonly<
  Static<typeof ScaP10RuleValidationRequestV1Schema>
>;

/** Exact per-candidate adapter result. The manifest is derived only from these exact records. */
export const ScaP10RuleValidationAdapterResultV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P10_RULE_VALIDATION_RESULT_SCHEMA),
    schema_version: Type.Literal(1),
    run_id: OpaqueIdSchema,
    candidate_id: Type.String({ pattern: "^p10cand_[a-f0-9]{64}$" }),
    rule_revision_ref: ArtifactRefSchema,
    rule_revision_sha256: Sha256Schema,
    request_sha256: Sha256Schema,
    validate: Type.Object(
      {
        invocation_sha256: Type.Union([Sha256Schema, Type.Null()]),
        invocation_json: Type.Union([Type.String({ maxLength: 1_048_576 }), Type.Null()]),
        process_result_json: Type.Union([Type.String({ maxLength: 8_388_608 }), Type.Null()]),
        executable_sha256: Type.Union([Sha256Schema, Type.Null()]),
        exit_status: Type.Union([Type.Integer({ minimum: 0, maximum: 255 }), Type.Null()]),
        raw_result_sha256: Type.Union([Sha256Schema, Type.Null()]),
        status: Type.Union([Type.Literal("passed"), Type.Literal("failed")]),
      },
      { additionalProperties: false }
    ),
    test: Type.Object(
      {
        collection: ScaP10NativeCollectionV1Schema,
        performance: ScaP10InvocationPerformanceV1Schema,
        invocation_sha256: Type.Union([Sha256Schema, Type.Null()]),
        exit_status: Type.Union([Type.Integer({ minimum: 0, maximum: 255 }), Type.Null()]),
        raw_result_sha256: Type.Union([Sha256Schema, Type.Null()]),
        status: Type.Union([Type.Literal("passed"), Type.Literal("failed")]),
      },
      { additionalProperties: false }
    ),
    cases: Type.Array(
      Type.Object(
        {
          case_class: CaseClassSchema,
          observed_outcome: Type.Union([ObservedCaseOutcomeSchema, Type.Null()]),
          status: CaseResultStatusSchema,
        },
        { additionalProperties: false }
      ),
      { minItems: 8, maxItems: 8 }
    ),
    result_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P10_RULE_VALIDATION_RESULT_SCHEMA }
);
export type ScaP10RuleValidationAdapterResultV1 = Readonly<
  Static<typeof ScaP10RuleValidationAdapterResultV1Schema>
>;

function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}
function assertSortedUnique(values: readonly string[], label: string): void {
  if (!same(values, [...new Set(values)].sort())) {
    throw new Error(`${label} must be unique and lexicographically sorted`);
  }
}

export function validateScaP10RuleValidationRequestV1(
  value: unknown
): ScaP10RuleValidationRequestV1 {
  const parsed = validateContract(
    ScaP10RuleValidationRequestV1Schema,
    value,
    "SCA P10 rule validation request"
  );
  assertSortedUnique(
    parsed.fixtures.map((fixture) => fixture.case_class),
    "SCA P10 rule validation request case classes"
  );
  if (new Set(parsed.fixtures.map((f) => f.file_name)).size !== 8)
    throw new Error("SCA P10 duplicate fixture names");
  for (const f of parsed.fixtures) {
    if (
      f.file_name === "." ||
      f.file_name === ".." ||
      /[/\\\0]/u.test(f.file_name) ||
      f.fixture_ref.byte_length > P10_NATIVE_STREAM_BYTES
    )
      throw new Error("SCA P10 invalid fixture name/size");
  }
  for (const caseClass of SCA_P10_VALIDATION_CASE_CLASSES) {
    const fixture = parsed.fixtures.find((entry) => entry.case_class === caseClass);
    if (fixture === undefined) {
      throw new Error(`SCA P10 rule validation request omits case '${caseClass}'`);
    }
    if (fixture.expected_outcome !== SCA_P10_EXPECTED_CASE_OUTCOME[caseClass]) {
      throw new Error("SCA P10 rule validation request expected outcome is not the closed default");
    }
    if (fixture.fixture_ref.content_digest.length !== 64) {
      throw new Error("SCA P10 rule validation request fixture ref is malformed");
    }
  }
  if (parsed.rule_revision_sha256 !== parsed.rule_revision_ref.content_digest) {
    throw new Error("SCA P10 rule validation request revision ref/digest mismatch");
  }
  const ruleBytes = Buffer.from(parsed.rule_content_base64, "base64");
  if (
    ruleBytes.toString("base64") !== parsed.rule_content_base64 ||
    parsed.rule_sha256 !== sha256(ruleBytes)
  ) {
    throw new Error("SCA P10 rule validation request rule digest mismatch");
  }
  const { request_sha256, ...body } = parsed;
  if (request_sha256 !== sha256(canonicalJson(body))) {
    throw new Error("SCA P10 rule validation request self digest mismatch");
  }
  return parsed;
}

export function validateScaP10RuleValidationAdapterResultV1(
  value: unknown
): ScaP10RuleValidationAdapterResultV1 {
  const parsed = validateContract(
    ScaP10RuleValidationAdapterResultV1Schema,
    value,
    "SCA P10 rule validation result"
  );
  assertSortedUnique(
    parsed.cases.map((entry) => entry.case_class),
    "SCA P10 rule validation result case classes"
  );
  for (const caseClass of SCA_P10_VALIDATION_CASE_CLASSES) {
    const result = parsed.cases.find((entry) => entry.case_class === caseClass);
    if (result === undefined) {
      throw new Error(`SCA P10 rule validation result omits case '${caseClass}'`);
    }
    if (
      result.status === "passed" &&
      result.observed_outcome !== SCA_P10_EXPECTED_CASE_OUTCOME[caseClass]
    ) {
      throw new Error("SCA P10 rule validation result passed case observed the wrong outcome");
    }
  }
  validateScaP10ValidateEvidenceV1(parsed.validate);
  validateScaP10NativeTestEvidenceV1(parsed.test, parsed.cases);
  if (
    parsed.validate.status === "passed" &&
    (parsed.validate.exit_status !== 0 ||
      parsed.validate.invocation_sha256 === null ||
      parsed.validate.raw_result_sha256 === null ||
      parsed.validate.executable_sha256 === null ||
      parsed.validate.process_result_json === null)
  )
    throw new Error("SCA P10 validate lacks completion evidence");
  const performance = parsed.cases.find((entry) => entry.case_class === "performance");
  const measured = deriveScaP10PerformanceCaseV1(parsed.test);
  if (
    performance === undefined ||
    performance.status !== measured.status ||
    performance.observed_outcome !== measured.observed_outcome
  ) {
    throw new Error("SCA P10 validation result performance disagrees with host measurement");
  }
  if (parsed.rule_revision_sha256 !== parsed.rule_revision_ref.content_digest) {
    throw new Error("SCA P10 rule validation result revision ref/digest mismatch");
  }
  const body = Object.fromEntries(
    Object.entries(parsed).filter(([key]) => key !== "result_sha256")
  );
  if (parsed.result_sha256 !== sha256(canonicalJson(body))) {
    throw new Error("SCA P10 rule validation result self digest mismatch");
  }
  return parsed;
}

/**
 * Host-supplied identity of the bounded Semgrep runtime used for deterministic validation. It is
 * not an artifact: the host binds it into the declaration's backend key and every request runtime.
 */
export interface ScaP10RuleValidationRuntimeConfigV1 {
  readonly executable: string;
  readonly executable_sha256: string;
  /** Must be empty. Wrapper transport is outside this closed P10 adapter; pin a no-argument launcher. */
  readonly fixed_arguments: readonly string[];
  readonly tool_version: string;
}

/** Deterministic projection of a validated runtime config into the request runtime shape. */
export function scaP10RuleValidationRuntimeV1(
  config: ScaP10RuleValidationRuntimeConfigV1
): ScaP10RuleValidationRequestV1["runtime"] {
  if (
    typeof config.executable !== "string" ||
    config.executable.length === 0 ||
    config.executable.length > 4_096 ||
    !config.executable.startsWith("/") ||
    config.executable.includes("\0")
  ) {
    throw new Error("SCA P10 rule validation runtime executable is not a bounded absolute path");
  }
  if (!/^[a-f0-9]{64}$/u.test(config.executable_sha256)) {
    throw new Error("SCA P10 rule validation runtime executable digest is invalid");
  }
  if (typeof config.tool_version !== "string" || config.tool_version.length === 0) {
    throw new Error("SCA P10 rule validation runtime tool version is invalid");
  }
  if (!Array.isArray(config.fixed_arguments) || config.fixed_arguments.length !== 0)
    throw new Error("SCA P10 fixed arguments must be empty; use a pinned no-argument launcher");
  return {
    state: "available",
    executable: config.executable,
    executable_sha256: config.executable_sha256,
    fixed_arguments: [],
    tool_version: config.tool_version,
    unavailable_reason: null,
  };
}

/** Host-derived backend key for the local Semgrep validation backend. */
export function scaP10RuleValidationBackendKeySha256(
  config: ScaP10RuleValidationRuntimeConfigV1
): string {
  const runtime = scaP10RuleValidationRuntimeV1(config);
  return sha256(
    canonicalJson({
      schema_version: 1,
      operation_kind: SCA_P10_RULE_VALIDATION_OPERATION_KIND,
      adapter_id: SCA_P10_RULE_VALIDATION_ADAPTER_ID,
      backend_binding_id: SCA_P10_RULE_VALIDATION_BACKEND_ID,
      executable: config.executable,
      executable_sha256: config.executable_sha256,
      fixed_arguments: runtime.fixed_arguments,
      tool_version: runtime.tool_version,
    })
  );
}

/** Closed Semgrep argv contract. Values are separate argv entries and never shell text. `validate`
 * performs full validation including metachecks; `test` runs exactly one caller-bound FILE.
 */
export function scaP10RuleValidationArguments(
  kind: "validate" | "test",
  input: {
    readonly fixedArguments: readonly string[];
    readonly ruleConfigPath: string;
    readonly fixturePath?: string;
  }
): readonly string[] {
  if (!Array.isArray(input.fixedArguments) || input.fixedArguments.length !== 0)
    throw new Error("SCA P10 fixed arguments must be empty");
  const canonicalPath = (value: string): boolean =>
    path.isAbsolute(value) && path.normalize(value) === value && !value.includes("\0");
  if (!canonicalPath(input.ruleConfigPath))
    throw new Error("SCA P10 config path is not canonical absolute");
  const common = ["--metrics=off", "--disable-version-check", "--no-git-ignore"];
  if (kind === "validate") {
    return [...common, "--validate", "--config", input.ruleConfigPath];
  }
  if (kind !== "test" || input.fixturePath === undefined || !canonicalPath(input.fixturePath))
    throw new Error("SCA P10 test requires an explicit absolute fixture FILE");
  return [...common, "--test", "--json", "--config", input.ruleConfigPath, "--", input.fixturePath];
}

/**
 * Derive raw self-test agreement, not independently qualified learning evidence. Production host
 * admission must block positives until independently approved fixture truth exists.
 * The entry fails closed: a case whose
 * observed outcome differs from the closed expected outcome is `failed`; a case with no observed
 * outcome is `unrun`. A required-but-unrun case is never disguised as a completed assessment.
 */
export function deriveScaP10ValidationEntry(input: {
  readonly request: ScaP10RuleValidationRequestV1;
  readonly result: ScaP10RuleValidationAdapterResultV1;
}): ScaP10RuleValidationResultsV1["candidates"][number] {
  const request = validateScaP10RuleValidationRequestV1(input.request);
  const result = validateScaP10RuleValidationAdapterResultV1(input.result);
  if (
    result.validate.executable_sha256 !== request.runtime.executable_sha256 ||
    result.run_id !== request.run_id ||
    result.test.performance.bound_ms !== request.performance_bound_ms ||
    result.candidate_id !== request.candidate_id ||
    !same(result.rule_revision_ref, request.rule_revision_ref) ||
    result.rule_revision_sha256 !== request.rule_revision_sha256 ||
    result.request_sha256 !== request.request_sha256
  ) {
    throw new Error("SCA P10 validation adapter result is not bound to its request");
  }
  const configPath = result.test.collection.children[0]?.config_path;
  const cwd = configPath === undefined ? "" : path.dirname(path.dirname(configPath));
  const expectedEnvironment = [
    { name: "HOME", value: cwd },
    { name: "PATH", value: "/usr/bin:/bin" },
    { name: "SEMGREP_ENABLE_VERSION_CHECK", value: "0" },
    { name: "SEMGREP_SEND_METRICS", value: "off" },
  ];
  const assertInvocation = (
    raw: string,
    kind: "validate" | "test",
    config: string,
    fixturePath?: string
  ): void => {
    const invocation = parseScaP10NativeJson(raw);
    if (typeof invocation !== "object" || invocation === null || Array.isArray(invocation))
      throw new Error("SCA P10 invalid invocation");
    const fields = Object.fromEntries(Object.entries(invocation));
    if (
      canonicalJson(fields) !== raw ||
      !same(
        Object.keys(fields).sort(),
        [
          "schema_id",
          "schema_version",
          "executable",
          "executable_sha256",
          "arguments",
          "cwd",
          "environment",
          "timeout_ms",
          "max_stdout_bytes",
          "max_stderr_bytes",
        ].sort()
      ) ||
      fields.schema_id !== "penny.sca-process-request.v1" ||
      fields.schema_version !== 1 ||
      fields.cwd !== cwd ||
      !same(fields.environment, expectedEnvironment) ||
      !same(
        fields.arguments,
        scaP10RuleValidationArguments(kind, {
          fixedArguments: request.runtime.fixed_arguments,
          ruleConfigPath: config,
          ...(fixturePath === undefined ? {} : { fixturePath }),
        })
      ) ||
      fields.executable !== request.runtime.executable ||
      fields.executable_sha256 !== request.runtime.executable_sha256 ||
      fields.timeout_ms !== request.timeout_ms ||
      fields.max_stdout_bytes !== request.max_output_bytes ||
      fields.max_stderr_bytes !== request.max_output_bytes
    )
      throw new Error("SCA P10 native invocation binding drift");
  };
  if (result.validate.invocation_json !== null) {
    if (configPath === undefined) throw new Error("SCA P10 config binding absent");
    assertInvocation(result.validate.invocation_json, "validate", configPath);
  }
  for (const child of result.test.collection.children) {
    const fixture = request.fixtures.find((f) => f.case_class === child.case_class);
    if (
      fixture === undefined ||
      fixture.file_name !== child.file_name ||
      fixture.fixture_ref.content_digest !== child.fixture_sha256 ||
      child.rule_id !== request.rule_id ||
      child.config_sha256 !== request.rule_sha256 ||
      child.config_source_base64 !== request.rule_content_base64 ||
      Buffer.from(child.source_base64, "base64").byteLength !== fixture.fixture_ref.byte_length
    )
      throw new Error("SCA P10 native child is not bound to its request");
    if (child.invocation_json !== null) {
      assertInvocation(child.invocation_json, "test", child.config_path, child.fixture_path);
    }
  }
  const cases = SCA_P10_VALIDATION_CASE_CLASSES.map((caseClass) => {
    const output = result.cases.find((entry) => entry.case_class === caseClass);
    if (output === undefined) {
      throw new Error(`SCA P10 validation adapter result omits case '${caseClass}'`);
    }
    const expected = SCA_P10_EXPECTED_CASE_OUTCOME[caseClass];
    const observed = output.observed_outcome;
    const status =
      output.status === "unrun" || observed === null ? ("unrun" as const) : output.status;
    return {
      case_class: caseClass,
      expected_outcome: expected,
      observed_outcome: observed,
      status,
    };
  });
  const requiredUnrun = cases
    .filter((entry) => entry.status === "unrun")
    .map((entry) => entry.case_class)
    .sort();
  const manifestComplete =
    cases.every((entry) => entry.status === "passed") &&
    result.validate.status === "passed" &&
    result.test.status === "passed";
  const blockerCodes: string[] = [];
  if (result.validate.status !== "passed") blockerCodes.push("p10_validate_failed");
  if (result.test.status !== "passed") blockerCodes.push("p10_test_failed");
  if (!manifestComplete) blockerCodes.push("p10_validation_incomplete");
  return {
    candidate_id: request.candidate_id,
    rule_revision_ref: request.rule_revision_ref,
    rule_revision_sha256: request.rule_revision_sha256,
    validate: {
      invocation_sha256: result.validate.invocation_sha256,
      invocation_json: result.validate.invocation_json,
      process_result_json: result.validate.process_result_json,
      executable_sha256: result.validate.executable_sha256,
      exit_status: result.validate.exit_status,
      raw_result_sha256: result.validate.raw_result_sha256,
      status: result.validate.status,
    },
    test: {
      collection: result.test.collection,
      performance: result.test.performance,
      invocation_sha256: result.test.invocation_sha256,
      exit_status: result.test.exit_status,
      raw_result_sha256: result.test.raw_result_sha256,
      status: result.test.status,
    },
    cases,
    required_unrun_case_classes: requiredUnrun,
    manifest_complete: manifestComplete,
    blocker_codes: blockerCodes.sort(),
  };
}

export function buildScaP10ValidationManifest(input: {
  readonly run_id: string;
  readonly entries: readonly ScaP10RuleValidationResultsV1["candidates"][number][];
}): ScaP10RuleValidationResultsV1 {
  const entries = [...input.entries].sort((left, right) =>
    left.candidate_id < right.candidate_id ? -1 : 1
  );
  return validateScaP10RuleValidationResultsV1(
    withP10Digest(
      {
        schema_id: "penny.sca-p10-rule-validation-results.v1",
        schema_version: 1 as const,
        phase_id: "SCA-P10" as const,
        run_id: input.run_id,
        host_operation_kind: SCA_P10_RULE_VALIDATION_OPERATION_KIND,
        host_owned: true as const,
        model_calls: 0 as const,
        tool_calls: 0 as const,
        candidates: entries,
        candidate_count: entries.length,
      },
      "validation_sha256"
    )
  );
}

function artifactContract(
  portName: string,
  artifactKind: string,
  schemaId: string
): HostOperationArtifactContractV1 {
  return {
    schema_version: 1,
    port_name: portName,
    artifact_kind: artifactKind,
    schema_id: schemaId,
    schema_version_required: 1,
  };
}

/**
 * Declared deterministic host operation for candidate validation. Recovery is
 * `atomic_local_publication_v1` and cancellation is `local_abort_only_v1`; the adapter runs the
 * real bounded process runner and never consults a model.
 */
export const SCA_P10_RULE_VALIDATION_DECLARATION: HostOperationDeclarationV1 = (() => {
  const leaseBody = {
    profile_id: "sca-p10-rule-validation-lease-v1",
    profile_version: 1 as const,
    duration_ms: 1_800_000,
    renew_after_ms: 300_000,
    queue_inactivity_ms: 600_000,
  };
  return {
    schema_version: 1,
    operation_kind: SCA_P10_RULE_VALIDATION_OPERATION_KIND,
    adapter_id: SCA_P10_RULE_VALIDATION_ADAPTER_ID,
    request: artifactContract(
      "p10_rule_validation_request",
      SCA_P10_RULE_VALIDATION_REQUEST_KIND,
      SCA_P10_RULE_VALIDATION_REQUEST_SCHEMA
    ),
    result: artifactContract(
      "p10_rule_validation_result",
      SCA_P10_RULE_VALIDATION_RESULT_KIND,
      SCA_P10_RULE_VALIDATION_RESULT_SCHEMA
    ),
    backend_binding_id: SCA_P10_RULE_VALIDATION_BACKEND_ID,
    capability_classes: ["artifact_store"],
    lease_profile: {
      ...leaseBody,
      profile_sha256: hostOperationLeaseProfileSha256(leaseBody),
    },
    operation_inactivity_ms: 1_800_000,
    max_request_bytes: 64 * 1024 * 1024,
    max_input_artifacts: 8,
    max_input_bytes: 512 * 1024 * 1024,
    max_output_artifacts: 1,
    max_output_bytes: 256 * 1024 * 1024,
    // Per-candidate results share one kind under the validating phase; the owning playbook resolves
    // each exact result from its operation/request binding, so the result must not be selected as
    // the single current revision of that kind.
    result_selection_policy: "unselected" as const,
    max_progress_events: 4_096,
    max_pre_acceptance_retries: 0,
    recovery_semantics: "atomic_local_publication_v1",
    cancellation_semantics: "local_abort_only_v1",
  };
})();

/** Candidate ids that reached a complete manifest versus those that remain unresolved. */
export function scaP10ValidatedCandidateIds(
  manifest: ScaP10RuleValidationResultsV1
): ReadonlySet<string> {
  return new Set(
    manifest.candidates
      .filter((entry) => entry.manifest_complete)
      .map((entry) => entry.candidate_id)
  );
}

/** Candidate ids whose required validation is required-but-unrun (a blocked assessment). */
export function scaP10BlockedCandidateIds(
  manifest: ScaP10RuleValidationResultsV1
): ReadonlySet<string> {
  return new Set(
    manifest.candidates
      .filter(
        (entry) =>
          !entry.manifest_complete &&
          (entry.required_unrun_case_classes.length > 0 ||
            entry.validate.status !== "passed" ||
            entry.test.status !== "passed")
      )
      .map((entry) => entry.candidate_id)
  );
}

export function scaP10CaseClassSet(): readonly ScaP10ValidationCaseClassV1[] {
  return SCA_P10_VALIDATION_CASE_CLASSES;
}
