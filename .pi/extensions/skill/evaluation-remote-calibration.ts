import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { InMemoryCredentialStore, type Api, type Model } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

import {
  ArtifactStore,
  JsonValueSchema,
  PiAgentClient,
  canonicalJson,
  initializePennyState,
  resolvePennyRuntimeState,
  sha256,
  skillContractSha256,
  strictParseJson,
  ssotModel,
  validateContract,
  type AgentCompletion,
  type AgentInvocation,
  type AgentSessionLivenessEventV1,
  type AgentSessionTraceRecordV1,
  type ArtifactRef,
  type JsonValue,
  type PlaybookRegistrationV1,
  type PlaybookRegistryV1,
} from "@penny/orchestration/source";

import {
  DECIDE_EVALUATION_ABLATION_REGISTRY,
  DECIDE_EVALUATION_CANDIDATE_REGISTRY,
  DECIDE_SEMANTIC_CLAUSE_IDS,
  DECIDE_SEMANTIC_V3_GRADER_IMPLEMENTATION,
  DIRECT_DECIDE_DEMETRI_BASELINE_REGISTRATION,
  DecideSemanticGraderOracleV3Schema,
  buildDecisionSemanticOracleReviewPacketV3,
  buildDecisionSemanticTrialReviewPacketV3,
  createDecisionSemanticV3GradingDefinition,
  decisionSemanticV3GraderDescriptor,
  validateDecideSemanticV3CommonWire,
} from "./decide-evaluation.js";
import {
  CALIBRATION_FORBIDDEN_REUSE,
  AuthorizedPlanSemanticEvidenceProjectionV1Schema,
  PlanCalibrationSourceAdmissionV1Schema,
  calibrationCanonicalSha256,
  projectAuthorizedPlanCalibrationSemanticEvidenceV1,
  readinessTaskFromCalibrationTask,
  validateEvaluationCalibrationCohort,
  validateEvaluationCalibrationPackage,
  validateEvaluationCalibrationSchedule,
  validateEvaluationCalibrationSemanticJudgeControl,
  validateEvaluationCalibrationTask,
  validateEvaluationCalibrationContaminationFingerprintManifest,
  type EvaluationCalibrationCohortV1,
  type EvaluationCalibrationPackageV1,
  type EvaluationCalibrationScheduleV1,
} from "./evaluation-calibration-package.js";
import {
  PairedEvaluationPlanV1Schema,
  PairedEvaluationScheduleEntryV1Schema,
  type EvaluationPopulationTaskV1,
  type FrozenPairedEvaluationV1,
  type PairedEvaluationPlanV1,
  type PairedEvaluationScheduleEntryV1,
} from "./evaluation-contracts.js";
import { preflightLocalLiveArtifactRead } from "./evaluation-local-live.js";
import {
  ArtifactEvaluationTrialJournal,
  GenericEvaluationTrialExecutor,
  RealTopologyEvaluationReadinessPreflight,
  createEvaluationSemanticReviewCoordinator,
  directBaselineDefinition,
  evaluationGradingDefinitionSha256,
  type DeterministicGraderDescriptorV1,
  type DeterministicGraderResultV1,
  type EvaluationCommonWireValidatorV1,
  type EvaluationGradingDefinitionV1,
  type EvaluationModelClientFactoryV1,
  type EvaluationRuntimeBindingV1,
  type EvaluationRuntimeMeasurementV1,
  type EvaluationSemanticReviewCoordinatorV1,
  type EvaluationTrialObservationV1,
  type MeasuredEvaluationModelClientV1,
} from "./evaluation-runner.js";
import {
  Q4_ORACLE_REVIEW_CLAUSE_IDS,
  SEMANTIC_REVIEW_IMPLEMENTATION_SHA256,
  SEMANTIC_REVIEW_JUDGE_DEFINITION_SHA256,
  SEMANTIC_REVIEW_SYSTEM_PROMPT_V1,
  PreauthorizedIndependentSemanticReviewExecutorV1,
  evaluationLiveCalibrationApprovalReceiptSha256,
  evaluationLiveCalibrationAuthorizationManifestSha256,
  semanticReviewOutputSchemaSha256,
  semanticReviewPacketSchemaSha256,
  validateEvaluationLiveCalibrationApprovalReceipt,
  validateEvaluationLiveCalibrationAuthorizationManifest,
  validateSemanticReviewPacketV1,
  type EvaluationLiveCalibrationApprovalReceiptV1,
  type EvaluationLiveCalibrationAuthorizationManifestV1,
  type EvaluationOperatorApprovalVerifierV1,
  type PiSemanticReviewModelResolverV1,
} from "./evaluation-semantic-review.js";
import type { PlanSemanticRequestProjectionV1 } from "./evaluation-semantic-projections.js";
import {
  PLAN_EVALUATION_ABLATION_REGISTRY,
  PLAN_EVALUATION_CANDIDATE_REGISTRY,
  PLAN_SEMANTIC_CLAUSE_IDS,
  PLAN_SEMANTIC_V2_GRADER_IMPLEMENTATION,
  DIRECT_PIPER_PLAN_BASELINE_REGISTRATION,
  PlanSemanticGraderOracleV2Schema,
  buildPlanSemanticOracleReviewPacketV2,
  buildPlanSemanticTrialReviewPacketV2,
  createPlanSemanticV2GradingDefinition,
  planSemanticQualificationStatusV2,
  planSemanticV2GraderDescriptor,
  validatePlanSemanticV2CommonWire,
} from "./plan-evaluation.js";

const MAX_COMPONENT_BYTES = 16_777_216;
const MAX_PACKAGE_BYTES = 1_048_576;
const LIVE_ENV = "PENNY_EVALUATION_REMOTE_LIVE";
export const REMOTE_CALIBRATION_RUNTIME_ID = "penny-pi-agent-client-v1";
const DigestSchema = Type.String({ pattern: "^[a-f0-9]{64}$" });
const CalibrationTrialResultV1Schema = Type.Object(
  {
    trial_id: Type.String({ pattern: "^evaltrial_[a-f0-9]{64}$" }),
    task_id: Type.String({ minLength: 1, maxLength: 256 }),
    arm_id: Type.String({ minLength: 1, maxLength: 256 }),
    repetition: Type.Integer({ minimum: 1, maximum: 32 }),
    terminal_status: Type.Literal("complete"),
    output_ref: Type.Object(
      {
        schema_version: Type.Literal(2),
        artifact_id: Type.String({ pattern: "^art_[a-f0-9]{64}$" }),
        run_id: Type.String(),
        phase: Type.String(),
        branch_id: Type.Union([Type.String(), Type.Null()]),
        kind: Type.String(),
        operation_id: Type.String(),
        version: Type.Integer({ minimum: 1 }),
        producer: Type.String(),
        media_type: Type.String(),
        content_schema: Type.Optional(
          Type.Object(
            { schema_id: Type.String(), schema_version: Type.Integer({ minimum: 1 }) },
            { additionalProperties: false }
          )
        ),
        byte_length: Type.Integer({ minimum: 0 }),
        content_digest: DigestSchema,
        store_ref: Type.String(),
      },
      { additionalProperties: false }
    ),
    common_wire_sha256: DigestSchema,
    structural_grade_sha256: DigestSchema,
    semantic_qualification: Type.Literal("QUALIFIED"),
    cost_microusd: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    latency_ms: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  },
  { additionalProperties: false }
);

export const EvaluationRemoteCalibrationResultV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.evaluation-remote-calibration-result.v1"),
    schema_version: Type.Literal(1),
    split: Type.Literal("calibration"),
    scoring: Type.Literal("non_scoring"),
    package_id: Type.String({ minLength: 1, maxLength: 256 }),
    package_sha256: DigestSchema,
    schedule_sha256: DigestSchema,
    authorization_manifest_sha256: DigestSchema,
    approval_receipt_sha256: DigestSchema,
    runtime_binding_sha256: DigestSchema,
    status: Type.Literal("COMPLETED_NON_SCORING"),
    trials: Type.Array(CalibrationTrialResultV1Schema, { minItems: 1, maxItems: 65_536 }),
    accounting: Type.Object(
      {
        scheduled_trials: Type.Integer({ minimum: 1 }),
        completed_trials: Type.Integer({ minimum: 1 }),
        execution_provider_calls: Type.Integer({ minimum: 0 }),
        semantic_review_provider_calls: Type.Integer({ minimum: 0 }),
        total_cost_microusd: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
        total_latency_ms: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
      },
      { additionalProperties: false }
    ),
    result_sha256: DigestSchema,
  },
  { additionalProperties: false }
);
export type EvaluationRemoteCalibrationResultV1 = Readonly<
  Static<typeof EvaluationRemoteCalibrationResultV1Schema>
>;

export interface RemoteCalibrationModelCatalogV1 {
  getModel(provider: string, model: string): Model<Api> | undefined;
}

export interface RemoteCalibrationDependenciesV1 {
  readonly createCatalog: () => Promise<RemoteCalibrationModelCatalogV1>;
  readonly now: () => Date;
  readonly monotonicNow: () => number;
}

export interface LoadedCalibrationPackageV1 {
  readonly package: EvaluationCalibrationPackageV1;
  readonly cohort: EvaluationCalibrationCohortV1;
  readonly schedule: EvaluationCalibrationScheduleV1;
  readonly scheduleSha256: string;
  readonly componentBytes: ReadonlyMap<string, Uint8Array>;
  readonly oracleItems: readonly Readonly<Record<string, unknown>>[];
  readonly q4Packets: readonly Readonly<Record<string, unknown>>[];
  readonly semanticTaskOverrides: ReadonlyMap<string, PlanSemanticRequestProjectionV1>;
}

export interface RemoteCalibrationPreflightV1 {
  readonly loaded: LoadedCalibrationPackageV1;
  readonly manifest: AuthorizedFleetManifestV1;
  readonly approval: EvaluationLiveCalibrationApprovalReceiptV1;
  readonly runtimeBindingSha256: string;
  readonly models: ReadonlyMap<string, Model<Api>>;
  readonly judgeModel: Model<Api>;
  readonly gradingDefinition: EvaluationGradingDefinitionV1;
  readonly tasks: readonly EvaluationPopulationTaskV1[];
  readonly plan: PairedEvaluationPlanV1;
  readonly frozen: FrozenPairedEvaluationV1;
  readonly registrations: CalibrationRegistrationsV1;
  readonly readiness: RealTopologyEvaluationReadinessPreflight;
  readonly validateCommonWire: EvaluationCommonWireValidatorV1;
}

type FleetEntryV1 = NonNullable<
  EvaluationLiveCalibrationAuthorizationManifestV1["execution_fleet"]
>[number];
type AuthorizedFleetManifestV1 = EvaluationLiveCalibrationAuthorizationManifestV1 & {
  readonly execution_fleet: readonly FleetEntryV1[];
  readonly judge_rates: EvaluationRuntimeBindingV1["rates"];
  readonly limits: EvaluationLiveCalibrationAuthorizationManifestV1["limits"] & {
    readonly max_execution_calls_per_trial: number;
    readonly max_execution_turns_per_trial: number;
  };
};

interface CalibrationRegistrationsV1 {
  readonly baseline: PlaybookRegistrationV1;
  readonly candidates: PlaybookRegistryV1;
  readonly ablations: PlaybookRegistryV1;
}

