import { randomUUID } from "node:crypto";
import { PhaseResultProjectionV1Schema } from "./phase-result-projection.js";

import { ArtifactStore } from "./artifact-store.js";
import {
  registeredBrowserPolicyOwnerScopeId,
  runWithRegisteredBrowserPolicy,
} from "./browser-policy-carrier.js";
import { canonicalJson, sha256 } from "./checkpointer.js";
import {
  ConfidenceSchema,
  JsonValueSchema,
  PhaseResultSchema,
  type Directive,
  type InputArtifacts,
  type JsonValue,
  type OutputArtifactMetadata,
  type PhaseResult,
  type RoutingRepairBindingV1,
  type RunIdentity,
  validateContract,
} from "./contracts.js";
import { OrchestrationEngine } from "./engine.js";
import type { ChildWorkflowRuntimeOwner } from "./child-workflows/owner.js";
import type { HostOperationProgressV1 } from "./host-operations/contracts.js";
import type { HostOperationRuntimeOwner } from "./host-operations/owner.js";
import {
  RemoteModelOutcomeUnknownError,
  buildAgentOpening,
  requireNonEmptyStageOutput,
  type ActiveWorkerRegistrationMetadataV1,
  type AgentInvocation,
  type GenericChildCatalogAgentYamlMaximumCarrierV1,
  type ModelClient,
} from "./model-client.js";
import {
  LivenessController,
  LivenessExhaustedError,
  researchThinkingLevelForLivenessPreset,
} from "./liveness.js";
import { fallbackWorkerLeaseProfile } from "./liveness-profiles.js";
import {
  bindGenericChildYamlAuthority,
  resolvePlaybook,
  runtimeRegistrationSha256,
  validateRegistrationContract,
  type PlaybookRegistration,
} from "./playbooks/registry.js";
import { ReceiptAuthority, trustedInvocationDigest } from "./receipts.js";
import {
  PreDispatchPolicyDeniedError,
  resolveProviderOpeningGuard,
} from "./provider-opening-guard.js";
import type { ResearchContextOwnerV2 } from "./research-context.js";
import { SCA_P04_PROVIDER_OPENING_ADAPTER } from "./sca/p04-dispatch-guard.js";
import { SCA_P05_PROVIDER_OPENING_ADAPTER } from "./sca/p05-dispatch-guard.js";
import { SCA_P06_PROVIDER_OPENING_ADAPTER } from "./sca/p06-dispatch-guard.js";
import { SCA_P08_PROVIDER_OPENING_ADAPTER } from "./sca/p08-dispatch-guard.js";
import { SCA_P10_PROVIDER_OPENING_ADAPTER } from "./sca/p10-dispatch-guard.js";
import { SCA_P11_PROVIDER_OPENING_ADAPTER } from "./sca/p11-dispatch-guard.js";
import {
  MODEL_DISPATCH_GUARD_V1_SCHEMA,
  MODEL_EXECUTION_RECEIPT_V1_SCHEMA,
  assertResolvedModelIdentity,
  modelDispatchGuardOperationId,
  modelExecutionReceiptOperationId,
  validateModelDispatchGuardV1,
  validateModelExecutionReceiptV1,
  type ResolvedModelIdentityV1,
} from "./required-model.js";

const CANCELLATION_GRACE_MS = 5_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

function workerAbortError(signal: AbortSignal): Error {
  return signal.reason instanceof LivenessExhaustedError
    ? signal.reason
    : new Error("worker execution was cancelled before completion");
}

type RoutingSummary = {
  readonly confidence: "CERTAIN" | "PROBABLE" | "POSSIBLE" | "UNCERTAIN";
  readonly details: Record<string, JsonValue>;
};

function normalizeRoutingObject(
  parsed: Record<string, JsonValue>,
  outerConfidence?: "CERTAIN" | "PROBABLE" | "POSSIBLE" | "UNCERTAIN"
): RoutingSummary | undefined {
  const innerConfidence = parsed.confidence;
  let confidence: RoutingSummary["confidence"];
  try {
    confidence = validateContract(
      ConfidenceSchema,
      innerConfidence ?? outerConfidence ?? "UNCERTAIN",
      "routing SUMMARY confidence"
    );
  } catch {
    return undefined;
  }
  if (
    innerConfidence !== undefined &&
    outerConfidence !== undefined &&
    innerConfidence !== outerConfidence
  ) {
    return undefined;
  }
  const { confidence: _transportConfidence, ...details } = parsed;
  return { confidence, details };
}

export function normalizeTrustedRoutingCompletion(input: {
  readonly confidence?: "CERTAIN" | "PROBABLE" | "POSSIBLE" | "UNCERTAIN";
  readonly details?: Record<string, JsonValue>;
}): RoutingSummary | undefined {
  if (input.details === undefined) return undefined;
  return normalizeRoutingObject(input.details, input.confidence);
}

export function buildRoutingRepairGuidance(
  registration: PlaybookRegistration,
  stateId: string
): string {
  if (registration.worker.kind !== "catalog-agent") {
    throw new Error("routing repair requires a catalog-agent registration");
  }
  const phase = registration.worker.phases.get(stateId);
  if (phase === undefined) {
    throw new Error(`routing repair has no registered phase '${stateId}'`);
  }
  return [
    "# Summary-Only Routing Repair",
    "The semantic stage bytes already exist in the one supplied artifact. Do not reproduce, replace, summarize, or extend them.",
    "Read that exact artifact, then emit exactly one line beginning `SUMMARY:` followed by one compact JSON object.",
    "The JSON object may contain only `confidence` plus fields admitted by the mechanically projected registered phase-details schema below. `confidence` is required and must be CERTAIN, PROBABLE, POSSIBLE, or UNCERTAIN.",
    "No prose, code fence, semantic body, generation report, second SUMMARY, extra field, or trailing line is allowed.",
    `REGISTERED_PHASE_DETAILS_SCHEMA:${canonicalJson(phase.schema)}`,
  ].join("\n\n");
}

export function parsePersistedRoutingSummary(text: string): RoutingSummary | undefined {
  const withoutTrailingNewline = text.endsWith("\n") ? text.slice(0, -1) : text;
  if (withoutTrailingNewline.endsWith("\n")) return undefined;
  const lines = withoutTrailingNewline.split("\n");
  if (lines.filter((line) => line.startsWith("SUMMARY:")).length !== 1) return undefined;
  const finalLine = lines.at(-1);
  // Horizontal separator whitespace is framing, not semantic content. Keep the
  // unique final-line requirement; do not trim or salvage malformed JSON/prose.
  const match = finalLine?.match(/^SUMMARY:[ \t]*(\{[^\n]*\})$/u);
  if (match?.[1] === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(match[1]);
  } catch {
    return undefined;
  }
  try {
    const parsed = validateContract(JsonValueSchema, value, "persisted SUMMARY");
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return normalizeRoutingObject(parsed);
  } catch {
    return undefined;
  }
}

