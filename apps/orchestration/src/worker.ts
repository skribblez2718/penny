import { randomUUID } from "node:crypto";

import { ArtifactStore } from "./artifact-store.js";
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
import {
  requireNonEmptyStageOutput,
  type ActiveWorkerRegistrationMetadataV1,
  type ModelClient,
} from "./model-client.js";
import {
  LivenessController,
  LivenessExhaustedError,
  researchThinkingLevelForLivenessPreset,
} from "./liveness.js";
import {
  resolvePlaybook,
  validateRegistrationContract,
  type PlaybookRegistrationV1,
} from "./playbooks/registry.js";
import { ReceiptAuthority, trustedInvocationDigest } from "./receipts.js";
import type { ResearchContextOwnerV1 } from "./research-context.js";

const CANCELLATION_GRACE_MS = 5_000;

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
  registration: PlaybookRegistrationV1,
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
  const match = finalLine?.match(/^SUMMARY:(\{[^\n]*\})$/u);
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
      readonly event: "boundary_reached";
      readonly run_id: string;
      readonly playbook: string;
      readonly action: Exclude<Directive["action"], "invoke_agent" | "invoke_agents_parallel">;
      readonly state_id?: string;
    };

export type OrchestrationProgressSink = (event: OrchestrationProgressEvent) => void;

type SettledOutput<T> =
  | { readonly status: "fulfilled"; readonly value: T }
  | { readonly status: "rejected"; readonly error: unknown };