interface OracleBundleItemV1 extends Readonly<Record<string, unknown>> {
  readonly oracle_item_id: string;
  readonly task_id: string;
  readonly variant: string;
  readonly oracle: unknown;
  readonly derivation: Readonly<Record<string, unknown>>;
  readonly contamination_attestation: Readonly<Record<string, unknown>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function asArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function asString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be text`);
  return value;
}

function parseJsonBytes(bytes: Uint8Array, label: string): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (cause) {
    throw new Error(`${label} is not UTF-8 JSON`, { cause });
  }
}

function checkedFile(root: string, relative: string, maximum: number): Buffer {
  if (
    path.isAbsolute(relative) ||
    relative.includes("\\") ||
    path.posix.normalize(relative) !== relative ||
    relative
      .split("/")
      .some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new Error(`calibration path '${relative}' is not canonical project-relative`);
  }
  const candidate = path.join(root, ...relative.split("/"));
  let current = root;
  for (const segment of relative.split("/")) {
    current = path.join(current, segment);
    const stats = lstatSync(current);
    if (stats.isSymbolicLink())
      throw new Error(`calibration path '${relative}' contains a symlink`);
  }
  const resolved = realpathSync(candidate);
  const relativeToRoot = path.relative(realpathSync(root), resolved);
  if (
    relativeToRoot === ".." ||
    relativeToRoot.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeToRoot)
  ) {
    throw new Error(`calibration path '${relative}' escapes the project root`);
  }
  const before = lstatSync(resolved);
  if (!before.isFile() || before.size < 1 || before.size > maximum) {
    throw new Error(`calibration path '${relative}' is not one bounded regular file`);
  }
  const bytes = readFileSync(resolved);
  const after = lstatSync(resolved);
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size) {
    throw new Error(`calibration path '${relative}' changed while reading`);
  }
  return bytes;
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function componentRecord(
  componentBytes: ReadonlyMap<string, Uint8Array>,
  componentId: string
): Record<string, unknown> {
  const bytes = componentBytes.get(componentId);
  if (bytes === undefined) throw new Error(`calibration package omits '${componentId}'`);
  return asRecord(parseJsonBytes(bytes, componentId), componentId);
}

function exactReusePolicy(value: unknown, label: string): void {
  const policy = asRecord(value, label);
  if (
    policy.scoring !== "non_scoring" ||
    canonicalJson(policy.forbidden_uses) !== canonicalJson(CALIBRATION_FORBIDDEN_REUSE)
  ) {
    throw new Error(`${label} does not preserve the non-scoring calibration boundary`);
  }
}

export function loadCalibrationPackageV1(input: {
  readonly projectRoot: string;
  readonly packagePath: string;
}): LoadedCalibrationPackageV1 {
  const packageBytes = checkedFile(input.projectRoot, input.packagePath, MAX_PACKAGE_BYTES);
  const packageRecord = validateEvaluationCalibrationPackage(
    parseJsonBytes(packageBytes, "calibration package")
  );
  const componentBytes = new Map<string, Uint8Array>();
  for (const component of packageRecord.components) {
    const bytes = checkedFile(input.projectRoot, component.path, MAX_COMPONENT_BYTES);
    if (bytes.byteLength !== component.byte_length || sha256Bytes(bytes) !== component.sha256) {
      throw new Error(`calibration component '${component.component_id}' digest drifted`);
    }
    componentBytes.set(component.component_id, bytes);
  }
  const cohort = validateEvaluationCalibrationCohort(componentRecord(componentBytes, "cohort"));
  const schedule = validateEvaluationCalibrationSchedule(
    componentRecord(componentBytes, "schedule")
  );
  validateEvaluationCalibrationContaminationFingerprintManifest(
    componentRecord(componentBytes, "contamination")
  );
  if (
    cohort.cohort_id !== packageRecord.cohort_id ||
    schedule.package_id !== packageRecord.package_id ||
    schedule.schedule_id !== packageRecord.schedule_id ||
    cohort.tasks.some((task) => task.skill !== packageRecord.skill)
  ) {
    throw new Error("calibration package, cohort, schedule, or skill identity drifted");
  }
  exactReusePolicy(cohort.reuse_policy, "calibration cohort reuse policy");
  exactReusePolicy(schedule.reuse_policy, "calibration schedule reuse policy");
  const exactInputBytes = new Map<string, Uint8Array>();
  for (const task of cohort.tasks) {
    for (const binding of task.exact_inputs) {
      const component = packageRecord.components.find(
        (candidate) =>
          candidate.path === binding.source_path &&
          candidate.sha256 === binding.sha256 &&
          candidate.byte_length === binding.byte_length
      );
      if (component === undefined) {
        throw new Error(`calibration exact input '${binding.artifact_id}' is not package-bound`);
      }
      const bytes = componentBytes.get(component.component_id);
      if (bytes === undefined) throw new Error("bound calibration input bytes are absent");
      exactInputBytes.set(binding.artifact_id, bytes);
    }
    validateEvaluationCalibrationTask(task, exactInputBytes);
  }
  const expectedPairs = new Set(
    schedule.task_arm_pairs.map((pair) => `${pair.task_id}\u0000${pair.arm_id}`)
  );
  if (
    expectedPairs.size !== schedule.task_arm_pairs.length ||
    schedule.task_arm_pairs.some(
      (pair) => !cohort.tasks.some((task) => task.task_id === pair.task_id)
    )
  ) {
    throw new Error("calibration schedule task-arm bindings are duplicate or foreign");
  }
  const oracleBundle = componentRecord(componentBytes, "oracles");
  const oracleItems = asArray(oracleBundle.items, "calibration oracle items").map((value) =>
    asRecord(value, "calibration oracle item")
  );
  const q4Bundle = componentRecord(componentBytes, "oracle-review-packets");
  if (q4Bundle.candidate_output_consumed !== false) {
    throw new Error("calibration Q4 bundle consumed candidate output");
  }
  const q4Packets = asArray(q4Bundle.packets, "calibration Q4 packets").map((value) =>
    asRecord(value, "calibration Q4 packet")
  );
  const controls = componentRecord(componentBytes, "semantic-judge-controls");
  const controlItems = asArray(controls.controls, "calibration semantic controls");
  for (const control of controlItems) validateEvaluationCalibrationSemanticJudgeControl(control);
  if (controlItems.length !== cohort.tasks.length * 5) {
    throw new Error("calibration semantic controls do not cover five cases per task");
  }
  const semanticTaskOverrides = new Map<string, PlanSemanticRequestProjectionV1>();
  if (packageRecord.skill === "plan") {
    const bundle = componentRecord(componentBytes, "authorized-semantic-evidence-projections");
    exactReusePolicy(bundle.reuse_policy, "authorized semantic evidence reuse policy");
    if (
      bundle.schema_id !== "penny.plan-calibration-authorized-semantic-evidence-projections.v1" ||
      bundle.schema_version !== 1 ||
      bundle.package_id !== packageRecord.package_id ||
      bundle.candidate_output_consumed !== false ||
      bundle.source_metadata_visible_to_semantic_review !== false
    ) {
      throw new Error("authorized Plan semantic evidence projection bundle drifted");
    }
    for (const itemValue of asArray(bundle.projections, "authorized semantic projections")) {
      const item = asRecord(itemValue, "authorized semantic projection item");
      const admission = validateContract(
        PlanCalibrationSourceAdmissionV1Schema,
        item.source_admission,
        "Plan calibration source admission"
      );
      const projection = validateContract(
        AuthorizedPlanSemanticEvidenceProjectionV1Schema,
        item.projection,
        "authorized Plan semantic evidence projection"
      );
      const task = cohort.tasks.find((candidate) => candidate.task_id === projection.task_id);
      const binding = task?.exact_inputs.find(
        (candidate) => candidate.artifact_id === admission.artifact_id
      );
      const component = packageRecord.components.find(
        (candidate) => candidate.path === binding?.source_path
      );
      const sourceBytes =
        component === undefined ? undefined : componentBytes.get(component.component_id);
      if (
        item.candidate_output_consumed !== false ||
        task === undefined ||
        binding === undefined ||
        sourceBytes === undefined ||
        canonicalJson(item.visible_to_semantic_review) !== canonicalJson(projection.request)
      ) {
        throw new Error("authorized Plan semantic evidence projection binding drifted");
      }
      const reproduced = projectAuthorizedPlanCalibrationSemanticEvidenceV1({
        task,
        admission,
        source_bytes: sourceBytes,
        semantic_request: item.visible_to_semantic_review,
      });
      if (canonicalJson(reproduced) !== canonicalJson(projection)) {
        throw new Error("authorized Plan semantic evidence projection is not reproducible");
      }
      semanticTaskOverrides.set(task.task_id, projection.request);
    }
  }
  for (const task of cohort.tasks) {
    const oracleItem = oracleItems.find((item) => item.oracle_item_id === task.oracle.item_id);
    if (
      oracleItem === undefined ||
      calibrationCanonicalSha256(oracleItem) !== task.oracle.sha256 ||
      oracleItem.task_id !== task.task_id ||
      oracleItem.variant !== "ordinary"
    ) {
      throw new Error(`calibration task '${task.task_id}' ordinary oracle binding drifted`);
    }
  }
  if (q4Packets.length !== oracleItems.length) {
    throw new Error("calibration Q4 packet count does not exactly cover every oracle variant");
  }
  for (const item of q4Packets) {
    if (item.candidate_output_present !== false) {
      throw new Error("calibration Q4 packet contains candidate output");
    }
    const packet = validateSemanticReviewPacketV1({
      value: item.packet,
      reviewKind: "oracle",
      canonicalClauseIds: Q4_ORACLE_REVIEW_CLAUSE_IDS,
    });
    if (calibrationCanonicalSha256(packet) !== item.packet_sha256) {
      throw new Error("calibration Q4 packet digest drifted");
    }
  }
  return {
    package: packageRecord,
    cohort,
    schedule,
    scheduleSha256: calibrationCanonicalSha256(schedule),
    componentBytes,
    oracleItems,
    q4Packets,
    semanticTaskOverrides,
  };
}

function registrations(skill: "decide" | "plan"): CalibrationRegistrationsV1 {
  return skill === "decide"
    ? {
        baseline: DIRECT_DECIDE_DEMETRI_BASELINE_REGISTRATION,
        candidates: DECIDE_EVALUATION_CANDIDATE_REGISTRY,
        ablations: DECIDE_EVALUATION_ABLATION_REGISTRY,
      }
    : {
        baseline: DIRECT_PIPER_PLAN_BASELINE_REGISTRATION,
        candidates: PLAN_EVALUATION_CANDIDATE_REGISTRY,
        ablations: PLAN_EVALUATION_ABLATION_REGISTRY,
      };
}

function registeredArm(
  arm: EvaluationCalibrationScheduleV1["arms"][number],
  values: CalibrationRegistrationsV1
): PlaybookRegistrationV1 {
  if (arm.arm_kind === "direct_baseline") return values.baseline;
  const registry = arm.arm_kind === "candidate" ? values.candidates : values.ablations;
  const registration = registry.get(arm.arm_id);
  if (registration === undefined) throw new Error(`calibration arm '${arm.arm_id}' is unavailable`);
  return registration;
}

function assertCurrentRegistrations(input: {
  readonly projectRoot: string;
  readonly loaded: LoadedCalibrationPackageV1;
  readonly registrations: CalibrationRegistrationsV1;
}): void {
  for (const arm of input.loaded.schedule.arms) {
    const registration = registeredArm(arm, input.registrations);
    const digest =
      arm.arm_kind === "direct_baseline"
        ? directBaselineDefinition(registration, input.projectRoot).definition_sha256
        : skillContractSha256(registration.contract);
    if (registration.name !== arm.arm_id || digest !== arm.binding_sha256) {
      throw new Error(`calibration arm '${arm.arm_id}' registration is stale`);
    }
    if (registration.worker.kind !== "catalog-agent") {
      throw new Error(`calibration arm '${arm.arm_id}' is not a catalog-agent registration`);
    }
    for (const descriptor of registration.worker.phases.values()) {
      if (arm.arm_kind === "candidate") {
        if (descriptor.allowed_tools !== undefined) {
          throw new Error(
            `calibration candidate arm '${arm.arm_id}' must preserve ordinary exact-YAML authority`
          );
        }
      } else if (canonicalJson(descriptor.allowed_tools) !== canonicalJson(["artifact_read"])) {
        throw new Error(
          `calibration evaluation-only arm '${arm.arm_id}' must use the artifact_read strict subset`
        );
      }
    }
  }
}

function oracleItem(value: Readonly<Record<string, unknown>>): OracleBundleItemV1 {
  return {
    oracle_item_id: asString(value.oracle_item_id, "oracle item ID"),
    task_id: asString(value.task_id, "oracle task ID"),
    variant: asString(value.variant, "oracle variant"),
    oracle: value.oracle,
    derivation: asRecord(value.derivation, "oracle derivation"),
    contamination_attestation: asRecord(
      value.contamination_attestation,
      "oracle contamination attestation"
    ),
  };
}

function taskAndGrading(loaded: LoadedCalibrationPackageV1): {
  readonly tasks: readonly EvaluationPopulationTaskV1[];
  readonly grading: EvaluationGradingDefinitionV1;
  readonly commonWire: EvaluationCommonWireValidatorV1;
  readonly buildTrialPacket: Parameters<
    typeof createEvaluationSemanticReviewCoordinator
  >[0]["buildTrialPacket"];
  readonly buildOraclePacket: Parameters<
    typeof createEvaluationSemanticReviewCoordinator
  >[0]["buildOraclePacket"];
  readonly clauseIds: readonly string[];
} {
  const tasks = loaded.cohort.tasks.map((task) => ({
    task_id: task.task_id,
    domain: task.domain,
    trigger_expected: false,
    goal: task.runtime_task.goal,
    constraints: task.runtime_task.constraints,
    exact_input_artifact_ids: task.runtime_task.exact_input_artifact_ids,
    grader_case_id: `${task.task_id}-c6-semantic-grader`,
  }));
  const semanticRequest = (task: EvaluationPopulationTaskV1) =>
    loaded.semanticTaskOverrides.get(task.task_id);
  const q4ByTask = new Map(
    loaded.q4Packets
      .filter((item) => item.variant === "ordinary")
      .map((item) => [asString(item.task_id, "Q4 task ID"), item.packet] as const)
  );
  if (loaded.package.skill === "decide") {
    const bindings = loaded.cohort.tasks.map((task) => {
      const source = loaded.oracleItems.find((item) => item.oracle_item_id === task.oracle.item_id);
      if (source === undefined) throw new Error(`Decide oracle '${task.oracle.item_id}' is absent`);
      return {
        descriptor: decisionSemanticV3GraderDescriptor({
          graderCaseId: `${task.task_id}-c6-semantic-grader`,
          protectedCapability: false,
          oracle: validateContract(
            DecideSemanticGraderOracleV3Schema,
            source.oracle,
            "C6 Decide semantic oracle"
          ),
        }),
        implementation: DECIDE_SEMANTIC_V3_GRADER_IMPLEMENTATION,
      };
    });
    const grading = createDecisionSemanticV3GradingDefinition({ graders: bindings });
    return {
      tasks,
      grading,
      commonWire: validateDecideSemanticV3CommonWire,
      clauseIds: DECIDE_SEMANTIC_CLAUSE_IDS,
      buildTrialPacket: ({ task, wire_bytes, grader }) =>
        buildDecisionSemanticTrialReviewPacketV3({
          wireBytes: wire_bytes,
          task,
          descriptor: grader,
        }),
      buildOraclePacket: ({ task, grader }) => {
        const source = oracleItem(
          loaded.oracleItems.find(
            (item) => item.task_id === task.task_id && item.variant === "ordinary"
          ) ??
            (() => {
              throw new Error(`Decide oracle for '${task.task_id}' is absent`);
            })()
        );
        const built = buildDecisionSemanticOracleReviewPacketV3({
          task,
          descriptor: grader,
          derivationAttestation: {
            schema_version: 1,
            derivation_method: "host_derived_from_permitted_request_basis",
            sealing_control: "oracle_projection_sealed_before_trial_output_review",
          },
          contaminationAttestation: {
            schema_version: 1,
            contamination_result: "no_trial_output_or_identity_material",
            isolation_control: "host_only_oracle_projection_without_arm_mapping",
          },
        });
        const frozen = q4ByTask.get(source.task_id);
        if (frozen === undefined || canonicalJson(built) !== canonicalJson(frozen)) {
          throw new Error(`Decide Q4 packet for '${task.task_id}' drifted from the frozen package`);
        }
        return built;
      },
    };
  }
  const bindings = loaded.cohort.tasks.map((task) => {
    const source = loaded.oracleItems.find((item) => item.oracle_item_id === task.oracle.item_id);
    if (source === undefined) throw new Error(`Plan oracle '${task.oracle.item_id}' is absent`);
    return {
      descriptor: planSemanticV2GraderDescriptor({
        graderCaseId: `${task.task_id}-c6-semantic-grader`,
        protectedCapability: false,
        oracle: validateContract(
          PlanSemanticGraderOracleV2Schema,
          source.oracle,
          "C6 Plan semantic oracle"
        ),
      }),
      implementation: PLAN_SEMANTIC_V2_GRADER_IMPLEMENTATION,
    };
  });
  const grading = createPlanSemanticV2GradingDefinition({ graders: bindings });
  return {
    tasks,
    grading,
    commonWire: validatePlanSemanticV2CommonWire,
    clauseIds: PLAN_SEMANTIC_CLAUSE_IDS,
    buildTrialPacket: ({ task, wire_bytes, grader }) => {
      const request = semanticRequest(task);
      return buildPlanSemanticTrialReviewPacketV2({
        wireBytes: wire_bytes,
        task,
        descriptor: grader,
        ...(request === undefined ? {} : { semanticRequest: request }),
      });
    },
    buildOraclePacket: ({ task, grader }) => {
      const frozen = q4ByTask.get(task.task_id);
      const request = semanticRequest(task);
      const built = buildPlanSemanticOracleReviewPacketV2({
        task,
        descriptor: grader,
        ...(request === undefined ? {} : { semanticRequest: request }),
        derivationAttestation: {
          schema_version: 1,
          derivation_method: "host_derived_from_permitted_request_basis",
          sealing_control: "oracle_projection_sealed_before_trial_output_review",
        },
        contaminationAttestation: {
          schema_version: 1,
          contamination_result: "no_trial_output_or_identity_material",
          isolation_control: "host_only_oracle_projection_without_arm_mapping",
        },
      });
      if (frozen === undefined || canonicalJson(built) !== canonicalJson(frozen)) {
        throw new Error(`Plan Q4 packet for '${task.task_id}' drifted from the frozen package`);
      }
      return built;
    },
  };
}

function authorizedFleetManifest(value: unknown): AuthorizedFleetManifestV1 {
  const manifest = validateEvaluationLiveCalibrationAuthorizationManifest(value);
  if (
    manifest.execution_fleet === undefined ||
    manifest.execution_fleet.length === 0 ||
    manifest.judge_rates === undefined ||
    manifest.limits.max_execution_calls_per_trial === undefined ||
    manifest.limits.max_execution_turns_per_trial === undefined
  ) {
    throw new Error("remote calibration requires a fleet-aware authorization manifest");
  }
  return {
    ...manifest,
    execution_fleet: manifest.execution_fleet,
    judge_rates: manifest.judge_rates,
    limits: {
      ...manifest.limits,
      max_execution_calls_per_trial: manifest.limits.max_execution_calls_per_trial,
      max_execution_turns_per_trial: manifest.limits.max_execution_turns_per_trial,
    },
  };
}

function exactTimestamp(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error(`${label} is not a canonical UTC timestamp`);
  }
  return parsed;
}

async function verifyApprovalProof(input: {
  readonly manifest: AuthorizedFleetManifestV1;
  readonly approval: unknown;
  readonly verifier: EvaluationOperatorApprovalVerifierV1;
  readonly now: Date;
}): Promise<EvaluationLiveCalibrationApprovalReceiptV1> {
  const approval = validateEvaluationLiveCalibrationApprovalReceipt(input.approval);
  const manifestCanonical = canonicalJson(input.manifest);
  const approvalCanonical = canonicalJson(approval);
  const manifestSha256 = sha256(manifestCanonical);
  const approvalSha256 = sha256(approvalCanonical);
  if (
    approval.scope !== input.manifest.scope ||
    approval.manifest_sha256 !== manifestSha256 ||
    approval.nonce !== input.manifest.nonce
  ) {
    throw new Error("remote calibration approval does not bind the exact manifest");
  }
  const now = input.now.getTime();
  const notBefore = exactTimestamp(input.manifest.validity.not_before, "manifest not_before");
  const manifestExpiry = exactTimestamp(input.manifest.validity.expires_at, "manifest expires_at");
  const issued = exactTimestamp(approval.issued_at, "approval issued_at");
  const approvalExpiry = exactTimestamp(approval.expires_at, "approval expires_at");
  if (
    now < notBefore ||
    now > manifestExpiry ||
    now < issued ||
    now > approvalExpiry ||
    issued < notBefore ||
    approvalExpiry > manifestExpiry
  ) {
    throw new Error("remote calibration approval is not currently valid");
  }
  const verified = await input.verifier.verify({
    manifest: input.manifest,
    manifest_canonical_json: manifestCanonical,
    manifest_sha256: manifestSha256,
    approval,
    approval_canonical_json: approvalCanonical,
    approval_sha256: approvalSha256,
  });
  if (verified.owner_id !== approval.owner_id || verified.verification_id.trim().length === 0) {
    throw new Error("remote calibration owner proof verification failed");
  }
  return approval;
}

function frontmatterValue(bytes: string, key: string): string | undefined {
  const match = bytes.match(/^---\r?\n([\s\S]*?)\r?\n---/u);
  const line = (match?.[1] ?? "")
    .split(/\r?\n/u)
    .find((candidate) => candidate.startsWith(`${key}:`));
  const value = line?.slice(line.indexOf(":") + 1).trim();
  return value === undefined || value.length === 0 ? undefined : value;
}

function requiredAgents(values: CalibrationRegistrationsV1): readonly string[] {
  return [values.baseline, ...values.candidates.values(), ...values.ablations.values()]
    .flatMap((registration) => [...registration.worker.phases.values()].map((phase) => phase.agent))
    .filter((agent, index, all) => all.indexOf(agent) === index)
    .sort((left, right) => left.localeCompare(right));
}

function modelRates(model: Model<Api>): EvaluationRuntimeBindingV1["rates"] {
  return {
    input_usd_per_million_tokens: model.cost.input,
    output_usd_per_million_tokens: model.cost.output,
    cache_read_usd_per_million_tokens: model.cost.cacheRead,
    cache_write_usd_per_million_tokens: model.cost.cacheWrite,
  };
}

function modelOrigin(model: Model<Api>): string {
  let url: URL;
  try {
    url = new URL(model.baseUrl);
  } catch (cause) {
    throw new Error("configured model base URL is invalid", { cause });
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username.length > 0 ||
    url.password.length > 0
  ) {
    throw new Error("configured model endpoint must be credential-free HTTP(S)");
  }
  return url.origin;
}

async function defaultDependencies(): Promise<RemoteCalibrationDependenciesV1> {
  return {
    createCatalog: async () => {
      const runtime = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(),
        allowModelNetwork: false,
        refreshOnCreate: false,
      });
      await runtime.refresh({ allowNetwork: false });
      return runtime;
    },
    now: () => new Date(),
    monotonicNow: () => performance.now(),
  };
}

function runtimeBindingDigest(input: {
  readonly loaded: LoadedCalibrationPackageV1;
  readonly manifest: AuthorizedFleetManifestV1;
  readonly grading: EvaluationGradingDefinitionV1;
  readonly projectRoot: string;
}): string {
  const registrationValues = registrations(input.loaded.package.skill);
  const guidancePaths = input.loaded.schedule.arms.flatMap((arm) => {
    const registration = registeredArm(arm, registrationValues);
    if (registration.worker.kind !== "catalog-agent") {
      throw new Error(`calibration arm '${arm.arm_id}' is not a catalog-agent registration`);
    }
    return [...registration.worker.phases.entries()].map(([stateId, phase]) => {
      const file =
        registration.worker.guidance.resolution === "per_agent_phase"
          ? `${phase.agent}-${stateId}.md`
          : `${phase.agent}.md`;
      return path.posix.join(registration.worker.guidance.skill_root, file);
    });
  });
  const sourcePaths = [
    ...new Set([
      ...requiredAgents(registrationValues).map((agent) => `.pi/agents/${agent}.md`),
      ...guidancePaths,
      ".pi/extensions/artifacts/artifact-runtime.ts",
      ".pi/extensions/skill/evaluation-calibration-package.ts",
      ".pi/extensions/skill/evaluation-contracts.ts",
      ".pi/extensions/skill/evaluation-local-live.ts",
      ".pi/extensions/skill/evaluation-remote-calibration.ts",
      ".pi/extensions/skill/evaluation-runner.ts",
      ".pi/extensions/skill/evaluation-semantic-projections.ts",
      ".pi/extensions/skill/evaluation-semantic-review.ts",
      `.pi/extensions/skill/${input.loaded.package.skill}-evaluation.ts`,
      "apps/orchestration/src/artifact-store.ts",
      "apps/orchestration/src/checkpointer.ts",
      "apps/orchestration/src/contracts.ts",
      "apps/orchestration/src/engine.ts",
      "apps/orchestration/src/model-client.ts",
      "apps/orchestration/src/service.ts",
      "apps/orchestration/src/worker.ts",
    ]),
  ].sort((left, right) => left.localeCompare(right));
  const files = sourcePaths.map((relative) => {
    const bytes = checkedFile(input.projectRoot, relative, MAX_COMPONENT_BYTES);
    return { path: relative, byte_length: bytes.byteLength, sha256: sha256Bytes(bytes) };
  });
  return sha256(
    canonicalJson({
      schema_version: 1,
      package_sha256: input.loaded.package.package_sha256,
      schedule_sha256: input.loaded.scheduleSha256,
      arms: input.loaded.schedule.arms,
      execution_fleet: input.manifest.execution_fleet,
      judge_binding: input.manifest.judge_binding,
      judge_rates: input.manifest.judge_rates,
      grading_sha256: evaluationGradingDefinitionSha256(input.grading),
      files,
    })
  );
}

function scheduleEntries(input: {
  readonly loaded: LoadedCalibrationPackageV1;
  readonly repetitions: number;
}): readonly PairedEvaluationScheduleEntryV1[] {
  const armById = new Map(input.loaded.schedule.arms.map((arm) => [arm.arm_id, arm]));
  const entries: PairedEvaluationScheduleEntryV1[] = [];
  for (let repetition = 1; repetition <= input.repetitions; repetition += 1) {
    for (const pair of input.loaded.schedule.task_arm_pairs) {
      const arm = armById.get(pair.arm_id);
      if (arm === undefined) throw new Error(`scheduled arm '${pair.arm_id}' is absent`);
      const pairId = `evalpair_${sha256(
        canonicalJson({
          package_sha256: input.loaded.package.package_sha256,
          schedule_sha256: input.loaded.scheduleSha256,
          task_id: pair.task_id,
          repetition,
          split: "calibration",
          scoring: "non_scoring",
        })
      )}`;
      const identity = {
        pair_id: pairId,
        task_id: pair.task_id,
        repetition,
        variant_name: arm.arm_id,
        binding_sha256: arm.binding_sha256,
      };
      entries.push(
        validateContract(
          PairedEvaluationScheduleEntryV1Schema,
          {
            trial_id: `evaltrial_${sha256(canonicalJson(identity))}`,
            pair_id: pairId,
            ordinal: entries.length,
            task_id: pair.task_id,
            repetition,
            variant:
              arm.arm_kind === "direct_baseline"
                ? "baseline"
                : arm.arm_kind === "candidate"
                  ? "candidate"
                  : "ablation",
            variant_name: arm.arm_id,
            binding_sha256: arm.binding_sha256,
          },
          "remote calibration schedule entry"
        )
      );
    }
  }
  return entries;
}

function internalPlan(input: {
  readonly projectRoot: string;
  readonly loaded: LoadedCalibrationPackageV1;
  readonly manifest: AuthorizedFleetManifestV1;
  readonly grading: EvaluationGradingDefinitionV1;
  readonly registrations: CalibrationRegistrationsV1;
  readonly tasks: readonly EvaluationPopulationTaskV1[];
  readonly runtimeBindingSha256: string;
}): { readonly plan: PairedEvaluationPlanV1; readonly frozen: FrozenPairedEvaluationV1 } {
  if (input.manifest.limits.repetitions > 32) {
    throw new Error("remote calibration repetitions exceed the canonical executor bound");
  }
  const candidate = input.loaded.schedule.arms.find((arm) => arm.arm_kind === "candidate");
  const ablations = input.loaded.schedule.arms.filter((arm) => arm.arm_kind === "ablation");
  if (candidate === undefined) throw new Error("calibration schedule has no candidate arm");
  const baseline = directBaselineDefinition(input.registrations.baseline, input.projectRoot);
  const populationSha256 = sha256(
    canonicalJson({
      schema_version: 1,
      split: "calibration",
      scoring: "non_scoring",
      cohort_id: input.loaded.cohort.cohort_id,
      revision: input.loaded.cohort.revision,
      tasks: input.tasks,
    })
  );
  const rates = input.manifest.execution_fleet[0]?.rates;
  if (rates === undefined) throw new Error("remote calibration fleet has no rate card");
  const plan = validateContract(
    PairedEvaluationPlanV1Schema,
    {
      schema_version: 1,
      plan_id: `${input.loaded.package.package_id}-remote-live-v1`,
      purpose: "harness_self_test",
      candidate: { name: candidate.arm_id, contract_sha256: candidate.binding_sha256 },
      population: {
        population_id: input.loaded.cohort.cohort_id,
        revision: input.loaded.cohort.revision,
        sha256: populationSha256,
      },
      baseline,
      ablations: ablations.map((arm) => ({
        name: arm.arm_id,
        contract_sha256: arm.binding_sha256,
      })),
      repetitions: input.manifest.limits.repetitions,
      runtime_binding: { ...input.manifest.execution_binding, rates },
      budget_policy_sha256: baseline.liveness_policy_sha256,
      grader_registry_sha256: evaluationGradingDefinitionSha256(input.grading),
      implementation_binding_sha256: input.runtimeBindingSha256,
      pair_order_seed: `${input.loaded.package.package_id}-calibration-order-v1`,
      primary_metric: "task_score",
      material_effect_threshold: 0,
      protected_capability_floor: 0,
      trigger_precision_floor: 0,
      negative_transfer_ceiling: null,
      comparison_validity_policy: {
        baseline_normalized_completion_floor: 1,
        candidate_normalized_completion_floor: 1,
        nonzero_candidate_complete_pair_coverage_floor: 1,
        require_all_scheduled_trials_complete: true,
        required_comparator_normalized_completion_floors: ablations.map((arm) => ({
          comparator_name: arm.arm_id,
          normalized_completion_floor: 1,
        })),
        readiness_preflight: {
          required: false,
          calibration_split: "calibration",
          scoring: "non_scoring",
          arm_coverage: "every_arm",
          validate_state_root: true,
          validate_output_normalization: true,
          validate_oracle_isolation: true,
          validate_common_wire: true,
        },
      },
      cost_latency_policy: {
        max_candidate_to_baseline_cost_ratio: Number.MAX_SAFE_INTEGER,
        max_candidate_to_baseline_latency_ratio: Number.MAX_SAFE_INTEGER,
      },
      ablation_policies: ablations.map((arm) => ({
        ablation_name: arm.arm_id,
        candidate_minus_ablation_primary_floor: -1,
      })),
      mutation_gate: null,
      failure_rule: {
        task_score: 0,
        trigger_predicted: false,
        protected_capability_score: 0,
        cost_microusd: 0,
        latency_ms: 0,
      },
      deterministic_disposition_rule: { on_pass: "CANDIDATE", on_fail: "NO_BUILD" },
    },
    "remote calibration internal executor plan"
  );
  const entries = scheduleEntries({
    loaded: input.loaded,
    repetitions: input.manifest.limits.repetitions,
  });
  const planSha256 = sha256(canonicalJson(plan));
  const frozen: FrozenPairedEvaluationV1 = {
    schema_version: 1,
    plan_id: plan.plan_id,
    plan_sha256: planSha256,
    population_id: input.loaded.cohort.cohort_id,
    population_revision: input.loaded.cohort.revision,
    population_sha256: populationSha256,
    candidate_name: candidate.arm_id,
    candidate_contract_sha256: candidate.binding_sha256,
    baseline_definition_sha256: baseline.definition_sha256,
    budget_policy_sha256: baseline.liveness_policy_sha256,
    grader_registry_sha256: plan.grader_registry_sha256,
    implementation_binding_sha256: input.runtimeBindingSha256,
    schedule_sha256: sha256(canonicalJson(entries)),
    schedule: [...entries],
  };
  return { plan, frozen };
}

function expectedProviderCalls(input: {
  readonly loaded: LoadedCalibrationPackageV1;
  readonly manifest: AuthorizedFleetManifestV1;
}): number {
  const trials =
    input.loaded.schedule.accounting.scheduled_task_arm_pair_count *
    input.manifest.limits.repetitions;
  return (
    trials * input.manifest.limits.max_execution_calls_per_trial +
    trials +
    input.loaded.q4Packets.length
  );
}

function assertAuthorizationPackageBinding(input: {
  readonly loaded: LoadedCalibrationPackageV1;
  readonly manifest: AuthorizedFleetManifestV1;
  readonly confirmedPackageSha256: string;
  readonly confirmedMaxSpendMicrousd: number;
}): void {
  const manifest = input.manifest;
  if (
    input.confirmedPackageSha256 !== input.loaded.package.package_sha256 ||
    manifest.calibration.package_id !== input.loaded.package.package_id ||
    manifest.calibration.package_sha256 !== input.loaded.package.package_sha256 ||
    manifest.calibration.schedule_sha256 !== input.loaded.scheduleSha256 ||
    canonicalJson(manifest.calibration.arms) !==
      canonicalJson(
        input.loaded.schedule.arms
          .map((arm) => ({ arm_id: arm.arm_id, binding_sha256: arm.binding_sha256 }))
          .sort((left, right) => left.arm_id.localeCompare(right.arm_id))
      )
  ) {
    throw new Error("remote calibration confirmation or authorization package binding drifted");
  }
  if (
    !Number.isSafeInteger(input.confirmedMaxSpendMicrousd) ||
    input.confirmedMaxSpendMicrousd !== manifest.limits.max_spend_microusd
  ) {
    throw new Error("remote calibration spend confirmation is absent or inexact");
  }
  if (expectedProviderCalls({ loaded: input.loaded, manifest }) > manifest.limits.max_calls) {
    throw new Error("remote calibration authorized call ceiling is below the frozen worst case");
  }
  const maxRate = Math.max(
    ...manifest.execution_fleet.flatMap((entry) => Object.values(entry.rates)),
    ...Object.values(manifest.judge_rates)
  );
  const maximumSpend = Math.ceil(manifest.limits.max_total_tokens * maxRate);
  if (maximumSpend > manifest.limits.max_spend_microusd) {
    throw new Error("remote calibration token ceiling can exceed the authorized spend ceiling");
  }
}

async function resolveAuthorizedModels(input: {
  readonly projectRoot: string;
  readonly registrations: CalibrationRegistrationsV1;
  readonly manifest: AuthorizedFleetManifestV1;
  readonly catalog: RemoteCalibrationModelCatalogV1;
}): Promise<{ readonly models: ReadonlyMap<string, Model<Api>>; readonly judge: Model<Api> }> {
  const agents = requiredAgents(input.registrations);
  const fleetAgents = input.manifest.execution_fleet.map((entry) => entry.agent);
  if (
    input.manifest.execution_binding.runtime !== REMOTE_CALIBRATION_RUNTIME_ID ||
    input.manifest.judge_binding.runtime !== REMOTE_CALIBRATION_RUNTIME_ID ||
    input.manifest.execution_fleet.some((entry) => entry.runtime !== REMOTE_CALIBRATION_RUNTIME_ID)
  ) {
    throw new Error("remote calibration runtime identity drifted from the executable path");
  }
  if (
    !input.manifest.execution_fleet.some(
      (entry) =>
        entry.provider === input.manifest.execution_binding.provider &&
        entry.model === input.manifest.execution_binding.model &&
        entry.thinking_level === input.manifest.execution_binding.thinking_level
    )
  ) {
    throw new Error("remote calibration compatibility execution binding is absent from the fleet");
  }
  if (canonicalJson(agents) !== canonicalJson(fleetAgents)) {
    throw new Error("remote calibration fleet does not exactly cover registered execution roles");
  }
  const models = new Map<string, Model<Api>>();
  for (const entry of input.manifest.execution_fleet) {
    const agentPath = `.pi/agents/${entry.agent}.md`;
    const agentDoc = checkedFile(input.projectRoot, agentPath, 1_048_576).toString("utf8");
    if (
      ssotModel(agentDoc) !== entry.ssot_model ||
      frontmatterValue(agentDoc, "provider") !== entry.provider ||
      frontmatterValue(agentDoc, "thinking") !== entry.thinking_level
    ) {
      throw new Error(`remote calibration fleet entry '${entry.agent}' drifted from agent SSOT`);
    }
    const model = input.catalog.getModel(entry.provider, entry.model);
    if (
      model === undefined ||
      model.provider !== entry.provider ||
      model.id !== entry.model ||
      modelOrigin(model) !== entry.allowed_origin ||
      !input.manifest.egress.allowed_origins.includes(entry.allowed_origin) ||
      canonicalJson(modelRates(model)) !== canonicalJson(entry.rates)
    ) {
      throw new Error(`remote calibration fleet model '${entry.agent}' is unavailable or stale`);
    }
    models.set(entry.agent, model);
  }
  const judgeBinding = input.manifest.judge_binding;
  const judge = input.catalog.getModel(judgeBinding.provider, judgeBinding.model);
  if (
    judge === undefined ||
    judge.provider !== judgeBinding.provider ||
    judge.id !== judgeBinding.model ||
    !input.manifest.egress.allowed_origins.includes(modelOrigin(judge)) ||
    canonicalJson(modelRates(judge)) !== canonicalJson(input.manifest.judge_rates)
  ) {
    throw new Error("remote calibration judge model or rate card is unavailable or stale");
  }
  return { models, judge };
}

export async function preflightRemoteCalibrationPackageV1(input: {
  readonly projectRoot: string;
  readonly packagePath: string;
  readonly manifest: unknown;
  readonly approval: unknown;
  readonly ownerVerifier: EvaluationOperatorApprovalVerifierV1;
  readonly confirmedPackageSha256: string;
  readonly confirmedMaxSpendMicrousd: number;
  readonly dependencies?: RemoteCalibrationDependenciesV1;
}): Promise<RemoteCalibrationPreflightV1> {
  const dependencies = input.dependencies ?? (await defaultDependencies());
  const loaded = loadCalibrationPackageV1({
    projectRoot: input.projectRoot,
    packagePath: input.packagePath,
  });
  const manifest = authorizedFleetManifest(input.manifest);
  assertAuthorizationPackageBinding({
    loaded,
    manifest,
    confirmedPackageSha256: input.confirmedPackageSha256,
    confirmedMaxSpendMicrousd: input.confirmedMaxSpendMicrousd,
  });
  const approval = await verifyApprovalProof({
    manifest,
    approval: input.approval,
    verifier: input.ownerVerifier,
    now: dependencies.now(),
  });
  const registrationValues = registrations(loaded.package.skill);
  assertCurrentRegistrations({
    projectRoot: input.projectRoot,
    loaded,
    registrations: registrationValues,
  });
  const grading = taskAndGrading(loaded);
  for (const task of grading.tasks) {
    const grader = grading.grading.descriptor.graders.find(
      (candidate) => candidate.grader_case_id === task.grader_case_id
    );
    if (grader === undefined) {
      throw new Error(`calibration task '${task.task_id}' has no current semantic grader`);
    }
    grading.buildOraclePacket({ task, grader });
  }
  const catalog = await dependencies.createCatalog();
  const resolved = await resolveAuthorizedModels({
    projectRoot: input.projectRoot,
    registrations: registrationValues,
    manifest,
    catalog,
  });
  const runtimeBindingSha256 = runtimeBindingDigest({
    loaded,
    manifest,
    grading: grading.grading,
    projectRoot: input.projectRoot,
  });
  const internal = internalPlan({
    projectRoot: input.projectRoot,
    loaded,
    manifest,
    grading: grading.grading,
    registrations: registrationValues,
    tasks: grading.tasks,
    runtimeBindingSha256,
  });
  const inertExecutor = new GenericEvaluationTrialExecutor({
    projectRoot: input.projectRoot,
    env: {},
    baselineRegistration: registrationValues.baseline,
    candidateRegistry: registrationValues.candidates,
    ablationRegistry: registrationValues.ablations,
    modelClientFactory: (() => {
      throw new Error("provider-free calibration preflight cannot construct a model client");
    }) as EvaluationModelClientFactoryV1,
  });
  const readiness = new RealTopologyEvaluationReadinessPreflight({
    projectRoot: input.projectRoot,
    env: {},
    calibrationCohort: {
      schema_version: 1,
      split: "calibration",
      cohort_id: loaded.cohort.cohort_id,
      revision: loaded.cohort.revision,
      scoring: "non_scoring",
      tasks: loaded.cohort.tasks.map(readinessTaskFromCalibrationTask),
    },
    executor: inertExecutor,
    validateCommonWire: grading.commonWire,
  });
  readiness.validateCalibrationExecutionSchedule({
    taskArmPairs: loaded.schedule.task_arm_pairs,
    armIds: loaded.schedule.arms.map((arm) => arm.arm_id),
  });
  return {
    loaded,
    manifest,
    approval,
    runtimeBindingSha256,
    models: resolved.models,
    judgeModel: resolved.judge,
    gradingDefinition: grading.grading,
    tasks: grading.tasks,
    plan: internal.plan,
    frozen: internal.frozen,
    registrations: registrationValues,
    readiness,
    validateCommonWire: grading.commonWire,
  };
}

class RemoteCalibrationBudget {
  private calls = 0;
  private retries = 0;
  private totalTokens = 0;
  private spendMicrousd = 0;
  private readonly callsByRun = new Map<string, number>();

  constructor(
    private readonly manifest: AuthorizedFleetManifestV1,
    private readonly startedAt: number,
    private readonly monotonicNow: () => number
  ) {}

  assertTime(): void {
    if (this.monotonicNow() - this.startedAt > this.manifest.limits.max_wall_clock_ms) {
      throw new Error("remote calibration wall-clock ceiling is exhausted");
    }
  }

  chargeTurn(runId: string, source: AgentSessionLivenessEventV1 & { kind: "model_turn" }): void {
    this.assertTime();
    const runCalls = (this.callsByRun.get(runId) ?? 0) + 1;
    const retry = source.source !== "turn_start";
    if (
      this.calls + 1 > this.manifest.limits.max_calls ||
      runCalls > this.manifest.limits.max_execution_calls_per_trial ||
      runCalls > this.manifest.limits.max_execution_turns_per_trial ||
      (retry && this.retries + 1 > this.manifest.limits.max_retries)
    ) {
      throw new Error("remote calibration call, turn, or retry ceiling is exhausted");
    }
    this.calls += 1;
    if (retry) this.retries += 1;
    this.callsByRun.set(runId, runCalls);
  }

  chargeJudgeTurn(source: AgentSessionLivenessEventV1 & { kind: "model_turn" }): void {
    this.assertTime();
    const retry = source.source !== "turn_start";
    if (
      this.calls + 1 > this.manifest.limits.max_calls ||
      (retry && this.retries + 1 > this.manifest.limits.max_retries)
    ) {
      throw new Error("remote calibration judge call or retry ceiling is exhausted");
    }
    this.calls += 1;
    if (retry) this.retries += 1;
  }

  chargeTokens(
    rates: EvaluationRuntimeBindingV1["rates"],
    counts: Extract<AgentSessionTraceRecordV1, { kind: "turn" }>["token_counts"]
  ): number {
    const total = this.totalTokens + counts.total;
    const cost = Math.ceil(
      counts.input * rates.input_usd_per_million_tokens +
        counts.output * rates.output_usd_per_million_tokens +
        counts.cache_read * rates.cache_read_usd_per_million_tokens +
        counts.cache_write * rates.cache_write_usd_per_million_tokens
    );
    if (
      counts.input > this.manifest.limits.max_input_tokens ||
      counts.output > this.manifest.limits.max_output_tokens ||
      total > this.manifest.limits.max_total_tokens ||
      this.spendMicrousd + cost > this.manifest.limits.max_spend_microusd
    ) {
      throw new Error("remote calibration token or spend ceiling is exhausted");
    }
    this.totalTokens = total;
    this.spendMicrousd += cost;
    return cost;
  }

  measurement(): { readonly calls: number; readonly spend_microusd: number } {
    return { calls: this.calls, spend_microusd: this.spendMicrousd };
  }
}

function packageJournalPresent(input: {
  readonly state: ReturnType<typeof resolvePennyRuntimeState>;
  readonly packageSha256: string;
}): boolean {
  using artifacts = ArtifactStore.openExisting(input.state.paths.artifacts.root, {
    projectId: input.state.projectId,
  });
  return (
    artifacts.refFor(
      `calibration-package-${input.packageSha256}`,
      "evaluation-calibration",
      null,
      "calibration-package-journal",
      `remote-calibration:${input.packageSha256}`,
      1
    ) !== null
  );
}

function assertTrialJournalAdmissionConsistency(input: {
  readonly projectRoot: string;
  readonly env: NodeJS.ProcessEnv;
  readonly frozen: FrozenPairedEvaluationV1;
  readonly packageJournalPresent: boolean;
}): void {
  if (input.packageJournalPresent) return;
  using journal = new ArtifactEvaluationTrialJournal({
    projectRoot: input.projectRoot,
    env: input.env,
    frozen: input.frozen,
  });
  if (input.frozen.schedule.some((entry) => journal.load(entry).recorded)) {
    throw new Error("remote calibration trial journal exists without its package resume journal");
  }
}

function persistPackageJournal(input: {
  readonly state: ReturnType<typeof resolvePennyRuntimeState>;
  readonly preflight: RemoteCalibrationPreflightV1;
}): void {
  using artifacts = ArtifactStore.openExisting(input.state.paths.artifacts.root, {
    projectId: input.state.projectId,
  });
  const content = canonicalJson({
    schema_version: 1,
    split: "calibration",
    scoring: "non_scoring",
    package_sha256: input.preflight.loaded.package.package_sha256,
    authorization_manifest_sha256: evaluationLiveCalibrationAuthorizationManifestSha256(
      input.preflight.manifest
    ),
    approval_receipt_sha256: evaluationLiveCalibrationApprovalReceiptSha256(
      input.preflight.approval
    ),
    runtime_binding_sha256: input.preflight.runtimeBindingSha256,
  });
  const ref = artifacts.persist({
    metadata: {
      schema_version: 2,
      run_id: `calibration-package-${input.preflight.loaded.package.package_sha256}`,
      phase: "evaluation-calibration",
      branch_id: null,
      kind: "calibration-package-journal",
      operation_id: `remote-calibration:${input.preflight.loaded.package.package_sha256}`,
      version: 1,
      producer: "host:evaluation-remote-calibration",
      media_type: "application/json",
      content_schema: {
        schema_id: "penny.evaluation-remote-calibration-journal.v1",
        schema_version: 1,
      },
      parent_ref: null,
      upstream_refs: [],
    },
    content,
  });
  if (artifacts.read(ref).toString("utf8") !== content) {
    throw new Error("remote calibration package journal failed exact-byte re-read");
  }
}

class FleetMeasuredModelClient implements MeasuredEvaluationModelClientV1 {
  private readonly measurements = new Map<string, EvaluationRuntimeMeasurementV1>();

  constructor(
    readonly runtime_binding: EvaluationRuntimeBindingV1,
    private readonly state: ReturnType<typeof resolvePennyRuntimeState>,
    private readonly preflight: RemoteCalibrationPreflightV1,
    private readonly budget: RemoteCalibrationBudget
  ) {}

  private completedInvocation(identity: string): AgentCompletion | undefined {
    using artifacts = ArtifactStore.openExisting(this.state.paths.artifacts.root, {
      projectId: this.state.projectId,
    });
    const runId = `remote-call-${identity}`;
    const operationId = `remote-provider-call:${identity}`;
    const invoking = artifacts.refFor(
      runId,
      "evaluation-calibration-provider",
      null,
      "remote-provider-call-journal",
      operationId,
      1
    );
    const completed = artifacts.refFor(
      runId,
      "evaluation-calibration-provider",
      null,
      "remote-provider-call-journal",
      operationId,
      2
    );
    if (completed !== null) {
      if (invoking === null) throw new Error("remote provider-call journal has a transition gap");
      const parsed = asRecord(
        parseJsonBytes(artifacts.read(completed), "remote provider-call completion"),
        "remote provider-call completion"
      );
      if (parsed.status !== "completed" || typeof parsed.text !== "string") {
        throw new Error("remote provider-call completion journal is malformed");
      }
      return { text: parsed.text };
    }
    if (invoking !== null) {
      throw new Error(
        "remote provider completion is unknown; exact-journal policy forbids automatic reinvocation"
      );
    }
    return undefined;
  }

  private persistCall(input: {
    readonly identity: string;
    readonly version: 1 | 2;
    readonly content: Readonly<Record<string, JsonValue>>;
  }): void {
    using artifacts = ArtifactStore.openExisting(this.state.paths.artifacts.root, {
      projectId: this.state.projectId,
    });
    const runId = `remote-call-${input.identity}`;
    const operationId = `remote-provider-call:${input.identity}`;
    const parent =
      input.version === 1
        ? null
        : artifacts.refFor(
            runId,
            "evaluation-calibration-provider",
            null,
            "remote-provider-call-journal",
            operationId,
            1
          );
    if (input.version === 2 && parent === null) {
      throw new Error("remote provider-call completion has no invoking parent");
    }
    const content = canonicalJson(input.content);
    const ref = artifacts.persist({
      metadata: {
        schema_version: 2,
        run_id: runId,
        phase: "evaluation-calibration-provider",
        branch_id: null,
        kind: "remote-provider-call-journal",
        operation_id: operationId,
        version: input.version,
        producer: "host:evaluation-remote-calibration",
        media_type: "application/json",
        content_schema: {
          schema_id: "penny.evaluation-remote-provider-call-journal.v1",
          schema_version: 1,
        },
        parent_ref: parent,
        upstream_refs: [],
      },
      content,
    });
    if (artifacts.read(ref).toString("utf8") !== content) {
      throw new Error("remote provider-call journal failed exact-byte re-read");
    }
  }

  async runAgent(invocation: AgentInvocation): Promise<AgentCompletion> {
    const entry = this.preflight.manifest.execution_fleet.find(
      (candidate) => candidate.agent === invocation.agent
    );
    const model = entry === undefined ? undefined : this.preflight.models.get(entry.agent);
    if (entry === undefined || model === undefined) {
      throw new Error(`remote calibration agent '${invocation.agent}' has no fleet binding`);
    }
    const workflow = invocation.workflowSession;
    if (workflow === undefined)
      throw new Error("remote calibration invocation has no workflow identity");
    const identity = sha256(
      canonicalJson({
        authorization_manifest_sha256: evaluationLiveCalibrationAuthorizationManifestSha256(
          this.preflight.manifest
        ),
        run_id: workflow.run_id,
        state_id: invocation.stateId,
        branch_id: workflow.branch_id,
        attempt: workflow.attempt,
        purpose: workflow.purpose,
        agent: invocation.agent,
        provider: entry.provider,
        model: entry.model,
      })
    );
    const resumed = this.completedInvocation(identity);
    if (resumed !== undefined) return resumed;
    this.budget.assertTime();
    this.persistCall({
      identity,
      version: 1,
      content: {
        schema_version: 1,
        status: "invoking",
        identity_sha256: identity,
        split: "calibration",
        scoring: "non_scoring",
      },
    });
    let traceFault: unknown;
    let invocationCost = 0;
    const client = new PiAgentClient({
      catalogSessions: {
        projectId: this.state.projectId,
        root: this.state.paths.subagentSessions,
      },
      resolveModel: (requested) => {
        if (requested !== `${entry.provider}/${entry.model}`) {
          throw new Error("remote calibration refused a non-authorized model identity");
        }
        return model;
      },
      sessionTrace: (record) => {
        if (record.kind !== "turn" || traceFault !== undefined) return;
        try {
          invocationCost += this.budget.chargeTokens(entry.rates, record.token_counts);
        } catch (cause) {
          traceFault = cause;
        }
      },
    });
    const started = performance.now();
    let completion: AgentCompletion;
    try {
      completion = await client.runAgent({
        ...invocation,
        modelOverride: `${entry.provider}/${entry.model}`,
        thinkingLevel: entry.thinking_level,
        liveness: (event) => {
          if (event.kind === "model_turn") this.budget.chargeTurn(workflow.run_id, event);
          invocation.liveness?.(event);
        },
        admitResolvedModel: (resolved) => {
          if (
            resolved.provider !== entry.provider ||
            resolved.model !== entry.model ||
            modelOrigin(model) !== entry.allowed_origin
          ) {
            throw new Error("remote calibration resolved outside its authorized fleet entry");
          }
          invocation.admitResolvedModel?.(resolved);
        },
        session: invocation.session,
      });
    } finally {
      const elapsed = Math.max(1, Math.ceil(performance.now() - started));
      const current = this.measurements.get(workflow.run_id) ?? {
        cost_microusd: 0,
        latency_ms: 0,
        loopback_provider_calls: 0,
      };
      this.measurements.set(workflow.run_id, {
        cost_microusd: current.cost_microusd + invocationCost,
        latency_ms: current.latency_ms + elapsed,
        loopback_provider_calls: (current.loopback_provider_calls ?? 0) + 1,
      });
    }
    if (traceFault !== undefined) {
      throw new Error("remote calibration execution accounting admission failed", {
        cause: traceFault,
      });
    }
    this.persistCall({
      identity,
      version: 2,
      content: {
        schema_version: 1,
        status: "completed",
        identity_sha256: identity,
        text: completion.text,
      },
    });
    return completion;
  }

  measurement(runId: string): EvaluationRuntimeMeasurementV1 {
    return (
      this.measurements.get(runId) ?? {
        cost_microusd: 0,
        latency_ms: 0,
        loopback_provider_calls: 0,
      }
    );
  }
}

interface RemoteCalibrationModelClientFactoryV1 extends EvaluationModelClientFactoryV1 {
  preflightCalibration(frozen: FrozenPairedEvaluationV1): Promise<void>;
}

function remoteModelClientFactory(input: {
  readonly state: ReturnType<typeof resolvePennyRuntimeState>;
  readonly preflight: RemoteCalibrationPreflightV1;
  readonly budget: RemoteCalibrationBudget;
  readonly env: NodeJS.ProcessEnv;
  readonly projectRoot: string;
}): RemoteCalibrationModelClientFactoryV1 {
  let artifactPreflight = false;
  const factory: EvaluationModelClientFactoryV1 = ({ plan }) => {
    if (
      !artifactPreflight ||
      canonicalJson(plan.runtime_binding) !== canonicalJson(input.preflight.plan.runtime_binding)
    ) {
      throw new Error("remote calibration model factory was used before exact preflight");
    }
    return new FleetMeasuredModelClient(
      plan.runtime_binding,
      input.state,
      input.preflight,
      input.budget
    );
  };
  const preflightCalibration = async (frozen: FrozenPairedEvaluationV1): Promise<void> => {
    artifactPreflight = false;
    await preflightLocalLiveArtifactRead({
      projectRoot: input.projectRoot,
      env: input.env,
      processEnv: process.env,
      frozen,
    });
    artifactPreflight = true;
  };
  return Object.assign(factory, { preflightCalibration });
}

function storageBytes(root: string): number {
  if (!existsSync(root)) return 0;
  const stats = lstatSync(root);
  if (stats.isSymbolicLink()) throw new Error("remote calibration storage root contains a symlink");
  if (stats.isFile()) return stats.size;
  let total = 0;
  for (const entry of readFileDirectory(root)) total += storageBytes(path.join(root, entry));
  return total;
}

function readFileDirectory(root: string): readonly string[] {
  return process.getBuiltinModule("node:fs").readdirSync(root);
}

function assertStorageBudget(input: {
  readonly root: string;
  readonly initialBytes: number;
  readonly maximumDelta: number;
}): void {
  const delta = storageBytes(input.root) - input.initialBytes;
  if (delta < 0 || delta > input.maximumDelta) {
    throw new Error("remote calibration storage ceiling is exhausted or custody drifted");
  }
}

function materializeCalibrationInputs(input: {
  readonly state: ReturnType<typeof resolvePennyRuntimeState>;
  readonly loaded: LoadedCalibrationPackageV1;
}): ReadonlyMap<string, ArtifactRef> {
  using artifacts = ArtifactStore.openExisting(input.state.paths.artifacts.root, {
    projectId: input.state.projectId,
  });
  const refs = new Map<string, ArtifactRef>();
  for (const task of input.loaded.cohort.tasks) {
    for (const binding of task.exact_inputs) {
      const component = input.loaded.package.components.find(
        (candidate) =>
          candidate.path === binding.source_path &&
          candidate.sha256 === binding.sha256 &&
          candidate.byte_length === binding.byte_length
      );
      const bytes =
        component === undefined
          ? undefined
          : input.loaded.componentBytes.get(component.component_id);
      if (bytes === undefined) {
        throw new Error(`calibration exact input '${binding.artifact_id}' has no package bytes`);
      }
      const ref = artifacts.persist({
        metadata: {
          schema_version: 2,
          run_id: `calibration-input-${input.loaded.package.package_sha256}`,
          phase: "evaluation-calibration-input",
          branch_id: null,
          kind: "calibration-exact-input",
          operation_id: `calibration-input:${binding.artifact_id}`,
          version: 1,
          producer: "host:evaluation-remote-calibration",
          media_type: "text/plain",
          parent_ref: null,
          upstream_refs: [],
        },
        content: bytes,
      });
      if (
        ref.content_digest !== binding.sha256 ||
        ref.byte_length !== binding.byte_length ||
        sha256Bytes(artifacts.read(ref)) !== binding.sha256
      ) {
        throw new Error(`calibration exact input '${binding.artifact_id}' materialization drifted`);
      }
      const previous = refs.get(binding.artifact_id);
      if (previous !== undefined && previous.artifact_id !== ref.artifact_id) {
        throw new Error(
          `calibration exact input '${binding.artifact_id}' materialized ambiguously`
        );
      }
      refs.set(binding.artifact_id, ref);
    }
  }
  return refs;
}

function replaceArtifactAliases(value: JsonValue, aliases: ReadonlyMap<string, string>): JsonValue {
  if (typeof value === "string") return aliases.get(value) ?? value;
  if (Array.isArray(value)) return value.map((item) => replaceArtifactAliases(item, aliases));
  if (value !== null && typeof value === "object") {
    return replaceArtifactAliasesInRecord(value, aliases);
  }
  return value;
}

function replaceArtifactAliasesInRecord(
  value: Readonly<Record<string, JsonValue>>,
  aliases: ReadonlyMap<string, string>
): Record<string, JsonValue> {
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, replaceArtifactAliases(item, aliases)])
  );
}

function executionTasks(input: {
  readonly tasks: readonly EvaluationPopulationTaskV1[];
  readonly materializedInputs: ReadonlyMap<string, ArtifactRef>;
}): readonly EvaluationPopulationTaskV1[] {
  const aliases = new Map(
    [...input.materializedInputs].map(([logicalId, ref]) => [logicalId, ref.artifact_id])
  );
  return input.tasks.map((task) => ({
    ...task,
    constraints: replaceArtifactAliasesInRecord(task.constraints, aliases),
    exact_input_artifact_ids: task.exact_input_artifact_ids.map(
      (artifactId) => aliases.get(artifactId) ?? artifactId
    ),
  }));
}

function normalizeAndGrade(input: {
  readonly observation: EvaluationTrialObservationV1;
  readonly entry: PairedEvaluationScheduleEntryV1;
  readonly task: EvaluationPopulationTaskV1;
  readonly executionTask: EvaluationPopulationTaskV1;
  readonly grading: EvaluationGradingDefinitionV1;
  readonly validateCommonWire: EvaluationCommonWireValidatorV1;
  readonly calibrationTask: ReturnType<typeof readinessTaskFromCalibrationTask>;
  readonly materializedInputs: ReadonlyMap<string, ArtifactRef>;
}): {
  readonly wire: string;
  readonly grader: DeterministicGraderDescriptorV1;
  readonly structural: DeterministicGraderResultV1;
} {
  const normalizer = input.grading.descriptor.semantic_normalizers.find(
    (candidate) => candidate.registration_name === input.entry.variant_name
  );
  const normalize = input.grading.implementations.semantic_normalizers.get(
    input.entry.variant_name
  );
  const grader = input.grading.descriptor.graders.find(
    (candidate) => candidate.grader_case_id === input.task.grader_case_id
  );
  const grade = input.grading.implementations.graders.get(input.task.grader_case_id);
  if (
    input.observation.terminal_status !== "complete" ||
    input.observation.output_ref === undefined ||
    input.observation.output_metadata === undefined ||
    input.observation.output_bytes === undefined ||
    normalizer === undefined ||
    normalize === undefined ||
    grader === undefined ||
    grade === undefined
  ) {
    throw new Error(`remote calibration trial '${input.entry.trial_id}' did not complete exactly`);
  }
  const normalized = normalize.normalize({
    descriptor: normalizer,
    wire: input.grading.descriptor.wire,
    output_ref: input.observation.output_ref,
    output_metadata: input.observation.output_metadata,
    output_bytes: input.observation.output_bytes,
    task: input.executionTask,
  });
  if (normalized.status !== "normalized") {
    throw new Error(`remote calibration trial '${input.entry.trial_id}' did not normalize`);
  }
  const reverseAliases = new Map(
    [...input.materializedInputs].map(([logicalId, ref]) => [ref.artifact_id, logicalId])
  );
  const packageWire = canonicalJson(
    replaceArtifactAliases(
      validateContract(
        JsonValueSchema,
        strictParseJson(normalized.wire_bytes),
        "normalized calibration wire"
      ),
      reverseAliases
    )
  );
  input.validateCommonWire({
    descriptor: input.grading.descriptor.wire,
    wire_bytes: packageWire,
    calibration_task: input.calibrationTask,
  });
  const structural = grade.grade(packageWire, input.task, grader);
  return { wire: packageWire, grader, structural };
}

function semanticExecutor(input: {
  readonly preflight: RemoteCalibrationPreflightV1;
  readonly budget: RemoteCalibrationBudget;
  readonly projectRoot: string;
  readonly env: NodeJS.ProcessEnv;
  readonly ownerVerifier: EvaluationOperatorApprovalVerifierV1;
  readonly packageJournalPresent: boolean;
  readonly judgeModel: Model<Api>;
  readonly now: () => Date;
}): PreauthorizedIndependentSemanticReviewExecutorV1 {
  const requestedJudge = `${input.preflight.manifest.judge_binding.provider}/${input.preflight.manifest.judge_binding.model}`;
  const resolver: PiSemanticReviewModelResolverV1 = (requested) => {
    if (requested !== requestedJudge) {
      throw new Error("remote calibration semantic judge refused a foreign model");
    }
    return input.judgeModel;
  };
  return new PreauthorizedIndependentSemanticReviewExecutorV1({
    projectRoot: input.projectRoot,
    env: input.env,
    cliOptIn: true,
    manifest: input.preflight.manifest,
    expectedManifest: input.preflight.manifest,
    approval: input.preflight.approval,
    ownerVerifier: input.ownerVerifier,
    packageJournalPresent: input.packageJournalPresent,
    now: input.now,
    resolveModel: resolver,
    admitLiveness: (event) => {
      if (event.kind === "model_turn") input.budget.chargeJudgeTurn(event);
    },
    admitTrace: (record) => {
      if (record.kind === "turn") {
        input.budget.chargeTokens(input.preflight.manifest.judge_rates, record.token_counts);
      }
    },
  });
}

function q4Contract(input: {
  readonly loaded: LoadedCalibrationPackageV1;
  readonly manifest: AuthorizedFleetManifestV1;
}): void {
  const trialClauseIds =
    input.loaded.package.skill === "decide" ? DECIDE_SEMANTIC_CLAUSE_IDS : PLAN_SEMANTIC_CLAUSE_IDS;
  if (
    input.manifest.judge_contract.judge_definition_sha256 !==
      SEMANTIC_REVIEW_JUDGE_DEFINITION_SHA256 ||
    input.manifest.judge_contract.judge_prompt_sha256 !==
      sha256(SEMANTIC_REVIEW_SYSTEM_PROMPT_V1) ||
    input.manifest.judge_contract.implementation_sha256 !== SEMANTIC_REVIEW_IMPLEMENTATION_SHA256 ||
    input.manifest.judge_contract.trial_packet_schema_sha256 !==
      semanticReviewPacketSchemaSha256("trial", input.loaded.package.skill, trialClauseIds) ||
    input.manifest.judge_contract.oracle_packet_schema_sha256 !==
      semanticReviewPacketSchemaSha256(
        "oracle",
        input.loaded.package.skill,
        Q4_ORACLE_REVIEW_CLAUSE_IDS
      ) ||
    input.manifest.judge_contract.trial_output_schema_sha256 !==
      semanticReviewOutputSchemaSha256("trial", trialClauseIds) ||
    input.manifest.judge_contract.oracle_output_schema_sha256 !==
      semanticReviewOutputSchemaSha256("oracle", Q4_ORACLE_REVIEW_CLAUSE_IDS)
  ) {
    throw new Error("remote calibration semantic judge contract drifted");
  }
}

async function reviewFrozenQ4(input: {
  readonly executor: PreauthorizedIndependentSemanticReviewExecutorV1;
  readonly loaded: LoadedCalibrationPackageV1;
}): Promise<number> {
  let calls = 0;
  for (const item of input.loaded.q4Packets) {
    const reviewed = await input.executor.review({
      packet: item.packet,
      reviewKind: "oracle",
      canonicalClauseIds: Q4_ORACLE_REVIEW_CLAUSE_IDS,
    });
    calls += reviewed.provider_calls;
    if (reviewed.evidence.output.clause_results.some((clause) => clause.outcome !== "PASS")) {
      throw new Error("remote calibration Q4 oracle review did not pass every clause");
    }
  }
  return calls;
}

function resultDigest(body: Omit<EvaluationRemoteCalibrationResultV1, "result_sha256">): string {
  return sha256(canonicalJson(body));
}

function persistResult(input: {
  readonly state: ReturnType<typeof resolvePennyRuntimeState>;
  readonly result: EvaluationRemoteCalibrationResultV1;
}): ArtifactRef {
  using artifacts = ArtifactStore.openExisting(input.state.paths.artifacts.root, {
    projectId: input.state.projectId,
  });
  const content = canonicalJson(input.result);
  const ref = artifacts.persist({
    metadata: {
      schema_version: 2,
      run_id: `calibration-result-${input.result.package_sha256}`,
      phase: "evaluation-calibration",
      branch_id: null,
      kind: "remote-calibration-result",
      operation_id: `remote-calibration-result:${input.result.result_sha256}`,
      version: 1,
      producer: "host:evaluation-remote-calibration",
      media_type: "application/json",
      content_schema: {
        schema_id: "penny.evaluation-remote-calibration-result.v1",
        schema_version: 1,
      },
      parent_ref: null,
      upstream_refs: input.result.trials.map((trial) => trial.output_ref),
    },
    content,
  });
  if (artifacts.read(ref).toString("utf8") !== content) {
    throw new Error("remote calibration result failed exact-byte re-read");
  }
  return ref;
}

export async function executeRemoteCalibrationPackageV1(input: {
  readonly projectRoot: string;
  readonly preflight: RemoteCalibrationPreflightV1;
  readonly ownerVerifier: EvaluationOperatorApprovalVerifierV1;
  readonly env: NodeJS.ProcessEnv;
  readonly dependencies?: Pick<RemoteCalibrationDependenciesV1, "now" | "monotonicNow">;
}): Promise<{
  readonly result: EvaluationRemoteCalibrationResultV1;
  readonly resultRef: ArtifactRef;
}> {
  if (input.env[LIVE_ENV] !== "1" || input.env.PENNY_EVALUATION_LOCAL_LIVE !== "1") {
    throw new Error(
      `remote calibration live execution requires ${LIVE_ENV}=1 and PENNY_EVALUATION_LOCAL_LIVE=1`
    );
  }
  const now = input.dependencies?.now ?? (() => new Date());
  const monotonicNow = input.dependencies?.monotonicNow ?? (() => performance.now());
  const manifest = input.preflight.manifest;
  await verifyApprovalProof({
    manifest,
    approval: input.preflight.approval,
    verifier: input.ownerVerifier,
    now: now(),
  });
  const stateRoot = path.resolve(manifest.roots.state_root);
  if (path.resolve(input.env.PENNY_STATE_ROOT ?? "") !== stateRoot) {
    throw new Error("remote calibration process state root does not match authorization");
  }
  initializePennyState(input.projectRoot, { env: input.env });
  const state = resolvePennyRuntimeState(input.projectRoot, { env: input.env });
  if (
    path.resolve(state.state.root) !== stateRoot ||
    path.resolve(state.paths.artifacts.root) !== path.resolve(manifest.roots.evidence_root)
  ) {
    throw new Error(
      "remote calibration initialized state/evidence roots drifted from authorization"
    );
  }
  const initialStorage = storageBytes(stateRoot);
  q4Contract({ loaded: input.preflight.loaded, manifest });
  const hadPackageJournal = packageJournalPresent({
    state,
    packageSha256: input.preflight.loaded.package.package_sha256,
  });
  const startedAt = monotonicNow();
  const budget = new RemoteCalibrationBudget(manifest, startedAt, monotonicNow);
  assertTrialJournalAdmissionConsistency({
    projectRoot: input.projectRoot,
    env: input.env,
    frozen: input.preflight.frozen,
    packageJournalPresent: hadPackageJournal,
  });
  const reviews = semanticExecutor({
    preflight: input.preflight,
    budget,
    projectRoot: input.projectRoot,
    env: input.env,
    ownerVerifier: input.ownerVerifier,
    packageJournalPresent: hadPackageJournal,
    judgeModel: input.preflight.judgeModel,
    now,
  });
  await reviews.preflight();
  persistPackageJournal({ state, preflight: input.preflight });
  const materializedInputs = materializeCalibrationInputs({
    state,
    loaded: input.preflight.loaded,
  });
  const liveTasks = executionTasks({
    tasks: input.preflight.tasks,
    materializedInputs,
  });
  assertStorageBudget({
    root: stateRoot,
    initialBytes: initialStorage,
    maximumDelta: manifest.limits.max_storage_bytes,
  });
  const factory = remoteModelClientFactory({
    state,
    preflight: input.preflight,
    budget,
    env: input.env,
    projectRoot: input.projectRoot,
  });
  const executor = new GenericEvaluationTrialExecutor({
    projectRoot: input.projectRoot,
    env: input.env,
    baselineRegistration: input.preflight.registrations.baseline,
    candidateRegistry: input.preflight.registrations.candidates,
    ablationRegistry: input.preflight.registrations.ablations,
    modelClientFactory: factory,
  });
  await factory.preflightCalibration(input.preflight.frozen);
  const taskAndGrade = taskAndGrading(input.preflight.loaded);
  const coordinator: EvaluationSemanticReviewCoordinatorV1 =
    createEvaluationSemanticReviewCoordinator({
      executor: reviews,
      trialClauseIds: taskAndGrade.clauseIds,
      oracleClauseIds: Q4_ORACLE_REVIEW_CLAUSE_IDS,
      buildTrialPacket: taskAndGrade.buildTrialPacket,
      buildOraclePacket: taskAndGrade.buildOraclePacket,
    });
  let semanticCalls = await reviewFrozenQ4({
    executor: reviews,
    loaded: input.preflight.loaded,
  });
  using journal = new ArtifactEvaluationTrialJournal({
    projectRoot: input.projectRoot,
    env: input.env,
    frozen: input.preflight.frozen,
  });
  const taskById = new Map(input.preflight.tasks.map((task) => [task.task_id, task]));
  const liveTaskById = new Map(liveTasks.map((task) => [task.task_id, task]));
  const calibrationById = new Map(
    input.preflight.loaded.cohort.tasks.map((task) => [task.task_id, task])
  );
  const trials: Static<typeof CalibrationTrialResultV1Schema>[] = [];
  for (const entry of input.preflight.frozen.schedule) {
    budget.assertTime();
    const task = taskById.get(entry.task_id);
    const liveTask = liveTaskById.get(entry.task_id);
    const calibration = calibrationById.get(entry.task_id);
    if (task === undefined || liveTask === undefined || calibration === undefined) {
      throw new Error(`remote calibration scheduled task '${entry.task_id}' is absent`);
    }
    const retained = journal.load(entry);
    const observation =
      retained.recorded && retained.observation !== undefined
        ? retained.observation
        : await executor.execute({
            entry,
            task: liveTask,
            plan: input.preflight.plan,
            frozen: input.preflight.frozen,
          });
    const recorded = retained.recorded ? retained : journal.record(entry, observation);
    const exactObservation = recorded.observation;
    if (exactObservation === undefined) {
      throw new Error(`remote calibration trial '${entry.trial_id}' has no terminal observation`);
    }
    const normalized = normalizeAndGrade({
      observation: exactObservation,
      entry,
      task,
      executionTask: liveTask,
      grading: input.preflight.gradingDefinition,
      validateCommonWire: input.preflight.validateCommonWire,
      calibrationTask: readinessTaskFromCalibrationTask(calibration),
      materializedInputs,
    });
    const reviewed = await coordinator.review({
      task,
      wire_bytes: normalized.wire,
      grader: normalized.grader,
      structural_grade: normalized.structural,
    });
    semanticCalls += reviewed.provider_calls;
    const gradeImplementation = input.preflight.gradingDefinition.implementations.graders.get(
      task.grader_case_id
    );
    const semanticRequest = input.preflight.loaded.semanticTaskOverrides.get(task.task_id);
    const qualification =
      input.preflight.loaded.package.skill === "plan"
        ? planSemanticQualificationStatusV2({
            wireBytes: normalized.wire,
            task,
            descriptor: normalized.grader,
            ...(semanticRequest === undefined ? {} : { semanticRequest }),
            semanticReview: reviewed.trial_review,
            oracleReview: reviewed.oracle_review,
          })
        : gradeImplementation?.qualifySemanticReview?.({
            wireBytes: normalized.wire,
            task,
            descriptor: normalized.grader,
            semanticReview: reviewed.trial_review,
            oracleReview: reviewed.oracle_review,
          });
    if (qualification === undefined || qualification.qualification_status !== "QUALIFIED") {
      const nonPassingClauses =
        qualification?.clause_results
          .filter((clause) => clause.outcome !== "PASS")
          .map((clause) => `${clause.clause_id}:${clause.outcome}`)
          .join(",") || "unavailable";
      throw new Error(
        `remote calibration trial '${entry.trial_id}' failed semantic qualification (${qualification?.reason_code ?? "QUALIFICATION_UNAVAILABLE"}; clauses=${nonPassingClauses})`
      );
    }
    if (exactObservation.output_ref === undefined) {
      throw new Error("completed remote calibration observation has no output ref");
    }
    trials.push({
      trial_id: entry.trial_id,
      task_id: entry.task_id,
      arm_id: entry.variant_name,
      repetition: entry.repetition,
      terminal_status: "complete",
      output_ref: exactObservation.output_ref,
      common_wire_sha256: sha256(normalized.wire),
      structural_grade_sha256: sha256(canonicalJson(normalized.structural)),
      semantic_qualification: "QUALIFIED",
      cost_microusd: exactObservation.cost_microusd,
      latency_ms: exactObservation.latency_ms,
    });
    assertStorageBudget({
      root: stateRoot,
      initialBytes: initialStorage,
      maximumDelta: manifest.limits.max_storage_bytes,
    });
  }
  const budgetAccounting = budget.measurement();
  const body: Omit<EvaluationRemoteCalibrationResultV1, "result_sha256"> = {
    schema_id: "penny.evaluation-remote-calibration-result.v1",
    schema_version: 1,
    split: "calibration",
    scoring: "non_scoring",
    package_id: input.preflight.loaded.package.package_id,
    package_sha256: input.preflight.loaded.package.package_sha256,
    schedule_sha256: input.preflight.loaded.scheduleSha256,
    authorization_manifest_sha256: evaluationLiveCalibrationAuthorizationManifestSha256(manifest),
    approval_receipt_sha256: evaluationLiveCalibrationApprovalReceiptSha256(
      input.preflight.approval
    ),
    runtime_binding_sha256: input.preflight.runtimeBindingSha256,
    status: "COMPLETED_NON_SCORING",
    trials,
    accounting: {
      scheduled_trials: input.preflight.frozen.schedule.length,
      completed_trials: trials.length,
      execution_provider_calls: budgetAccounting.calls,
      semantic_review_provider_calls: semanticCalls,
      total_cost_microusd: Math.max(
        budgetAccounting.spend_microusd,
        trials.reduce((sum, trial) => sum + trial.cost_microusd, 0)
      ),
      total_latency_ms: trials.reduce((sum, trial) => sum + trial.latency_ms, 0),
    },
  };
  const result = validateContract(
    EvaluationRemoteCalibrationResultV1Schema,
    { ...body, result_sha256: resultDigest(body) },
    "remote calibration result"
  );
  const resultRef = persistResult({ state, result });
  assertStorageBudget({
    root: stateRoot,
    initialBytes: initialStorage,
    maximumDelta: manifest.limits.max_storage_bytes,
  });
  return { result, resultRef };
}

export async function runRemoteC6CalibrationSequenceV1(input: {
  readonly projectRoot: string;
  readonly decide: {
    readonly packagePath: string;
    readonly manifest: unknown;
    readonly approval: unknown;
    readonly confirmedPackageSha256: string;
    readonly confirmedMaxSpendMicrousd: number;
  };
  readonly plan: {
    readonly packagePath: string;
    readonly manifest: unknown;
    readonly approval: unknown;
    readonly confirmedPackageSha256: string;
    readonly confirmedMaxSpendMicrousd: number;
  };
  readonly ownerVerifier: EvaluationOperatorApprovalVerifierV1;
  readonly preflightOnly: boolean;
  readonly env?: NodeJS.ProcessEnv;
  readonly dependencies?: RemoteCalibrationDependenciesV1;
}): Promise<
  | {
      readonly status: "PREFLIGHT_PASSED";
      readonly decide: RemoteCalibrationPreflightV1;
      readonly plan: RemoteCalibrationPreflightV1;
    }
  | {
      readonly status: "COMPLETED_NON_SCORING";
      readonly decide: EvaluationRemoteCalibrationResultV1;
      readonly plan: EvaluationRemoteCalibrationResultV1;
    }
> {
  const dependencies = input.dependencies ?? (await defaultDependencies());
  const decide = await preflightRemoteCalibrationPackageV1({
    projectRoot: input.projectRoot,
    ...input.decide,
    ownerVerifier: input.ownerVerifier,
    dependencies,
  });
  if (decide.loaded.package.skill !== "decide") {
    throw new Error("remote calibration sequence first package is not Decide");
  }
  const plan = await preflightRemoteCalibrationPackageV1({
    projectRoot: input.projectRoot,
    ...input.plan,
    ownerVerifier: input.ownerVerifier,
    dependencies,
  });
  if (plan.loaded.package.skill !== "plan") {
    throw new Error("remote calibration sequence second package is not Plan");
  }
  if (
    path.resolve(decide.manifest.roots.state_root) ===
      path.resolve(plan.manifest.roots.state_root) ||
    path.resolve(decide.manifest.roots.evidence_root) ===
      path.resolve(plan.manifest.roots.evidence_root)
  ) {
    throw new Error("Decide and Plan calibration run groups require distinct authorized roots");
  }
  if (input.preflightOnly) {
    return { status: "PREFLIGHT_PASSED", decide, plan };
  }
  const baseEnv = input.env ?? process.env;
  const decideRun = await executeRemoteCalibrationPackageV1({
    projectRoot: input.projectRoot,
    preflight: decide,
    ownerVerifier: input.ownerVerifier,
    env: { ...baseEnv, PENNY_STATE_ROOT: decide.manifest.roots.state_root },
    dependencies,
  });
  if (decideRun.result.status !== "COMPLETED_NON_SCORING") {
    throw new Error("Decide calibration did not complete; Plan execution is forbidden");
  }
  const planRun = await executeRemoteCalibrationPackageV1({
    projectRoot: input.projectRoot,
    preflight: plan,
    ownerVerifier: input.ownerVerifier,
    env: { ...baseEnv, PENNY_STATE_ROOT: plan.manifest.roots.state_root },
    dependencies,
  });
  return {
    status: "COMPLETED_NON_SCORING",
    decide: decideRun.result,
    plan: planRun.result,
  };
}

export const REMOTE_CALIBRATION_LIVE_ENV = LIVE_ENV;