function parsePersistedPhaseObject(text: string): Record<string, JsonValue> | undefined {
  const candidate = text.endsWith("\n") ? text.slice(0, -1) : text;
  if (candidate.length === 0 || candidate.endsWith("\n")) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(candidate);
  } catch {
    return undefined;
  }
  try {
    const parsed = validateContract(JsonValueSchema, value, "persisted phase JSON");
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

interface Assignment {
  readonly identity: RunIdentity;
  readonly stateId: string;
  readonly branchId: string | null;
  readonly agent: string;
  readonly attempt: number;
  readonly trustProfile: "trusted-interactive" | "hardened-untrusted";
  readonly modelOverride?: string;
  readonly executionPurpose: "phase" | "routing_repair";
  readonly routingRepairBinding?: RoutingRepairBindingV1;
  readonly task: string;
  readonly inputArtifacts: InputArtifacts;
  readonly outputArtifact: OutputArtifactMetadata;
}

export interface WorkerExecutionSettlement {
  readonly results: PhaseResult[];
  readonly errors: unknown[];
}

export interface OrchestrationProgressWorker {
  readonly state_id: string;
  readonly agent: string;
  readonly attempt: number;
  readonly branch_id: string | null;
  readonly execution_purpose: "phase" | "routing_repair";
}

/**
 * Content-free execution progress emitted by the shared runner. Playbooks do not
 * participate in this contract: every current and future registered phase is
 * projected from its durable directive and admitted worker result.
 */
export type OrchestrationProgressEvent =
  | {
      readonly event: "phase_started";
      readonly run_id: string;
      readonly playbook: string;
      readonly state_id: string;
      readonly workers: readonly OrchestrationProgressWorker[];
    }
  | {
      readonly event: "worker_completed";
      readonly run_id: string;
      readonly playbook: string;
      readonly state_id: string;
      readonly worker: OrchestrationProgressWorker;
      readonly completed_workers: number;
      readonly total_workers: number;
    }
  | {
      readonly event: "worker_failed";
      readonly run_id: string;
      readonly playbook: string;
      readonly state_id: string;
      readonly failed_workers: number;
      readonly total_workers: number;
    }
  | {
      readonly event: "host_operation_progress";
      readonly run_id: string;
      readonly playbook: string;
      readonly state_id: string;
      readonly operation_id: string;
      readonly operation_kind: string;
      readonly progress: HostOperationProgressV1;
    }
  | {
      readonly event: "boundary_reached";
      readonly run_id: string;
      readonly playbook: string;
      readonly action: Exclude<
        Directive["action"],
        | "invoke_agent"
        | "invoke_agents_parallel"
        | "invoke_child_workflow"
        | "invoke_host_operation"
      >;
      readonly state_id?: string;
    };

export type OrchestrationProgressSink = (event: OrchestrationProgressEvent) => void;

/** Internal content-free activity channel used by an owning child execution lease. */
export interface OrchestrationWorkerActivityEvent {
  readonly run_id: string;
  readonly state_id: string;
  readonly worker_id: string;
  readonly activity_class: import("./child-workflows/contracts.js").WorkerActivityClassV1;
  readonly observed_units: number;
}
export type OrchestrationWorkerActivitySink = (event: OrchestrationWorkerActivityEvent) => void;

type SettledOutput<T> =
  | { readonly status: "fulfilled"; readonly value: T }
  | { readonly status: "rejected"; readonly error: unknown };

export interface WorkerExecutorOptions {
  readonly projectRoot: string;
  readonly parallelConcurrency: number;
  /** Caller-approved invocation override; wins over directive defaults, never required-model policy. */
  readonly modelOverride?: string;
  /**
   * Host override for the fallback inactivity interval used when no registered profile is
   * bound. This is renewed by trusted progress and is never a total execution-duration ceiling.
   */
  readonly fallbackInactivityLeaseMs?: number;
  /**
   * Exact engine registration. It is the only source for an orchestration phase subset;
   * ordinary direct/parallel/chain subagent paths do not pass through this seam.
   */
  readonly registration?: PlaybookRegistration;
  /** Re-resolves selected safe context envelopes before model/session work. */
  readonly researchContext?: ResearchContextOwnerV2;
}

type WorkerExecutableDirective = Extract<
  Directive,
  { action: "invoke_agent" | "invoke_agents_parallel" }
>;

/** Child workflows and host operations have separate owners and cannot enter workers. */
export function assertWorkerExecutableDirective(
  directive: Directive
): asserts directive is WorkerExecutableDirective {
  if (directive.action !== "invoke_agent" && directive.action !== "invoke_agents_parallel") {
    throw new Error(`directive '${directive.action}' is not executable by a worker`);
  }
}

export class WorkerExecutor {
  private receiptAuthority: ReceiptAuthority | undefined;
  private liveness: LivenessController | undefined;

  constructor(
    private readonly modelClient: ModelClient,
    private readonly artifactStore: ArtifactStore,
    private readonly options: WorkerExecutorOptions
  ) {}

  setReceiptAuthority(authority: ReceiptAuthority): void {
    this.receiptAuthority = authority;
  }

  setLivenessController(liveness: LivenessController): void {
    this.liveness = liveness;
  }

  async execute(directive: Directive, signal?: AbortSignal): Promise<PhaseResult[]> {
    assertWorkerExecutableDirective(directive);
    if (directive.action === "invoke_agent") {
      return [
        await this.executeAssignment(
          {
            identity: directive.identity,
            stateId: directive.state_id,
            branchId: null,
            agent: directive.agent,
            attempt: directive.attempt,
            trustProfile: directive.trust_profile,
            ...(directive.model_override ? { modelOverride: directive.model_override } : {}),
            executionPurpose: directive.execution_purpose ?? "phase",
            ...(directive.routing_repair_binding
              ? { routingRepairBinding: directive.routing_repair_binding }
              : {}),
            task: directive.task,
            inputArtifacts: directive.input_artifacts,
            outputArtifact: directive.output_artifact,
          },
          signal
        ),
      ];
    }
    if (directive.action === "invoke_agents_parallel") {
      const assignments = directive.branches.map(
        (branch): Assignment => ({
          identity: directive.identity,
          stateId: branch.state_id,
          branchId: branch.branch_id,
          agent: branch.agent,
          attempt: branch.attempt,
          trustProfile: branch.trust_profile,
          ...(branch.model_override ? { modelOverride: branch.model_override } : {}),
          executionPurpose: branch.execution_purpose ?? "phase",
          ...(branch.routing_repair_binding
            ? { routingRepairBinding: branch.routing_repair_binding }
            : {}),
          task: branch.task,
          inputArtifacts: branch.input_artifacts,
          outputArtifact: branch.output_artifact,
        })
      );
      return this.mapConcurrent(
        assignments,
        Math.max(1, this.options.parallelConcurrency),
        (assignment) => this.executeAssignment(assignment, signal),
        signal
      );
    }
    throw new Error("unreachable worker directive");
  }

  async executeSettled(
    directive: Directive,
    signal?: AbortSignal,
    onResult?: (result: PhaseResult) => void,
    onActivity?: OrchestrationWorkerActivitySink
  ): Promise<WorkerExecutionSettlement> {
    assertWorkerExecutableDirective(directive);
    if (directive.action === "invoke_agent") {
      try {
        const results = [
          await this.executeAssignment(
            {
              identity: directive.identity,
              stateId: directive.state_id,
              branchId: null,
              agent: directive.agent,
              attempt: directive.attempt,
              trustProfile: directive.trust_profile,
              ...(directive.model_override ? { modelOverride: directive.model_override } : {}),
              executionPurpose: directive.execution_purpose ?? "phase",
              ...(directive.routing_repair_binding
                ? { routingRepairBinding: directive.routing_repair_binding }
                : {}),
              task: directive.task,
              inputArtifacts: directive.input_artifacts,
              outputArtifact: directive.output_artifact,
            },
            signal,
            onActivity
          ),
        ];
        for (const result of results) onResult?.(result);
        return { results, errors: [] };
      } catch (error) {
        return { results: [], errors: [error] };
      }
    }
    const assignments = directive.branches.map(
      (branch): Assignment => ({
        identity: directive.identity,
        stateId: branch.state_id,
        branchId: branch.branch_id,
        agent: branch.agent,
        attempt: branch.attempt,
        trustProfile: branch.trust_profile,
        ...(branch.model_override ? { modelOverride: branch.model_override } : {}),
        executionPurpose: branch.execution_purpose ?? "phase",
        ...(branch.routing_repair_binding
          ? { routingRepairBinding: branch.routing_repair_binding }
          : {}),
        task: branch.task,
        inputArtifacts: branch.input_artifacts,
        outputArtifact: branch.output_artifact,
      })
    );
    const settled = await this.mapConcurrentSettled(
      assignments,
      Math.max(1, this.options.parallelConcurrency),
      (assignment) => this.executeAssignment(assignment, signal, onActivity),
      signal,
      onResult
    );
    return {
      results: settled.flatMap((entry) => (entry.status === "fulfilled" ? [entry.value] : [])),
      errors: settled.flatMap((entry) => (entry.status === "rejected" ? [entry.error] : [])),
    };
  }

  private async executeAssignment(
    assignment: Assignment,
    signal?: AbortSignal,
    onActivity?: OrchestrationWorkerActivitySink
  ): Promise<PhaseResult> {
    // The directive remains the engine's immutable receipt/digest operand. A host invocation
    // override selects this session only; it must not rewrite the durable assignment.
    const modelOverride = this.options.modelOverride ?? assignment.modelOverride;
    const runId = assignment.identity.run_id;
    const workerId = randomUUID();
    const liveness = this.liveness?.hasPolicy(runId) === true ? this.liveness : undefined;
    const activeRegistration = this.activeRegistration(assignment);
    const registration = this.resolveWorkerRegistration(activeRegistration, assignment);
    const requiredModel = registration.required_model;
    const providerOpeningGuard = registration.provider_opening_guard;
    const providerOpeningAdapter =
      providerOpeningGuard === undefined
        ? undefined
        : resolveProviderOpeningGuard({
            id: providerOpeningGuard,
            registration_name: activeRegistration.name,
            state_id: assignment.stateId,
            agent: assignment.agent,
            adapters: [
              SCA_P04_PROVIDER_OPENING_ADAPTER,
              SCA_P05_PROVIDER_OPENING_ADAPTER,
              SCA_P06_PROVIDER_OPENING_ADAPTER,
              SCA_P08_PROVIDER_OPENING_ADAPTER,
              SCA_P10_PROVIDER_OPENING_ADAPTER,
              SCA_P11_PROVIDER_OPENING_ADAPTER,
            ],
          });
    const guardedProviderOpening = providerOpeningAdapter !== undefined;
    const guardedPhaseLabel =
      providerOpeningGuard === "sca_p04_payload_disclosure_v1"
        ? "SCA P04"
        : providerOpeningGuard === "sca_p05_payload_disclosure_v1"
          ? "SCA P05"
          : providerOpeningGuard === "sca_p06_payload_disclosure_v1"
            ? "SCA P06"
            : providerOpeningGuard === "sca_p08_payload_disclosure_v1"
              ? "SCA P08"
              : providerOpeningGuard === "sca_p10_payload_disclosure_v1"
                ? "SCA P10"
                : providerOpeningGuard === "sca_p11_payload_disclosure_v1"
                  ? "SCA P11"
                  : "guarded";
    if (
      requiredModel !== undefined &&
      (assignment.modelOverride !== requiredModel.override ||
        modelOverride !== requiredModel.override)
    ) {
      const cause = new Error(
        `worker refuses model override '${modelOverride ?? "<absent>"}' for required phase '${activeRegistration.name}:${assignment.stateId}'`
      );
      if (guardedProviderOpening) {
        throw new PreDispatchPolicyDeniedError(
          "opening_policy_denied",
          "SCA P04 pre-dispatch required-model policy was denied",
          { cause }
        );
      }
      throw cause;
    }
    const executionCoordinate = {
      run_id: runId,
      state_id: assignment.stateId,
      branch_id: assignment.branchId,
      agent: assignment.agent,
      attempt: assignment.attempt,
    };
    let observedModel: ResolvedModelIdentityV1 | undefined;
    let dispatchGuardRef: ReturnType<ArtifactStore["persist"]> | undefined;
    const boundPolicy = liveness?.policy(runId);
    const thinkingLevel =
      activeRegistration.liveness.thinking_policy === "research_preset" && boundPolicy !== undefined
        ? researchThinkingLevelForLivenessPreset(boundPolicy.preset)
        : undefined;
    this.assertRepairInputBinding(assignment);
    const contextRefs = assignment.inputArtifacts.artifacts
      .map((binding) => binding.ref)
      .filter((ref) => ref.kind === "context-source-ref");
    if (contextRefs.length > 0 && this.options.researchContext === undefined) {
      throw new Error("research context refs require the owner resolver before worker use");
    }
    if (requiredModel !== undefined && contextRefs.length > 0) {
      throw new Error(
        "required-model phases cannot resolve context-source refs before exact model admission"
      );
    }
    liveness?.admitInvocation({
      runId,
      stateId: assignment.stateId,
      branchId: assignment.branchId,
      attempt: assignment.attempt,
      purpose: assignment.executionPurpose,
    });
    let inputsPreflighted = false;
    const preflightInputs = (): void => {
      if (inputsPreflighted) return;
      for (const binding of assignment.inputArtifacts.artifacts) {
        this.artifactStore.read(binding.ref);
      }
      inputsPreflighted = true;
    };
    // Ordinary phases retain the established communication preflight order. A required-model
    // phase defers private artifact reads until the exact provider/model has been admitted and
    // the pre-prompt dispatch callback is reached.
    if (requiredModel === undefined) preflightInputs();
    liveness?.startWorker({
      runId,
      workerId,
      stateId: assignment.stateId,
      branchId: assignment.branchId,
      purpose: assignment.executionPurpose,
    });
    const fallbackInactivityLeaseMs =
      this.options.fallbackInactivityLeaseMs ??
      fallbackWorkerLeaseProfile(assignment.executionPurpose).inactivity_interval_ms;
    if (
      !Number.isSafeInteger(fallbackInactivityLeaseMs) ||
      fallbackInactivityLeaseMs <= 0 ||
      fallbackInactivityLeaseMs > MAX_TIMER_DELAY_MS
    ) {
      throw new Error(
        `fallbackInactivityLeaseMs must be an integer between 1 and ${MAX_TIMER_DELAY_MS}`
      );
    }
    let renewInactivityLease: ((remainingMs: number) => void) | undefined;
    const sink =
      liveness === undefined
        ? undefined
        : liveness.sessionSink({
            runId,
            workerId,
            stateId: assignment.stateId,
          });
    const livenessInvocation = {
      liveness: (event: Parameters<NonNullable<typeof sink>>[0]): void => {
        sink?.(event);
        const progressEvent =
          event.kind === "activity" ? event : "progress" in event ? event.progress : undefined;
        if (progressEvent === undefined) return;
        const lease = liveness?.workerInactivityLease(runId, workerId);
        renewInactivityLease?.(lease?.remainingMs ?? fallbackInactivityLeaseMs);
        onActivity?.({
          run_id: runId,
          state_id: assignment.stateId,
          worker_id: workerId,
          activity_class: progressEvent.activity_class,
          observed_units: progressEvent.observed_units,
        });
      },
      ...(liveness === undefined
        ? {}
        : { livenessBudget: liveness.workerPromptBudget(runId, workerId) }),
      ...(liveness === undefined
        ? {}
        : {
            bindResolvedSessionModel: (resolved: { provider: string; model: string }): void => {
              liveness.bindWorkerProgressLease({
                runId,
                workerId,
                providerId: resolved.provider,
                modelId: resolved.model,
              });
              const lease = liveness.workerInactivityLease(runId, workerId);
              renewInactivityLease?.(lease.remainingMs);
            },
          }),
    };
    let outcome: "complete" | "error" | "cancelled" = "error";
    try {
      const startedAt = new Date().toISOString();
      const controller = new AbortController();
      const abort = (): void => {
        controller.abort(new Error("worker execution was cancelled by its caller"));
      };
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
      let inactivityTimer: NodeJS.Timeout | undefined;
      let rejectInactivity: ((error: LivenessExhaustedError) => void) | undefined;
      const inactivityExpired = new Promise<never>((_resolve, reject) => {
        rejectInactivity = reject;
      });
      renewInactivityLease = (remainingMs): void => {
        if (
          !Number.isSafeInteger(remainingMs) ||
          remainingMs < 0 ||
          remainingMs > MAX_TIMER_DELAY_MS
        ) {
          throw new Error(
            `worker inactivity remainder must be an integer between 0 and ${MAX_TIMER_DELAY_MS}`
          );
        }
        if (inactivityTimer !== undefined) clearTimeout(inactivityTimer);
        const expire = (): void => {
          const error = new LivenessExhaustedError("worker_inactivity_lease_expired");
          controller.abort(error);
          rejectInactivity?.(error);
        };
        if (remainingMs === 0) expire();
        else inactivityTimer = setTimeout(expire, remainingMs);
      };
      const initialLease = liveness?.workerInactivityLease(runId, workerId);
      renewInactivityLease(initialLease?.remainingMs ?? fallbackInactivityLeaseMs);
      let completion;
      try {
        const modelPipeline = async (): ReturnType<ModelClient["runAgent"]> => {
          // Resolve after queue/liveness setup and immediately before the model-client seam.
          // Ordinary inputs were preflighted above; required-model inputs are preflighted only by
          // the post-identity, pre-prompt dispatch guard. Trusted progress renews the same lease.
          const contextOverlays =
            contextRefs.length === 0
              ? []
              : ((await this.options.researchContext?.resolveOverlays(
                  contextRefs,
                  assignment.stateId,
                  {
                    signal: controller.signal,
                    inactivity_interval_ms: initialLease?.intervalMs ?? fallbackInactivityLeaseMs,
                    on_progress: (progress) => {
                      livenessInvocation.liveness({
                        kind: "activity",
                        activity_class: "host_context_resolution_progress",
                        observed_units: progress.observed_units,
                      });
                    },
                  }
                )) ?? []);
          if (controller.signal.aborted) throw workerAbortError(controller.signal);
          let serializedOpeningAppendix: string | undefined;
          const modelInvocation: AgentInvocation = {
            agent: assignment.agent,
            stateId: assignment.stateId,
            task: assignment.task,
            projectRoot: this.options.projectRoot,
            trustProfile: assignment.trustProfile,
            inputArtifacts: assignment.inputArtifacts.artifacts.map((binding) => binding.ref),
            registration,
            workflowSession: {
              run_id: runId,
              workflow_session_id: assignment.identity.session_id,
              branch_id: assignment.branchId,
              attempt: assignment.attempt,
              worker_id: workerId,
              purpose: assignment.executionPurpose,
            },
            executionPurpose: assignment.executionPurpose,
            ...(assignment.executionPurpose === "routing_repair"
              ? {
                  routingRepairGuidance: buildRoutingRepairGuidance(
                    activeRegistration,
                    assignment.stateId
                  ),
                }
              : {}),
            ...(contextOverlays.length === 0 ? {} : { contextOverlays }),
            signal: controller.signal,
            ...livenessInvocation,
            ...(modelOverride === undefined ? {} : { modelOverride }),
            ...(guardedProviderOpening
              ? {
                  providerOpeningAppendix: (): string => {
                    try {
                      preflightInputs();
                      if (providerOpeningAdapter === undefined) {
                        throw new Error("guarded provider opening adapter is absent");
                      }
                      serializedOpeningAppendix = providerOpeningAdapter.buildAppendix({
                        store: this.artifactStore,
                        assignment: {
                          registration_name: activeRegistration.name,
                          run_id: runId,
                          state_id: assignment.stateId,
                          branch_id: assignment.branchId,
                          agent: assignment.agent,
                          task: assignment.task,
                          input_artifacts: assignment.inputArtifacts,
                        },
                      });
                      return serializedOpeningAppendix;
                    } catch (error) {
                      if (error instanceof PreDispatchPolicyDeniedError) throw error;
                      throw new PreDispatchPolicyDeniedError(
                        "opening_appendix_invalid",
                        `${guardedPhaseLabel} pre-dispatch opening appendix construction was denied`,
                        { cause: error }
                      );
                    }
                  },
                }
              : {}),
            ...(requiredModel === undefined
              ? {}
              : {
                  admitResolvedModel: (resolved: ResolvedModelIdentityV1): void => {
                    try {
                      observedModel = assertResolvedModelIdentity(
                        requiredModel,
                        resolved,
                        "worker-observed model"
                      );
                    } catch (error) {
                      if (!guardedProviderOpening) throw error;
                      throw new PreDispatchPolicyDeniedError(
                        "opening_policy_denied",
                        `${guardedPhaseLabel} pre-dispatch resolved-model policy was denied`,
                        { cause: error }
                      );
                    }
                  },
                  guardModelDispatch: (serializedOpening: string): void => {
                    const operationId = modelDispatchGuardOperationId(executionCoordinate);
                    const prior = this.artifactStore.refFor(
                      runId,
                      assignment.stateId,
                      assignment.branchId,
                      "model-dispatch-guard",
                      operationId,
                      1
                    );
                    if (prior !== null) {
                      throw new RemoteModelOutcomeUnknownError(
                        `model dispatch '${operationId}' was already guarded; automatic replay is prohibited`
                      );
                    }
                    let serializedOpeningSha256 = sha256(serializedOpening);
                    let serializedOpeningByteLength = Buffer.byteLength(serializedOpening, "utf8");
                    if (guardedProviderOpening) {
                      try {
                        preflightInputs();
                        if (serializedOpeningAppendix === undefined) {
                          throw new Error("guarded provider opening appendix was not serialized");
                        }
                        const expectedOpening = buildAgentOpening({
                          invocation: modelInvocation,
                          registration,
                          agentGuidance: "registration-bound",
                          domainGuidance: "registration-bound",
                          activeToolNames: [],
                          providerOpeningAppendix: serializedOpeningAppendix,
                        });
                        if (serializedOpening !== expectedOpening) {
                          throw new Error(
                            "guarded provider opening differs from the exact host projection"
                          );
                        }
                        if (providerOpeningAdapter === undefined) {
                          throw new Error("guarded provider opening adapter is absent");
                        }
                        const authorization = providerOpeningAdapter.authorizeSerializedOpening({
                          store: this.artifactStore,
                          assignment: {
                            registration_name: activeRegistration.name,
                            run_id: runId,
                            state_id: assignment.stateId,
                            branch_id: assignment.branchId,
                            agent: assignment.agent,
                            task: assignment.task,
                            input_artifacts: assignment.inputArtifacts,
                          },
                          opening: serializedOpening,
                        });
                        serializedOpeningSha256 = authorization.serialized_opening_sha256;
                        serializedOpeningByteLength = authorization.serialized_opening_byte_length;
                      } catch (error) {
                        if (error instanceof PreDispatchPolicyDeniedError) throw error;
                        throw new PreDispatchPolicyDeniedError(
                          "opening_policy_denied",
                          `${guardedPhaseLabel} pre-dispatch serialized opening policy was denied`,
                          { cause: error }
                        );
                      }
                    } else {
                      preflightInputs();
                    }
                    const guard = validateModelDispatchGuardV1({
                      schema_id: MODEL_DISPATCH_GUARD_V1_SCHEMA,
                      schema_version: 1,
                      coordinate: executionCoordinate,
                      registration_sha256: runtimeRegistrationSha256(activeRegistration),
                      requested_model: requiredModel,
                      input_artifacts_sha256: sha256(canonicalJson(assignment.inputArtifacts)),
                      serialized_opening_sha256: serializedOpeningSha256,
                      serialized_opening_byte_length: serializedOpeningByteLength,
                      provider_opening_guard: providerOpeningGuard ?? "none",
                      guarded_at: new Date().toISOString(),
                    });
                    const content = canonicalJson(guard);
                    dispatchGuardRef = this.artifactStore.persist({
                      metadata: {
                        schema_version: 2,
                        run_id: runId,
                        phase: assignment.stateId,
                        branch_id: assignment.branchId,
                        kind: "model-dispatch-guard",
                        operation_id: operationId,
                        version: 1,
                        producer: "host:required-model-runtime",
                        media_type: "application/json",
                        content_schema: {
                          schema_id: MODEL_DISPATCH_GUARD_V1_SCHEMA,
                          schema_version: 1,
                        },
                        parent_ref: null,
                        upstream_refs: assignment.inputArtifacts.artifacts
                          .map((binding) => binding.ref)
                          .sort((left, right) => left.artifact_id.localeCompare(right.artifact_id)),
                      },
                      content,
                    });
                  },
                }),
            ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
          };
          const invokeModelClient = (): ReturnType<ModelClient["runAgent"]> =>
            this.modelClient.runAgent(modelInvocation);
          const browserNetworkAllowlist = registration.browser_network_allowlist;
          return browserNetworkAllowlist === undefined
            ? invokeModelClient()
            : runWithRegisteredBrowserPolicy(
                {
                  ownerScopeId: registeredBrowserPolicyOwnerScopeId({
                    projectRoot: this.options.projectRoot,
                    registrationName: activeRegistration.name,
                    runId,
                  }),
                  invocationId: workerId,
                  registrationName: activeRegistration.name,
                  stateId: assignment.stateId,
                  allowlist: browserNetworkAllowlist,
                },
                invokeModelClient
              );
        };
        try {
          completion = await Promise.race([modelPipeline(), inactivityExpired]);
        } catch (error) {
          if (
            dispatchGuardRef !== undefined &&
            !(error instanceof RemoteModelOutcomeUnknownError)
          ) {
            throw new RemoteModelOutcomeUnknownError(
              `model dispatch '${dispatchGuardRef.operation_id}' has a remote_unknown outcome; automatic replay is prohibited`,
              { cause: error }
            );
          }
          throw error;
        }
      } finally {
        renewInactivityLease = undefined;
        if (inactivityTimer !== undefined) clearTimeout(inactivityTimer);
        signal?.removeEventListener("abort", abort);
      }
      if (
        requiredModel !== undefined &&
        (observedModel === undefined || dispatchGuardRef === undefined)
      ) {
        throw new Error(
          `required model phase '${activeRegistration.name}:${assignment.stateId}' completed without observed identity and a durable dispatch guard`
        );
      }
      const stageOutput = requireNonEmptyStageOutput(completion.text);
      const endedAt = new Date().toISOString();
      const outputDigest = sha256(stageOutput);
      const receiptId = `receipt_${sha256(
        canonicalJson({
          run_id: runId,
          state_id: assignment.stateId,
          branch_id: assignment.branchId,
          agent: assignment.agent,
          attempt: assignment.attempt,
          worker_id: workerId,
          output_digest: outputDigest,
        })
      )}`;
      const artifact = this.artifactStore.persist({
        metadata: assignment.outputArtifact,
        content: stageOutput,
      });
      const persistedBytes = this.artifactStore.readById(artifact.artifact_id);
      const persistedText = persistedBytes.toString("utf8");
      const authority = this.receiptAuthority;
      if (authority === undefined) {
        throw new Error("worker receipt authority is not configured");
      }
      const repairBindingSha256 =
        assignment.routingRepairBinding === undefined
          ? undefined
          : sha256(canonicalJson(assignment.routingRepairBinding));
      const invocationDigest = trustedInvocationDigest({
        identity: assignment.identity,
        state_id: assignment.stateId,
        branch_id: assignment.branchId,
        agent: assignment.agent,
        attempt: assignment.attempt,
        trust_profile: assignment.trustProfile,
        model_override: assignment.modelOverride ?? null,
        ...(repairBindingSha256 === undefined
          ? {}
          : {
              execution_purpose: "routing_repair" as const,
              routing_repair_binding_sha256: repairBindingSha256,
            }),
        task_sha256: sha256(assignment.task),
        input_artifacts: assignment.inputArtifacts,
        output_artifact: assignment.outputArtifact,
      });
      const modelIdentityEvidence = (() => {
        if (requiredModel === undefined) return {};
        const exactObservedModel = observedModel;
        if (exactObservedModel === undefined) {
          throw new Error("required model observation disappeared before receipt signing");
        }
        return {
          requested_model: requiredModel,
          observed_model: exactObservedModel,
        };
      })();
      const signedReceipt = authority.sign({
        schema_version: 2,
        receipt_id: receiptId,
        run_id: runId,
        state_id: assignment.stateId,
        branch_id: assignment.branchId,
        agent: assignment.agent,
        attempt: assignment.attempt,
        worker_id: workerId,
        executor: "pi-sdk",
        command: ["pi-sdk", assignment.agent],
        model: assignment.modelOverride ?? null,
        ...modelIdentityEvidence,
        working_directory: this.options.projectRoot,
        trust_profile: assignment.trustProfile,
        started_at: startedAt,
        ended_at: endedAt,
        exit_code: 0,
        output_digest: outputDigest,
        output_artifact_ref: artifact,
        trusted_invocation_digest: invocationDigest,
      });
      if (requiredModel !== undefined && dispatchGuardRef !== undefined) {
        const operationId = modelExecutionReceiptOperationId(executionCoordinate);
        const executionEvidence = validateModelExecutionReceiptV1({
          schema_id: MODEL_EXECUTION_RECEIPT_V1_SCHEMA,
          schema_version: 1,
          dispatch_guard_ref: dispatchGuardRef,
          execution_receipt: signedReceipt,
        });
        const content = canonicalJson(executionEvidence);
        const prior = this.artifactStore.refFor(
          runId,
          assignment.stateId,
          assignment.branchId,
          "model-execution-receipt",
          operationId,
          1
        );
        if (prior !== null) {
          const priorBytes = this.artifactStore.readById(prior.artifact_id);
          if (prior.content_digest !== sha256(content) || priorBytes.toString("utf8") !== content) {
            throw new Error(
              `model execution receipt '${operationId}' conflicts with durable bytes`
            );
          }
        } else {
          this.artifactStore.persist({
            metadata: {
              schema_version: 2,
              run_id: runId,
              phase: assignment.stateId,
              branch_id: assignment.branchId,
              kind: "model-execution-receipt",
              operation_id: operationId,
              version: 1,
              producer: "host:required-model-runtime",
              media_type: "application/json",
              content_schema: {
                schema_id: MODEL_EXECUTION_RECEIPT_V1_SCHEMA,
                schema_version: 1,
              },
              parent_ref: null,
              upstream_refs: [dispatchGuardRef, artifact].sort((left, right) =>
                left.artifact_id.localeCompare(right.artifact_id)
              ),
            },
            content,
          });
        }
      }
      const phase = this.phaseForAssignment(activeRegistration, assignment);
      const projector = "result_projection" in phase ? phase.result_projection : undefined;
      // A declared projector is authoritative for this captured source only. Refusal must
      // never fall back to model completion metadata or a more favorable redundant footer.
      const projectedRouting = (() => {
        if (projector === undefined || assignment.executionPurpose !== "phase") return undefined;
        try {
          if (!persistedBytes.equals(Buffer.from(stageOutput, "utf8"))) {
            throw new Error("projected phase output readback differs from captured bytes");
          }
          const projected = validateContract(
            PhaseResultProjectionV1Schema,
            projector.project({
              bytes: persistedBytes,
              source: artifact,
              inputArtifacts: assignment.inputArtifacts,
              artifacts: this.artifactStore,
            }),
            "host phase result projection"
          );
          if (!("schema" in phase)) throw new Error("projection requires a catalog phase");
          return {
            confidence: projected.confidence,
            details: validateContract(phase.schema, projected.details, "projected phase details"),
          };
        } catch {
          return { confidence: "UNCERTAIN" as const, details: {} };
        }
      })();
      // Opted-in source bytes never pass through the legacy generic parsers, even on
      // refusal. Their own bounded grammar is the only interpretation of that source.
      const usesProjection = projector !== undefined && assignment.executionPurpose === "phase";
      const trustedRouting = usesProjection
        ? undefined
        : normalizeTrustedRoutingCompletion(completion);
      const persistedRouting = usesProjection
        ? undefined
        : parsePersistedRoutingSummary(persistedText);
      const persistedPhaseObject = usesProjection
        ? undefined
        : parsePersistedPhaseObject(persistedText);
      const acceptsRawPhaseObject =
        providerOpeningAdapter?.resultRoutingPolicy !== "exact_summary_only";
      const persistedPhaseRouting = (() => {
        if (
          persistedRouting !== undefined ||
          persistedPhaseObject === undefined ||
          !acceptsRawPhaseObject
        )
          return undefined;
        try {
          const phase = this.phaseForAssignment(activeRegistration, assignment);
          if (!("schema" in phase)) return undefined;
          const details = validateContract(
            phase.schema,
            persistedPhaseObject,
            `${assignment.stateId} persisted phase JSON`
          );
          return { confidence: "UNCERTAIN" as const, details };
        } catch {
          return undefined;
        }
      })();
      const correctionText = persistedText.endsWith("\n")
        ? persistedText.slice(0, -1)
        : persistedText;
      const exactSummaryOutput = /^SUMMARY:\{[^\n]*\}$/u.test(correctionText);
      const exactGuardedOutput =
        providerOpeningAdapter === undefined ||
        exactSummaryOutput ||
        (providerOpeningAdapter.resultRoutingPolicy === "exact_summary_or_phase_json" &&
          persistedPhaseObject !== undefined);
      const routingOnlyCorrection =
        (assignment.executionPurpose !== "routing_repair" || exactSummaryOutput) &&
        exactGuardedOutput;
      const routing = projectedRouting ??
        (activeRegistration.worker.result_transport === "persisted_summary"
          ? routingOnlyCorrection
            ? (persistedRouting ?? persistedPhaseRouting)
            : undefined
          : trustedRouting) ?? {
          confidence: "UNCERTAIN" as const,
          details: {},
        };
      outcome = "complete";
      return validateContract(
        PhaseResultSchema,
        {
          schema_version: 2,
          run_id: runId,
          state_id: assignment.stateId,
          agent: assignment.agent,
          attempt: assignment.attempt,
          ...(assignment.branchId ? { branch_id: assignment.branchId } : {}),
          confidence: routing.confidence,
          details: routing.details,
          output_artifact: artifact,
          worker_receipt: signedReceipt,
        },
        "worker phase result"
      );
    } catch (error) {
      if (signal?.aborted) outcome = "cancelled";
      throw error;
    } finally {
      liveness?.endWorker(runId, workerId, outcome);
    }
  }

  private activeRegistration(assignment: Assignment): PlaybookRegistration {
    const injected = this.options.registration;
    const selectedRegistration = injected ?? resolvePlaybook(assignment.identity.playbook);
    if (selectedRegistration === undefined) {
      throw new Error(
        `worker refuses unregistered playbook '${assignment.identity.playbook}' before input or model work`
      );
    }
    if (selectedRegistration.name !== assignment.identity.playbook) {
      throw new Error(
        `worker registration '${selectedRegistration.name}' does not match directive playbook '${assignment.identity.playbook}'`
      );
    }
    if (selectedRegistration.worker.kind === "none") {
      throw new Error(
        `deterministic registration '${selectedRegistration.name}' cannot enter the worker runtime`
      );
    }
    const registration = bindGenericChildYamlAuthority(
      selectedRegistration,
      this.options.projectRoot
    );
    validateRegistrationContract(registration, this.options.projectRoot);
    this.phaseForAssignment(registration, assignment);
    return registration;
  }

  private phaseForAssignment(registration: PlaybookRegistration, assignment: Assignment) {
    if (registration.worker.kind === "none") {
      throw new Error(
        `deterministic registration '${registration.name}' cannot resolve a worker phase`
      );
    }
    const direct = registration.worker.phases.get(assignment.stateId);
    if (direct?.agent === assignment.agent) return direct;
    const aliases = [...registration.worker.phases.values()].filter(
      (phase) =>
        "directive_state_id" in phase &&
        phase.directive_state_id === assignment.stateId &&
        phase.agent === assignment.agent
    );
    const alias = aliases[0];
    if (alias !== undefined && aliases.length === 1) return alias;
    throw new Error(
      `worker state/agent mismatch for '${registration.name}:${assignment.stateId}': expected '${direct?.agent ?? "unregistered"}', received '${assignment.agent}'`
    );
  }

  private resolveWorkerRegistration(
    registration: PlaybookRegistration,
    assignment: Assignment
  ): ActiveWorkerRegistrationMetadataV1 {
    if (registration.worker.kind === "none") {
      throw new Error(
        `deterministic registration '${registration.name}' cannot resolve worker metadata`
      );
    }
    const stateId = assignment.stateId;
    const phase = this.phaseForAssignment(registration, assignment);
    // Preserve absence versus presence exactly: absence means YAML equality, while a present
    // list is already part of runtimeRegistrationSha256 and must reach PiAgentClient unchanged.
    const allowedTools = "allowed_tools" in phase ? phase.allowed_tools : undefined;
    const genericChildPhase = registration.generic_child?.provider.phases.find(
      (candidate) => candidate.state_id === stateId
    );
    const genericChildYamlAuthority: GenericChildCatalogAgentYamlMaximumCarrierV1 | undefined =
      genericChildPhase?.tool_authority.carrier === "catalog_agent_yaml_maximum"
        ? genericChildPhase.tool_authority
        : undefined;
    const browserNetworkAllowlist =
      "browser_network_allowlist" in phase ? phase.browser_network_allowlist : undefined;
    const guidanceStateId = "guidance_state_id" in phase ? phase.guidance_state_id : undefined;
    const requiredModel = "required_model" in phase ? phase.required_model : undefined;
    const providerOpeningGuard =
      "provider_opening_guard" in phase ? phase.provider_opening_guard : undefined;
    const requiresImageInput =
      "requires_image_input" in phase ? phase.requires_image_input : undefined;
    const resultProjection = "result_projection" in phase ? phase.result_projection : undefined;
    return {
      playbook_name: registration.name,
      workflow_name: registration.worker.workflow_name,
      guidance: registration.worker.guidance,
      ...(registration.worker.documentation_sources === undefined
        ? {}
        : { documentation_sources: registration.worker.documentation_sources }),
      ...(registration.worker.prompt_sources === undefined
        ? {}
        : { prompt_sources: registration.worker.prompt_sources }),
      result_transport: registration.worker.result_transport,
      ...(resultProjection === undefined
        ? {}
        : { result_projection: resultProjection.declaration }),
      opening_policy: registration.worker.opening_policy,
      model_policy: registration.worker.model_policy,
      ...(allowedTools === undefined ? {} : { allowed_tools: [...allowedTools] }),
      ...(genericChildYamlAuthority === undefined
        ? {}
        : { generic_child_yaml_authority: genericChildYamlAuthority }),
      ...(browserNetworkAllowlist === undefined
        ? {}
        : { browser_network_allowlist: browserNetworkAllowlist }),
      ...(guidanceStateId === undefined ? {} : { guidance_state_id: guidanceStateId }),
      ...(requiredModel === undefined ? {} : { required_model: requiredModel }),
      ...(providerOpeningGuard === undefined
        ? {}
        : { provider_opening_guard: providerOpeningGuard }),
      ...(requiresImageInput === undefined ? {} : { requires_image_input: requiresImageInput }),
    };
  }

  private assertRepairInputBinding(assignment: Assignment): void {
    if (assignment.executionPurpose !== "routing_repair") return;
    const binding = assignment.routingRepairBinding;
    const inputs = assignment.inputArtifacts.artifacts.filter(
      (input) => input.designation !== "context"
    );
    if (
      binding === undefined ||
      inputs.length !== 1 ||
      canonicalJson(inputs[0]?.ref ?? null) !== canonicalJson(binding.source_artifact_ref)
    ) {
      throw new LivenessExhaustedError("routing_repair_binding_invalid");
    }
  }

  acceptArtifact(result: PhaseResult): void {
    if (result.output_artifact === undefined) {
      throw new Error("accepted worker result is missing output_artifact");
    }
    if (result.output_artifact.kind !== "routing-metadata") {
      this.artifactStore.select(result.output_artifact);
    }
  }

  private async mapConcurrentSettled<TInput, TOutput>(
    inputs: readonly TInput[],
    concurrency: number,
    operation: (input: TInput) => Promise<TOutput>,
    signal?: AbortSignal,
    onFulfilled?: (value: TOutput) => void
  ): Promise<Array<SettledOutput<TOutput>>> {
    const output = new Array<SettledOutput<TOutput>>(inputs.length);
    let nextIndex = 0;
    const worker = async (): Promise<void> => {
      while (nextIndex < inputs.length && !signal?.aborted) {
        const index = nextIndex;
        nextIndex += 1;
        const input = inputs[index];
        if (input === undefined) throw new Error(`missing parallel assignment at index ${index}`);
        try {
          const value = await operation(input);
          output[index] = { status: "fulfilled", value };
          onFulfilled?.(value);
        } catch (error) {
          output[index] = { status: "rejected", error };
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, inputs.length) }, () => worker()));
    return output.filter((entry) => entry !== undefined);
  }

  private async mapConcurrent<TInput, TOutput>(
    inputs: readonly TInput[],
    concurrency: number,
    operation: (input: TInput) => Promise<TOutput>,
    signal?: AbortSignal
  ): Promise<TOutput[]> {
    const output = new Array<TOutput>(inputs.length);
    let nextIndex = 0;
    const worker = async (): Promise<void> => {
      while (nextIndex < inputs.length && !signal?.aborted) {
        const index = nextIndex;
        nextIndex += 1;
        const input = inputs[index];
        if (input === undefined) {
          throw new Error(`missing parallel assignment at index ${index}`);
        }
        output[index] = await operation(input);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, inputs.length) }, () => worker()));
    if (signal?.aborted) throw new Error("parallel worker execution was cancelled");
    return output;
  }
}

