/** Consequential ordinary SCA work, exclusively delegated by the canonical host-operation owner. */
import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdirSync, lstatSync, writeFileSync, linkSync, unlinkSync, realpathSync } from "node:fs";
import type { ArtifactHostStore } from "../artifact-store.js";
import { canonicalJson, sha256 } from "../canonical-json.js";
import { validateContract, type ArtifactRef } from "../contracts.js";
import { Type, type Static } from "typebox";
import {
  hostOperationLeaseProfileSha256,
  type HostOperationAdapterV1,
  type HostOperationDeclarationV1,
  type HostOperationExecutionContextV1,
  type HostOperationDispositionV1,
} from "../host-operations/contracts.js";
import { ScaRequestV1Schema } from "../skill-contracts/sca-request.js";
import {
  ScaDispositionsSchema,
  ScaHypothesesSchema,
  ScaEvidenceSchema,
} from "./ordinary-contracts.js";
import { captureScaStaticSourceFile } from "./ordinary-source.js";
import { parseSealedScaSourceCorpusV1 } from "./active-compliance.js";
import { persistScaArtifact, verifyPointer } from "./ordinary-artifacts.js";
import {
  ScaAdvancedRequestSchema,
  ScaAdvancedResultSchema,
  ScaApplicationBindingsSchema,
  OrdinaryApplicationTestRequestSchema,
  OrdinaryApplicationTestResultSchema,
  OrdinaryApplicationExecutionPlanSchema,
  OrdinaryApplicationExecutionPolicySchema,
  OrdinaryApplicationRuntimeConfigSchema,
  OrdinaryApplicationVmConfigSchema,
  ScaRuleLearningRequestSchema,
  ScaRuleLearningRecordSchema,
  ScaRuleLearningResultSchema,
  ScaRulePromotionRequestSchema,
  ScaRulePromotionResultSchema,
  ScaRuleRescanRequestSchema,
  ScaRuleRescanResultSchema,
  type ScaAdvancedStage,
  type ScaAdvancedRequest,
  type ScaAdvancedResult,
  type OrdinaryApplicationTestResult,
  type ScaProcessRequestV1,
  type ScaProcessResultV1,
} from "./ordinary-advanced-contracts.js";
export const SCA_ADVANCED_ADAPTER = "sca-ordinary-advanced-v1";
export function scaAdvancedBackend(stage: ScaAdvancedStage): string {
  return sha256(`penny:sca:ordinary:${stage === "application" ? "isolated-vm" : "learning"}:v1`);
}
export function scaAdvancedContract(stage: ScaAdvancedStage, direction: "request" | "result") {
  if (direction === "result")
    return { ...scaAdvancedPrivateContract(), port_name: `sca_${stage}_result` };
  return {
    schema_version: 1 as const,
    port_name: `sca_${stage}_${direction}`,
    artifact_kind: `sca-${stage}-${direction}`,
    schema_id: `penny.sca-${stage}-${direction}.v1`,
    schema_version_required: 1,
  };
}
export function scaAdvancedPrivateContract() {
  return {
    schema_version: 1 as const,
    port_name: "private_advanced",
    artifact_kind: "sca-private-advanced",
    schema_id: "penny.sca-private-advanced.v1",
    schema_version_required: 1,
  };
}
export function scaAdvancedDeclaration(stage: ScaAdvancedStage): HostOperationDeclarationV1 {
  const lease = {
    profile_id: "sca-advanced-lease-v1",
    profile_version: 1 as const,
    duration_ms: 60000,
    renew_after_ms: 10000,
    queue_inactivity_ms: 300000,
  };
  return {
    schema_version: 1,
    result_selection_policy: "unselected",
    operation_kind: `sca.${stage}.v1`,
    adapter_id: SCA_ADVANCED_ADAPTER,
    request: scaAdvancedContract(stage, "request"),
    result: scaAdvancedContract(stage, "result"),
    backend_binding_id:
      stage === "application" ? "sca-ordinary-isolated-vm-v1" : "sca-ordinary-learning-v1",
    capability_classes: ["artifact_store"],
    lease_profile: { ...lease, profile_sha256: hostOperationLeaseProfileSha256(lease) },
    operation_inactivity_ms: 5400000,
    max_request_bytes: 64 * 1024 * 1024,
    max_input_artifacts: 32,
    max_input_bytes: 256 * 1024 * 1024,
    output_contracts: [],
    max_output_artifacts: 2,
    max_output_bytes: 128 * 1024 * 1024,
    max_progress_events: 65536,
    max_pre_acceptance_retries: 0,
    recovery_semantics: "journaled_remote_submission_v1",
    cancellation_semantics: "local_abort_only_v1",
  };
}
export interface ScaApplicationOwner {
  projectId: string;
  runId: string;
  signal: AbortSignal;
  readArtifact(ref: ArtifactRef): { ref: ArtifactRef; bytes: Uint8Array };
  beforeSubmit(correlation: string): void;
  accepted(correlation: string): void;
  activity(): void;
}
export interface ScaApplicationRuntime {
  run(request: unknown, owner: ScaApplicationOwner): Promise<unknown>;
}
export interface ScaAdvancedHostOptions {
  /** Trusted composition only. The model/caller request never contains VM configuration. */
  applicationVm?: unknown;
  /** Tagged native host configuration. Mutually exclusive with the legacy VM alias. */
  applicationRuntime?: unknown;
  /** Test/embedding seam; no synthetic receipt is native isolation evidence. */
  applicationFactory?: (authority: {
    project_id: string;
    admitted_policy_refs: ArtifactRef[];
  }) => ScaApplicationRuntime;
  learning?: {
    workRoot: string;
    /** Required independently confined offline process runner. No direct-process fallback. */
    runOffline(
      request: ScaProcessRequestV1,
      signal?: AbortSignal,
      activity?: () => void
    ): Promise<ScaProcessResultV1>;
  };
}
interface LearningHost {
  workRoot: string;
  admitValidation(request: unknown, digest: string): Promise<unknown>;
  authorize(operation: string, request: unknown, digest: string): Promise<boolean>;
  runOffline(request: ScaProcessRequestV1, signal?: AbortSignal): Promise<ScaProcessResultV1>;
  recordPrivate(receipt: unknown): Promise<void>;
  recordValidation(record: unknown): Promise<void>;
  readValidation(digest: string): Promise<unknown>;
}
interface LearningRuntime {
  validate(value: unknown, corpus: Buffer, control: { signal: AbortSignal }): Promise<unknown>;
  promote(value: unknown, control: { signal: AbortSignal }): Promise<unknown>;
  rescan(value: unknown, corpus: Buffer, control: { signal: AbortSignal }): Promise<unknown>;
}
function isApplicationModule(value: unknown): value is {
  createOrdinaryApplicationTestRuntime(options: {
    authority: { project_id: string; admitted_policy_refs: ArtifactRef[] };
    vm?: unknown;
    runtime?: unknown;
  }): ScaApplicationRuntime;
  recoverOrdinaryApplicationTest(request: unknown, bytes: Uint8Array | null): unknown;
  validateOrdinaryApplicationTestResult(value: unknown): OrdinaryApplicationTestResult;
} {
  return (
    value !== null &&
    typeof value === "object" &&
    "createOrdinaryApplicationTestRuntime" in value &&
    typeof value.createOrdinaryApplicationTestRuntime === "function" &&
    "recoverOrdinaryApplicationTest" in value &&
    typeof value.recoverOrdinaryApplicationTest === "function" &&
    "validateOrdinaryApplicationTestResult" in value &&
    typeof value.validateOrdinaryApplicationTestResult === "function"
  );
}
function isLearningModule(
  value: unknown
): value is { createOrdinaryRuleLearning(host: LearningHost): LearningRuntime } {
  return (
    value !== null &&
    typeof value === "object" &&
    "createOrdinaryRuleLearning" in value &&
    typeof value.createOrdinaryRuleLearning === "function"
  );
}
const PrivateSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    request_sha256: Type.String(),
    // The owner journals one unselected per-item envelope, including its safe projection.
    projection: Type.Optional(ScaAdvancedResultSchema),
    native: Type.Unknown(),
    validation: Type.Union([ScaRuleLearningRecordSchema, Type.Null()]),
    receipts: Type.Array(Type.Unknown(), { maxItems: 513 }),
  },
  { additionalProperties: false }
);
export { PrivateSchema as ScaAdvancedPrivateSchema };
function input(context: HostOperationExecutionContextV1, slot: string): Buffer {
  const found = context.readInput(slot);
  const bytes = Buffer.from(found.bytes);
  if (sha256(bytes) !== found.ref.content_digest || bytes.length !== found.ref.byte_length)
    throw new Error("Advanced exact input drift");
  return bytes;
}
function json(bytes: Uint8Array): unknown {
  return JSON.parse(Buffer.from(bytes).toString("utf8"));
}
function same(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}
/** Private working copy, not a canonical store. Exact artifacts remain authoritative. */
export function scaLearningWorkingFile(root: string, bytes: Buffer): string {
  try {
    mkdirSync(root, { mode: 0o700 });
  } catch (error) {
    if (!(error instanceof Error) || Reflect.get(error, "code") !== "EEXIST") throw error;
  }
  const st = lstatSync(root);
  if (
    !st.isDirectory() ||
    st.isSymbolicLink() ||
    st.uid !== process.getuid?.() ||
    (st.mode & 0o777) !== 0o700
  )
    throw new Error("Learning work root must already be private");
  const file = path.join(root, `${sha256(bytes)}.json`);
  if (!path.isAbsolute(root) || realpathSync(root) !== root)
    throw new Error("Learning root must be canonical");
  const stage = path.join(root, `.${randomUUID()}.tmp`);
  writeFileSync(stage, bytes, { flag: "wx", mode: 0o600 });
  try {
    linkSync(stage, file);
  } catch (error) {
    if (!(error instanceof Error) || Reflect.get(error, "code") !== "EEXIST") throw error;
  } finally {
    unlinkSync(stage);
  }
  const info = lstatSync(file);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1 ||
    (info.mode & 0o777) !== 0o600 ||
    !captureScaStaticSourceFile({
      sourceRoot: root,
      relativePath: path.basename(file),
      maximumBytes: 16384,
    }).equals(bytes)
  )
    throw new Error("Learning working copy drift");
  return file;
}
function admit(context: HostOperationExecutionContextV1, request: ScaAdvancedRequest) {
  if (
    request.run_id !== context.directive.identity.run_id ||
    context.directive.operation_kind !== `sca.${request.stage}.v1` ||
    !same(request.input_bindings, context.directive.input_artifacts.artifacts) ||
    request.input_sha256 !== sha256(canonicalJson(request.input_bindings)) ||
    new Set(request.input_bindings.map((x) => x.slot)).size !== request.input_bindings.length ||
    new Set(request.input_bindings.map((x) => x.ref.artifact_id)).size !==
      request.input_bindings.length
  )
    throw new Error("Advanced operation/run/exact input authority mismatch");
  const caller = validateContract(
    ScaRequestV1Schema,
    json(input(context, "caller")),
    "Original caller authority"
  );
  const corpusBytes = input(context, "corpus");
  const corpus = parseSealedScaSourceCorpusV1(corpusBytes);
  if (corpus.source_snapshot_sha256 !== caller.source_snapshot_sha256)
    throw new Error("Advanced source authority mismatch");
  if (request.stage === "application") {
    const native = validateContract(
      OrdinaryApplicationTestRequestSchema,
      request.native_request,
      "Application request"
    );
    const bindings = validateContract(
      ScaApplicationBindingsSchema,
      json(input(context, "application_bindings")),
      "Application closure"
    );
    const binding = bindings.find((x) => x.id === request.selection_id);
    const selection = caller.advanced?.application_tests.find((x) => x.id === request.selection_id);
    if (
      caller.execution_mode === "static_only" ||
      binding === undefined ||
      selection === undefined ||
      native.run_id !== request.run_id ||
      native.action_id !== request.action_id ||
      native.source_snapshot_sha256 !== corpus.source_snapshot_sha256 ||
      !same(native.execution_plan_ref, binding.plan_ref) ||
      !same(native.policy_ref, binding.policy_ref)
    )
      throw new Error("Unadmitted application plan/policy/source");
    const expected = [
      ...new Map(
        [...binding.closure, binding.plan_ref, binding.policy_ref].map((ref) => [
          ref.artifact_id,
          ref,
        ])
      ).values(),
    ].filter(
      (ref) =>
        !["caller", "corpus", "application_bindings"].some((slot) =>
          request.input_bindings.some((x) => x.slot === slot && same(x.ref, ref))
        )
    );
    const operands = request.input_bindings
      .filter((x) => x.slot.startsWith("operand-"))
      .map((x) => x.ref);
    if (!same(operands, expected)) throw new Error("Application exact closure authority mismatch");
    const readRef = (ref: ArtifactRef) => {
      const operand = request.input_bindings.find((x) => same(x.ref, ref));
      if (operand === undefined) throw new Error("Unbound application document");
      return json(input(context, operand.slot));
    };
    const plan = validateContract(
      OrdinaryApplicationExecutionPlanSchema,
      readRef(binding.plan_ref),
      "Exact plan"
    );
    const policy = validateContract(
      OrdinaryApplicationExecutionPolicySchema,
      readRef(binding.policy_ref),
      "Exact policy"
    );
    if (
      plan.schema_version !== (selection.isolation === "container" ? 2 : 1) ||
      policy.schema_version !== plan.schema_version ||
      policy.isolation !== (selection.isolation ?? "vm") ||
      policy.profile !==
        (selection.isolation === "container" ? selection.profile : "qemu-kvm-nicless-v1") ||
      binding.plan_ref.content_schema?.schema_version !== plan.schema_version ||
      binding.plan_ref.content_schema?.schema_id !== plan.schema_id ||
      binding.policy_ref.content_schema?.schema_version !== policy.schema_version ||
      binding.policy_ref.content_schema?.schema_id !== policy.schema_id ||
      !same(plan.source_corpus_ref, context.readInput("corpus").ref) ||
      plan.source_snapshot_sha256 !== selection.source_snapshot_sha256 ||
      !same(plan.source_files, selection.source_files) ||
      plan.interpreter !== selection.interpreter ||
      plan.expected_exit_code !== selection.expected_exit_code ||
      !same(plan.resources, selection.resources) ||
      plan.harness_ref.content_digest !== selection.harness.sha256 ||
      !same(
        plan.test_inputs.map((x) => ({ path: x.path, digest: x.ref.content_digest })),
        selection.test_inputs.map((x) => ({ path: x.name, digest: x.file.sha256 }))
      ) ||
      (plan.stdin_ref?.content_digest ?? null) !== (selection.stdin?.sha256 ?? null) ||
      policy.project_id !== native.project_id ||
      policy.run_id !== native.run_id ||
      !same(policy.maxima, selection.maxima) ||
      !same(policy.allowed_plan_sha256, [binding.plan_ref.content_digest])
    )
      throw new Error("Changed caller plan/policy/corpus closure");
    return { caller, corpusBytes, native, binding };
  }
  return { caller, corpusBytes, native: null, binding: null };
}
export function createScaAdvancedHostAdapters(
  options: ScaAdvancedHostOptions,
  store: ArtifactHostStore,
  projectId: string
): ReadonlyMap<string, HostOperationAdapterV1> {
  if (options.applicationRuntime !== undefined && options.applicationVm !== undefined)
    throw new Error("Ambiguous application runtime and legacy VM configuration");
  const applicationRuntime =
    options.applicationRuntime === undefined
      ? undefined
      : validateContract(
          OrdinaryApplicationRuntimeConfigSchema,
          options.applicationRuntime,
          "Application runtime config"
        );
  const applicationVm =
    options.applicationVm === undefined
      ? undefined
      : validateContract(
          OrdinaryApplicationVmConfigSchema,
          options.applicationVm,
          "Application VM config"
        );
  const adapter: HostOperationAdapterV1 = {
    adapter_id: SCA_ADVANCED_ADAPTER,
    inspectRequest(value) {
      const request = validateContract(
        ScaAdvancedRequestSchema,
        json(value.request_bytes),
        "Advanced request"
      );
      if (value.directive.operation_kind !== `sca.${request.stage}.v1`)
        throw new Error("Advanced stage substitution");
      return {
        schema_version: 1,
        operation_kind: value.directive.operation_kind,
        adapter_id: SCA_ADVANCED_ADAPTER,
        backend_binding_id: value.declaration.backend_binding_id,
        backend_key_sha256: scaAdvancedBackend(request.stage),
      };
    },
    async run(context) {
      const { isCanonicalHostOperationExecutionContextV1 } =
        await import("../host-operations/owner.js");
      if (!isCanonicalHostOperationExecutionContextV1(context))
        throw new Error("Registered host execution context required");
      const request = validateContract(
        ScaAdvancedRequestSchema,
        json(context.request_bytes),
        "Advanced request"
      );
      const admitted = admit(context, request);
      let effectiveNative: unknown = request.native_request;
      let validation: Static<typeof ScaRuleLearningRecordSchema> | null = null;
      const receipts: unknown[] = [];
      const base: ScaAdvancedResult = {
        schema_version: 1,
        stage: request.stage,
        selection_id: request.selection_id,
        action_id: request.action_id,
        hypothesis_id: request.hypothesis_id,
        request_sha256: context.directive.request_sha256,
        status: "unsupported",
        execution: "NOT RUN",
        passed: null,
        exit_code: null,
        cleanup: "not_needed",
        quarantine_required: false,
        result_sha256: sha256("unavailable"),
        validation_sha256: null,
        release_sha256: null,
        findings_count: 0,
        baseline_unchanged: true,
      };
      const cached = await context.readCachedResult();
      let privateData: Static<typeof PrivateSchema>;
      let result = base;
      if (cached !== null) {
        const bundle = validateContract(
          Type.Object(
            { result: ScaAdvancedResultSchema, private: PrivateSchema },
            { additionalProperties: false }
          ),
          json(cached.bytes),
          "Advanced exact cache"
        );
        if (
          bundle.result.request_sha256 !== context.directive.request_sha256 ||
          bundle.private.request_sha256 !== context.directive.request_sha256
        )
          throw new Error("Advanced cached request substitution");
        result = bundle.result;
        privateData = bundle.private;
        if (privateData.validation !== null) effectiveNative = privateData.validation.request;
        if (
          request.stage === "application" &&
          privateData.native !== null &&
          typeof privateData.native === "object" &&
          "schema_id" in privateData.native
        ) {
          const module: unknown = await import(
            new URL("../../../sca-service/dist/ordinary-application-tests.js", import.meta.url).href
          );
          if (!isApplicationModule(module))
            throw new Error("Installed application recovery unavailable");
          module.recoverOrdinaryApplicationTest(
            request.native_request,
            Buffer.from(canonicalJson(privateData.native))
          );
        }
      } else if (context.journal.lifecycle !== "lease_acquired") {
        result = {
          ...base,
          status: "incomplete",
          execution: "UNKNOWN",
          cleanup: "unproved",
          quarantine_required: true,
        };
        privateData = {
          schema_version: 1,
          request_sha256: context.directive.request_sha256,
          native: { reason: "restart_without_exact_cache" },
          validation: null,
          receipts: [],
        };
      } else if (request.stage === "application") {
        const native = admitted.native;
        if (native === null || admitted.binding === null)
          throw new Error("Application admission absent");
        const authority = {
          project_id: projectId,
          admitted_policy_refs: [admitted.binding.policy_ref],
        };
        const module: unknown = await import(
          new URL("../../../sca-service/dist/ordinary-application-tests.js", import.meta.url).href
        );
        if (!isApplicationModule(module))
          throw new Error("Installed application capability unavailable");
        const runtime =
          options.applicationFactory?.(authority) ??
          module.createOrdinaryApplicationTestRuntime({
            authority,
            ...(applicationVm === undefined ? {} : { vm: applicationVm }),
            ...(applicationRuntime === undefined ? {} : { runtime: applicationRuntime }),
          });
        const observed = module.validateOrdinaryApplicationTestResult(
          await runtime.run(native, {
            projectId,
            runId: request.run_id,
            signal: context.signal,
            readArtifact(ref) {
              const binding = request.input_bindings.find((x) => same(x.ref, ref));
              if (binding === undefined) throw new Error("Unadmitted application operand");
              const value = context.readInput(binding.slot);
              return { ref: value.ref, bytes: value.bytes };
            },
            beforeSubmit() {
              context.beginSubmission();
            },
            accepted(correlation) {
              context.recordRemoteAccepted(correlation);
            },
            activity() {
              context.reportActivity("application_test_progress", 1);
            },
          })
        );
        if (
          observed.request_sha256 !== sha256(canonicalJson(native)) ||
          observed.source_snapshot_sha256 !== native.source_snapshot_sha256
        )
          throw new Error("Application result binding drift");
        result = {
          ...base,
          status: observed.status,
          execution: observed.execution,
          ...(observed.isolation === undefined ? {} : { isolation: observed.isolation }),
          evidence_scope: observed.evidence_scope,
          passed: observed.passed,
          exit_code: observed.exit_code,
          cleanup: observed.cleanup,
          quarantine_required: observed.quarantine_required,
          result_sha256: sha256(canonicalJson(observed)),
        };
        privateData = {
          schema_version: 1,
          request_sha256: context.directive.request_sha256,
          native: observed,
          validation: null,
          receipts: [],
        };
      } else if (options.learning === undefined) {
        privateData = {
          schema_version: 1,
          request_sha256: context.directive.request_sha256,
          native: { reason: "trusted_offline_learning_runner_not_configured" },
          validation: null,
          receipts: [],
        };
      } else {
        const config = options.learning;
        const module: unknown = await import(
          new URL("../../../sca-service/dist/ordinary-rule-learning.js", import.meta.url).href
        );
        if (!isLearningModule(module)) throw new Error("Installed learning capability unavailable");
        const chosen = admitted.caller.advanced?.learning.find(
          (x) => x.id === request.selection_id
        );
        if (chosen === undefined) throw new Error("Unadmitted independent fixture corpus");
        const original =
          request.stage === "validation"
            ? request
            : validateContract(
                ScaAdvancedRequestSchema,
                json(input(context, "validation_request")),
                "Original owner validation request"
              );
        if (
          original.stage !== "validation" ||
          original.run_id !== request.run_id ||
          original.selection_id !== request.selection_id ||
          original.hypothesis_id !== request.hypothesis_id ||
          original.input_sha256 !== sha256(canonicalJson(original.input_bindings)) ||
          original.input_bindings.some(
            (operand) => !request.input_bindings.some((x) => same(x, operand))
          )
        )
          throw new Error("Original validation closure substitution");
        const originalNative = validateContract(
          ScaRuleLearningRequestSchema,
          original.native_request,
          "Original validation native request"
        );
        const capturedNative = () => ({
          ...originalNative,
          candidate:
            originalNative.candidate === null
              ? null
              : {
                  ...originalNative.candidate,
                  rules_path: scaLearningWorkingFile(config.workRoot, input(context, "candidate")),
                },
        });
        const recordInput = () => {
          const value = validateContract(
            PrivateSchema,
            json(input(context, "validation")),
            "Exact own validation artifact"
          );
          if (
            value.request_sha256 !== context.readInput("validation_request").ref.content_digest ||
            value.validation === null ||
            !same(value.validation.request, capturedNative())
          )
            throw new Error("Original validation record/input substitution");
          return value;
        };
        if (request.stage === "validation") {
          const selectedRequest = validateContract(
            ScaRuleLearningRequestSchema,
            request.native_request,
            "Captured candidate request"
          );
          if (selectedRequest.candidate !== null) {
            if (selectedRequest.candidate.rules_path !== "owner-captured-candidate")
              throw new Error("Candidate path cannot be caller/model selected");
            const candidate = input(context, "candidate");
            if (sha256(candidate) !== selectedRequest.candidate.rules_sha256)
              throw new Error("Candidate exact artifact drift");
            effectiveNative = {
              ...selectedRequest,
              candidate: {
                ...selectedRequest.candidate,
                rules_path: scaLearningWorkingFile(config.workRoot, candidate),
              },
            };
          }
        }
        const runtime = module.createOrdinaryRuleLearning({
          workRoot: config.workRoot,
          async admitValidation(value, digest) {
            const native = validateContract(
              ScaRuleLearningRequestSchema,
              value,
              "Validation request"
            );
            const reconciliation = validateContract(
              ScaDispositionsSchema,
              json(input(context, "reconciliation")),
              "Own reconciliation"
            );
            const hypotheses = validateContract(
              ScaHypothesesSchema,
              json(input(context, "hypotheses")),
              "Own hypotheses"
            );
            const evidence = validateContract(
              ScaEvidenceSchema,
              json(input(context, "evidence")),
              "Own evidence"
            );
            const disposition = reconciliation.dispositions.find(
              (x) => x.hypothesis_id === request.hypothesis_id
            );
            const hypothesis = hypotheses.hypotheses.find((x) => x.id === request.hypothesis_id);
            const ref = (slot: string) => context.readInput(slot).ref.content_digest;
            if (
              digest !== sha256(canonicalJson(native)) ||
              !same(native, capturedNative()) ||
              native.root_cause !== hypothesis?.violated_invariant ||
              !same(native.evidence_pointers, disposition?.evidence) ||
              native.run_id !== request.run_id ||
              native.hypothesis_id !== request.hypothesis_id ||
              native.reconciliation_sha256 !== ref("reconciliation") ||
              native.hypothesis_sha256 !== sha256(canonicalJson(hypothesis)) ||
              native.disposition_sha256 !== sha256(canonicalJson(disposition)) ||
              native.evidence_sha256 !== ref("evidence") ||
              native.source_corpus_sha256 !== ref("corpus") ||
              native.source_snapshot_sha256 !== chosen.source_snapshot_sha256 ||
              !same(native.baseline, chosen.baseline) ||
              !same(native.tool, chosen.tool) ||
              !same(native.offline_validation ?? null, chosen.offline_validation ?? null) ||
              !same(native.fixtures, chosen.fixtures) ||
              native.fixture_truth_sha256 !== chosen.fixture_truth_sha256 ||
              !same(native.limits, chosen.limits) ||
              (native.candidate !== null &&
                (native.candidate.rules_sha256 !==
                  context.readInput("candidate").ref.content_digest ||
                  native.candidate.rule_id !== chosen.rule_id ||
                  native.candidate.language !== chosen.language)) ||
              disposition?.disposition !== "confirmed_code" ||
              hypothesis === undefined ||
              disposition.action_ids.length === 0
            )
              throw new Error("Validation exact own-evidence/caller fixture authority mismatch");
            for (const pointer of native.evidence_pointers) {
              verifyPointer(parseSealedScaSourceCorpusV1(admitted.corpusBytes), pointer);
              if (
                !disposition.evidence.some((x) => same(x, pointer)) ||
                !evidence.results.some(
                  (x) =>
                    x.hypothesis_id === native.hypothesis_id &&
                    disposition.action_ids.includes(x.action_id) &&
                    x.status === "completed" &&
                    x.pointers.some((y) => same(y, pointer))
                )
              )
                throw new Error("Validation lacks confirmed own-action evidence");
            }
            return {
              request_sha256: digest,
              decision: "allow",
              reconciliation_sha256: native.reconciliation_sha256,
              hypothesis_sha256: native.hypothesis_sha256,
              disposition_sha256: native.disposition_sha256,
              evidence_sha256: native.evidence_sha256,
              fixture_truth_sha256: native.fixture_truth_sha256,
              reason: "Exact caller-admitted independent truth and reconciled own-action evidence",
            };
          },
          async authorize(operation, value, digest) {
            if (
              digest !== sha256(canonicalJson(value)) ||
              !same(value, request.native_request) ||
              admitted.caller.execution_mode === "static_only"
            )
              return false;
            if (operation === "promote") {
              const native = validateContract(
                ScaRulePromotionRequestSchema,
                value,
                "Promotion authority"
              );
              const grant = admitted.caller.advanced?.promotions.find(
                (x) => x.validation_id === chosen.id
              );
              const record = recordInput().validation;
              return (
                grant !== undefined &&
                record !== null &&
                record.result.status === "validated" &&
                native.validation_sha256 === record.result.result_sha256 &&
                native.run_id === request.run_id &&
                native.namespace === grant.namespace &&
                native.predecessor_release_sha256 === grant.predecessor_release_sha256 &&
                native.successor_revision === grant.successor_revision &&
                native.authority.authority_sha256 === grant.authority_sha256 &&
                record.request.candidate?.rules_sha256 === grant.candidate_sha256
              );
            }
            if (operation === "rescan") {
              const native = validateContract(
                ScaRuleRescanRequestSchema,
                value,
                "Rescan authority"
              );
              const grant = admitted.caller.advanced?.rescans.find(
                (x) => x.validation_id === chosen.id
              );
              const promoted = validateContract(
                ScaRulePromotionResultSchema,
                validateContract(
                  PrivateSchema,
                  json(input(context, "promotion")),
                  "Exact promotion receipt"
                ).native,
                "Committed promotion"
              );
              return (
                grant !== undefined &&
                ["promoted", "adopted"].includes(promoted.status) &&
                native.run_id === request.run_id &&
                native.release_path === promoted.release_path &&
                native.release_sha256 === promoted.release_sha256 &&
                native.source_snapshot_sha256 === grant.source_snapshot_sha256 &&
                native.source_corpus_sha256 === context.readInput("corpus").ref.content_digest &&
                native.retained_baseline_sha256 === chosen.baseline.release_sha256 &&
                native.predecessor_investigation_sha256 ===
                  context.readInput("reconciliation").ref.content_digest &&
                native.rescan_revision === grant.rescan_revision &&
                native.authority.authority_sha256 === grant.authority_sha256
              );
            }
            return false;
          },
          async runOffline(value, signal) {
            context.reportActivity("learning_process_start", 1);
            const outcome = await config.runOffline(value, signal, () =>
              context.reportActivity("learning_process_progress", 1)
            );
            context.reportActivity("learning_process_complete", 1);
            return outcome;
          },
          async recordPrivate(value) {
            if (receipts.length >= 513) throw new Error("Learning receipt bound");
            const bytes = Buffer.from(canonicalJson(value));
            if (bytes.length > 8 * 1024 * 1024) throw new Error("Learning receipt bytes");
            persistScaArtifact({
              store,
              runId: request.run_id,
              phase: context.directive.operation_id,
              kind: "sca-private-learning-observation",
              schemaId: "penny.sca-private-learning-observation.v1",
              content: bytes,
              upstream: [context.directive.request_ref],
            });
            receipts.push(value);
          },
          async recordValidation(value) {
            validation = validateContract(
              ScaRuleLearningRecordSchema,
              value,
              "Exact validation record"
            );
          },
          async readValidation(digest) {
            const record = recordInput().validation;
            if (record === null || record.result.result_sha256 !== digest)
              throw new Error("Validation exact artifact authority mismatch");
            return record;
          },
        });
        // Local learning work has its own journal guard, never the scanner's remote acceptance.
        context.beginSubmission();
        context.recordRemoteAccepted(`learning:${context.directive.request_sha256}`);
        const control = { signal: context.signal };
        const native =
          request.stage === "validation"
            ? await runtime.validate(effectiveNative, admitted.corpusBytes, control)
            : request.stage === "promotion"
              ? await runtime.promote(request.native_request, control)
              : await runtime.rescan(request.native_request, admitted.corpusBytes, control);
        if (request.stage === "validation") {
          const outcome = validateContract(ScaRuleLearningResultSchema, native, "Learning result");
          if (validation === null) throw new Error("Learning omitted exact validation artifact");
          result = {
            ...base,
            status: outcome.status,
            result_sha256: sha256(canonicalJson(native)),
            validation_sha256: outcome.result_sha256,
            baseline_unchanged: outcome.baseline_unchanged,
          };
        } else if (request.stage === "promotion") {
          const outcome = validateContract(
            ScaRulePromotionResultSchema,
            native,
            "Promotion result"
          );
          result = {
            ...base,
            status: outcome.status,
            result_sha256: sha256(canonicalJson(native)),
            release_sha256: outcome.release_sha256,
            baseline_unchanged: outcome.baseline_unchanged,
          };
        } else {
          const outcome = validateContract(ScaRuleRescanResultSchema, native, "Rescan result");
          result = {
            ...base,
            status: outcome.status,
            result_sha256: sha256(canonicalJson(native)),
            release_sha256: outcome.release_sha256,
            findings_count: outcome.findings.length,
          };
        }
        privateData = {
          schema_version: 1,
          request_sha256: context.directive.request_sha256,
          native,
          validation,
          receipts,
        };
      }
      result = validateContract(ScaAdvancedResultSchema, result, "Advanced projection");
      if (
        privateData.native !== null &&
        typeof privateData.native === "object" &&
        "request_sha256" in privateData.native
      ) {
        if (result.result_sha256 !== sha256(canonicalJson(privateData.native)))
          throw new Error("Native result projection hash drift");
        if (request.stage === "application") {
          const native = validateContract(
            OrdinaryApplicationTestResultSchema,
            privateData.native,
            "Exact application projection"
          );
          if (
            (result.isolation !== undefined && result.isolation !== native.isolation) ||
            (result.evidence_scope !== undefined &&
              result.evidence_scope !== native.evidence_scope) ||
            !same(
              [
                result.status,
                result.execution,
                result.passed,
                result.exit_code,
                result.cleanup,
                result.quarantine_required,
              ],
              [
                native.status,
                native.execution,
                native.passed,
                native.exit_code,
                native.cleanup,
                native.quarantine_required,
              ]
            )
          )
            throw new Error("Application projection drift");
        } else if (request.stage === "validation") {
          const native = validateContract(
            ScaRuleLearningResultSchema,
            privateData.native,
            "Exact learning projection"
          );
          if (
            result.status !== native.status ||
            result.validation_sha256 !== native.result_sha256 ||
            !same(privateData.validation?.result, native)
          )
            throw new Error("Learning projection drift");
        } else if (request.stage === "promotion") {
          const native = validateContract(
            ScaRulePromotionResultSchema,
            privateData.native,
            "Exact promotion projection"
          );
          if (
            result.status !== native.status ||
            result.release_sha256 !== native.release_sha256 ||
            result.baseline_unchanged !== native.baseline_unchanged
          )
            throw new Error("Promotion projection drift");
        } else {
          const native = validateContract(
            ScaRuleRescanResultSchema,
            privateData.native,
            "Exact rescan projection"
          );
          if (
            result.status !== native.status ||
            result.release_sha256 !== native.release_sha256 ||
            result.findings_count !== native.findings.length
          )
            throw new Error("Rescan projection drift");
        }
      }

      if (
        privateData.native !== null &&
        typeof privateData.native === "object" &&
        "request_sha256" in privateData.native &&
        privateData.native.request_sha256 !== sha256(canonicalJson(effectiveNative))
      )
        throw new Error("Native result request drift");
      if (context.journal.lifecycle === "lease_acquired") context.beginSubmission();
      // Negative admission still completes a local owner unit; this correlation does
      // not assert guest acceptance (the native receipt remains authoritative).
      if (context.journal.remote_correlation_id === null && !result.quarantine_required)
        context.recordRemoteAccepted(`local-admission:${context.directive.request_sha256}`);
      // A durable fetch may outlive its cache. Preserve that immutable milestone and
      // persist only the explicit loss/UNKNOWN projection; never replace or replay its work.
      if (!(cached === null && ["fetched", "persisting"].includes(context.journal.lifecycle))) {
        const capture =
          cached ??
          (await context.cacheResult(Buffer.from(canonicalJson({ result, private: privateData }))));
        if (context.journal.lifecycle !== "persisting")
          context.recordFetched({
            schema_version: 1,
            content_sha256: capture.content_sha256,
            byte_length: capture.byte_length,
            item_count: 1,
            poll_count: 0,
          });
      }
      const disposition: HostOperationDispositionV1 = result.quarantine_required
        ? {
            outcome: "remote_unknown",
            remote_disposition: "may_continue",
            lease_disposition: "quarantined",
            retryable: false,
            reason_code: "advanced_cleanup_or_acceptance_unproved",
          }
        : {
            outcome: "completed",
            remote_disposition:
              context.journal.remote_correlation_id === null ? "none" : "proven_terminal",
            lease_disposition: "released",
            retryable: false,
            reason_code: null,
          };
      return {
        disposition,
        ...context.persist({
          disposition,
          operation_result: {
            contract: context.declaration.result,
            media_type: "application/json",
            content: canonicalJson({ ...privateData, projection: result }),
          },
          outputs: [],
        }),
      };
    },
  };
  return new Map([[adapter.adapter_id, adapter]]);
}