export interface WorkerExecutorOptions {
  readonly projectRoot: string;
  readonly parallelConcurrency: number;
  readonly workerTimeoutMs?: number;
  /**
   * Exact engine registration. It is the only source for an orchestration phase subset;
   * ordinary direct/parallel/chain subagent paths do not pass through this seam.
   */
  readonly registration?: PlaybookRegistrationV1;
  /** Re-resolves selected safe context envelopes before model/session work. */
  readonly researchContext?: ResearchContextOwnerV1;
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
        (assignment) => this.executeAssignment(assignment, signal)
      );
    }
    throw new Error(`directive '${directive.action}' is not executable by a worker`);
  }

  async executeSettled(
    directive: Directive,
    signal?: AbortSignal,
    onResult?: (result: PhaseResult) => void
  ): Promise<WorkerExecutionSettlement> {
    if (directive.action === "invoke_agent") {
      try {
        const results = await this.execute(directive, signal);
        for (const result of results) onResult?.(result);
        return { results, errors: [] };
      } catch (error) {
        return { results: [], errors: [error] };
      }
    }
    if (directive.action !== "invoke_agents_parallel") {
      throw new Error(`directive '${directive.action}' is not executable by a worker`);
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
      (assignment) => this.executeAssignment(assignment, signal),
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
    signal?: AbortSignal
  ): Promise<PhaseResult> {
    const runId = assignment.identity.run_id;
    const workerId = randomUUID();
    const liveness = this.liveness?.hasPolicy(runId) === true ? this.liveness : undefined;
    const activeRegistration = this.activeRegistration(assignment);
    const registration = this.resolveWorkerRegistration(activeRegistration, assignment.stateId);
    const boundPolicy = liveness?.policy(runId);
    const thinkingLevel =
      activeRegistration.liveness.thinking_policy === "research_preset" && boundPolicy !== undefined
        ? researchThinkingLevelForLivenessPreset(boundPolicy.preset)
        : undefined;
    this.assertRepairInputBinding(assignment);
    const hasContextRefs = assignment.inputArtifacts.artifacts.some(
      (binding) => binding.ref.kind === "context-source-ref"
    );
    if (hasContextRefs && this.options.researchContext === undefined) {
      throw new Error("research context refs require the owner resolver before worker use");
    }
    const contextOverlays =
      this.options.researchContext?.resolveOverlays(
        assignment.inputArtifacts.artifacts.map((binding) => binding.ref),
        assignment.stateId
      ) ?? [];
    liveness?.admitInvocation({
      runId,
      stateId: assignment.stateId,
      branchId: assignment.branchId,
      attempt: assignment.attempt,
      purpose: assignment.executionPurpose,
    });
    // Communication preflight is complete before any model/session work.
    for (const binding of assignment.inputArtifacts.artifacts) {
      this.artifactStore.read(binding.ref);
    }
    liveness?.startWorker({
      runId,
      workerId,
      stateId: assignment.stateId,
      branchId: assignment.branchId,
      purpose: assignment.executionPurpose,
    });
    const livenessInvocation =
      liveness === undefined
        ? {}
        : {
            liveness: liveness.sessionSink({
              runId,
              workerId,
              stateId: assignment.stateId,
            }),
            livenessBudget: liveness.workerPromptBudget(runId, workerId),
          };
    let outcome: "complete" | "error" | "cancelled" = "error";
    try {
      const startedAt = new Date().toISOString();
      const configuredTimeoutMs = this.options.workerTimeoutMs ?? 15 * 60 * 1_000;
      if (!Number.isSafeInteger(configuredTimeoutMs) || configuredTimeoutMs <= 0) {
        throw new Error("workerTimeoutMs must be a positive integer");
      }
      const policyTimeoutMs = liveness?.remainingWorkerWallMs(runId, workerId);
      const timeoutMs = Math.min(configuredTimeoutMs, policyTimeoutMs ?? configuredTimeoutMs);
      if (timeoutMs <= 0) {
        throw new LivenessExhaustedError("worker_wall_clock_exhausted");
      }
      const controller = new AbortController();
      const abort = (): void => controller.abort(signal?.reason);
      if (signal?.aborted) {
        abort();
      } else {
        signal?.addEventListener("abort", abort, { once: true });
      }
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new LivenessExhaustedError("worker_wall_clock_exhausted"));
        }, timeoutMs);
      });
      let completion;
      try {
        completion = await Promise.race([
          this.modelClient.runAgent({
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
            ...(assignment.modelOverride ? { modelOverride: assignment.modelOverride } : {}),
            ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
          }),
          timeout,
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
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
      const persistedText = this.artifactStore.readById(artifact.artifact_id).toString("utf8");
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
        working_directory: this.options.projectRoot,
        trust_profile: assignment.trustProfile,
        started_at: startedAt,
        ended_at: endedAt,
        exit_code: 0,
        output_digest: outputDigest,
        output_artifact_ref: artifact,
        trusted_invocation_digest: invocationDigest,
      });
      const trustedRouting = normalizeTrustedRoutingCompletion(completion);
      const persistedRouting = parsePersistedRoutingSummary(persistedText);
      const correctionText = persistedText.endsWith("\n")
        ? persistedText.slice(0, -1)
        : persistedText;
      const routingOnlyCorrection =
        assignment.executionPurpose !== "routing_repair" ||
        /^SUMMARY:\{[^\n]*\}$/u.test(correctionText);
      const routing = (activeRegistration.worker.result_transport === "persisted_summary"
        ? routingOnlyCorrection
          ? persistedRouting
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

  private activeRegistration(assignment: Assignment): PlaybookRegistrationV1 {
    const injected = this.options.registration;
    const registration = injected ?? resolvePlaybook(assignment.identity.playbook);
    if (registration === undefined) {
      throw new Error(
        `worker refuses unregistered playbook '${assignment.identity.playbook}' before input or model work`
      );
    }
    if (registration.name !== assignment.identity.playbook) {
      throw new Error(
        `worker registration '${registration.name}' does not match directive playbook '${assignment.identity.playbook}'`
      );
    }
    validateRegistrationContract(registration);
    const phase = registration.worker.phases.get(assignment.stateId);
    if (phase === undefined || phase.agent !== assignment.agent) {
      throw new Error(
        `worker state/agent mismatch for '${registration.name}:${assignment.stateId}': expected '${phase?.agent ?? "unregistered"}', received '${assignment.agent}'`
      );
    }
    return registration;
  }

  private resolveWorkerRegistration(
    registration: PlaybookRegistrationV1,
    stateId: string
  ): ActiveWorkerRegistrationMetadataV1 {
    const phase = registration.worker.phases.get(stateId);
    if (phase === undefined) {
      throw new Error(`active registration has no worker phase '${stateId}'`);
    }
    // Preserve absence versus presence exactly: absence means YAML equality, while a present
    // list is already part of runtimeRegistrationSha256 and must reach PiAgentClient unchanged.
    const allowedTools = "allowed_tools" in phase ? phase.allowed_tools : undefined;
    return {
      playbook_name: registration.name,
      workflow_name: registration.worker.workflow_name,
      guidance: registration.worker.guidance,
      result_transport: registration.worker.result_transport,
      opening_policy: registration.worker.opening_policy,
      model_policy: registration.worker.model_policy,
      ...(allowedTools === undefined ? {} : { allowed_tools: [...allowedTools] }),
    };
  }

  private assertRepairInputBinding(assignment: Assignment): void {
    if (assignment.executionPurpose !== "routing_repair") return;
    const binding = assignment.routingRepairBinding;
    const inputs = assignment.inputArtifacts.artifacts;
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
    operation: (input: TInput) => Promise<TOutput>
  ): Promise<TOutput[]> {
    const output = new Array<TOutput>(inputs.length);
    let nextIndex = 0;
    const worker = async (): Promise<void> => {
      while (nextIndex < inputs.length) {
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
    return output;
  }
}

export class OrchestrationRunner {
  constructor(
    private readonly engine: OrchestrationEngine,
    private readonly workers: WorkerExecutor
  ) {
    this.workers.setReceiptAuthority(this.engine.receiptAuthority);
    this.workers.setLivenessController(this.engine.liveness);
  }

  async runUntilBoundary(
    initial: Directive,
    signal?: AbortSignal,
    onProgress?: OrchestrationProgressSink
  ): Promise<Directive> {
    // Closing this local sink before return prevents a non-cooperative worker
    // from publishing a late update after a durable terminal boundary.
    let progress = onProgress;
    const finish = (directive: Directive): Directive => {
      const boundary = this.finish(directive, progress);
      progress = undefined;
      return boundary;
    };
    let current = initial;
    while (current.action === "invoke_agent" || current.action === "invoke_agents_parallel") {
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
      const execution = this.workers.executeSettled(active, signal, (result) => {
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
      });
      const settlement = await this.settleWithinCancellationGrace(execution, signal);
      const cancellationGraceExpired = settlement === undefined;
      const results = settlement?.results ?? completedResults;
      if (results.length > 0) {
        current = this.engine.acceptWorkerResults(active.identity, results);
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
    if (directive.action === "invoke_agent" || directive.action === "invoke_agents_parallel") {
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