export class OrchestrationRunner {
  constructor(
    private readonly engine: OrchestrationEngine,
    private readonly workers: WorkerExecutor,
    private readonly childWorkflows?: ChildWorkflowRuntimeOwner,
    private readonly hostOperations?: HostOperationRuntimeOwner
  ) {
    this.workers.setReceiptAuthority(this.engine.receiptAuthority);
    this.workers.setLivenessController(this.engine.liveness);
  }

  async runUntilBoundary(
    initial: Directive,
    signal?: AbortSignal,
    onProgress?: OrchestrationProgressSink,
    onActivity?: OrchestrationWorkerActivitySink
  ): Promise<Directive> {
    // Closing this local sink before return prevents a non-cooperative worker
    // from publishing a late update after a durable terminal boundary.
    let progress = onProgress;
    const finish = (directive: Directive): Directive => {
      const boundary = this.finish(directive, progress);
      progress = undefined;
      return boundary;
    };
    let current = this.engine.authorizeDispatch(initial);
    if (current.action === "cancelled") {
      this.childWorkflows?.cancelParent(current.identity.run_id);
    }
    while (
      current.action === "invoke_agent" ||
      current.action === "invoke_agents_parallel" ||
      current.action === "invoke_child_workflow" ||
      current.action === "invoke_host_operation"
    ) {
      if (signal?.aborted) {
        return finish(
          this.engine.handle({
            schema_version: 2,
            action: "cancel",
            identity: current.identity,
            reason: "cancelled by caller",
          })
        );
      }
      if (current.action === "invoke_host_operation") {
        if (this.hostOperations === undefined) {
          return finish(this.engine.refuseHostOperationDispatch(current));
        }
        const operationId = current.operation_id;
        const operationKind = current.operation_kind;
        const operationStateId = current.state_id;
        const operationRunId = current.identity.run_id;
        const operationPlaybook = current.identity.playbook;
        current = this.engine.authorizeDispatch(
          await this.hostOperations.dispatch(this.engine, current, signal, (hostProgress) =>
            this.emitProgress(progress, {
              event: "host_operation_progress",
              run_id: operationRunId,
              playbook: operationPlaybook,
              state_id: operationStateId,
              operation_id: operationId,
              operation_kind: operationKind,
              progress: hostProgress,
            })
          )
        );
        continue;
      }
      if (current.action === "invoke_child_workflow") {
        if (this.childWorkflows === undefined) {
          return finish(this.engine.refuseChildWorkflowDispatch(current));
        }
        current = this.engine.authorizeDispatch(
          await this.childWorkflows.dispatch(this.engine, current, signal)
        );
        if (signal?.aborted) {
          return finish(
            this.engine.handle({
              schema_version: 2,
              action: "cancel",
              identity: current.identity,
              reason: "cancelled by caller",
            })
          );
        }
        const terminal =
          current.action === "complete" ||
          current.action === "incomplete" ||
          current.action === "error" ||
          current.action === "cancelled";
        if (terminal) return finish(current);
        continue;
      }
      const active = current;
      const workers = this.progressWorkers(active);
      this.emitProgress(progress, {
        event: "phase_started",
        run_id: active.identity.run_id,
        playbook: active.identity.playbook,
        state_id: active.state_id,
        workers,
      });

      // Keep owner-complete results reachable even when another branch outlives
      // cancellation grace; the engine reorders this batch by stable branch order.
      const completedResults: PhaseResult[] = [];
      const execution = this.workers.executeSettled(
        active,
        signal,
        (result) => {
          completedResults.push(result);
          const worker = workers.find(
            (candidate) =>
              candidate.state_id === result.state_id &&
              candidate.agent === result.agent &&
              candidate.attempt === result.attempt &&
              candidate.branch_id === (result.branch_id ?? null)
          );
          if (worker === undefined) return;
          this.emitProgress(progress, {
            event: "worker_completed",
            run_id: active.identity.run_id,
            playbook: active.identity.playbook,
            state_id: result.state_id,
            worker,
            completed_workers: completedResults.length,
            total_workers: workers.length,
          });
        },
        onActivity
      );
      const settlement = await this.settleWithinCancellationGrace(execution, signal);
      const cancellationGraceExpired = settlement === undefined;
      const results = settlement?.results ?? completedResults;
      if (results.length > 0) {
        current = this.engine.authorizeDispatch(
          this.engine.acceptWorkerResults(active.identity, results)
        );
        for (const result of results) this.workers.acceptArtifact(result);
      }
      const terminal =
        current.action === "complete" ||
        current.action === "incomplete" ||
        current.action === "error" ||
        current.action === "cancelled";
      if (terminal) return finish(current);
      if (cancellationGraceExpired) {
        return finish(
          this.engine.handle({
            schema_version: 2,
            action: "cancel",
            identity: current.identity,
            reason: "cancelled by caller",
          })
        );
      }
      const preDispatchPolicyDenial = settlement.errors.find(
        (error): error is PreDispatchPolicyDeniedError =>
          error instanceof PreDispatchPolicyDeniedError
      );
      if (preDispatchPolicyDenial !== undefined) {
        return finish(
          this.engine.handle({
            schema_version: 2,
            action: "cancel",
            identity: current.identity,
            reason: `pre-dispatch policy denied [${preDispatchPolicyDenial.blockerCode}]: ${preDispatchPolicyDenial.message}`,
          })
        );
      }
      const remoteUnknown = settlement.errors.find(
        (error): error is RemoteModelOutcomeUnknownError =>
          error instanceof RemoteModelOutcomeUnknownError
      );
      if (remoteUnknown !== undefined) {
        return finish(
          this.engine.handle({
            schema_version: 2,
            action: "cancel",
            identity: current.identity,
            reason:
              "model call outcome remote_unknown; durable dispatch fencing prohibits automatic replay",
          })
        );
      }
      const exhaustion = settlement.errors.find(
        (error): error is LivenessExhaustedError => error instanceof LivenessExhaustedError
      );
      if (exhaustion !== undefined) {
        return finish(this.engine.exhaust(current.identity, exhaustion.reason));
      }
      if (signal?.aborted) {
        return finish(
          this.engine.handle({
            schema_version: 2,
            action: "cancel",
            identity: current.identity,
            reason: "cancelled by caller",
          })
        );
      }
      const failure = settlement.errors[0];
      if (failure !== undefined) {
        this.emitProgress(progress, {
          event: "worker_failed",
          run_id: active.identity.run_id,
          playbook: active.identity.playbook,
          state_id: active.state_id,
          failed_workers: settlement.errors.length,
          total_workers: workers.length,
        });
        progress = undefined;
        throw failure;
      }
    }
    return finish(current);
  }

  private progressWorkers(
    directive: Extract<Directive, { action: "invoke_agent" | "invoke_agents_parallel" }>
  ): OrchestrationProgressWorker[] {
    if (directive.action === "invoke_agent") {
      return [
        {
          state_id: directive.state_id,
          agent: directive.agent,
          attempt: directive.attempt,
          branch_id: null,
          execution_purpose: directive.execution_purpose ?? "phase",
        },
      ];
    }
    return directive.branches.map((branch) => ({
      state_id: branch.state_id,
      agent: branch.agent,
      attempt: branch.attempt,
      branch_id: branch.branch_id,
      execution_purpose: branch.execution_purpose ?? "phase",
    }));
  }

  private finish(directive: Directive, onProgress?: OrchestrationProgressSink): Directive {
    if (
      directive.action === "invoke_agent" ||
      directive.action === "invoke_agents_parallel" ||
      directive.action === "invoke_child_workflow" ||
      directive.action === "invoke_host_operation"
    ) {
      return directive;
    }
    this.emitProgress(onProgress, {
      event: "boundary_reached",
      run_id: directive.identity.run_id,
      playbook: directive.identity.playbook,
      action: directive.action,
      ...("state_id" in directive ? { state_id: directive.state_id } : {}),
    });
    return directive;
  }

  private emitProgress(
    onProgress: OrchestrationProgressSink | undefined,
    event: OrchestrationProgressEvent
  ): void {
    try {
      onProgress?.(event);
    } catch {
      // Progress is observational and must never change durable execution truth.
    }
  }

  private async settleWithinCancellationGrace(
    execution: Promise<WorkerExecutionSettlement>,
    signal?: AbortSignal
  ): Promise<WorkerExecutionSettlement | undefined> {
    if (signal === undefined) return execution;
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    const grace = new Promise<undefined>((resolve) => {
      const startGrace = (): void => {
        timer = setTimeout(() => resolve(undefined), CANCELLATION_GRACE_MS);
      };
      if (signal.aborted) startGrace();
      else {
        onAbort = startGrace;
        signal.addEventListener("abort", startGrace, { once: true });
      }
    });
    try {
      return await Promise.race([execution, grace]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
    }
  }
}
