import { randomUUID } from "node:crypto";

import { ArtifactStore } from "./artifact-store.js";
import { canonicalJson, sha256 } from "./checkpointer.js";
import {
  PhaseResultSchema,
  type Directive,
  type InputArtifacts,
  type OutputArtifactMetadata,
  type PhaseResult,
  type RunIdentity,
  validateContract,
} from "./contracts.js";
import { OrchestrationEngine } from "./engine.js";
import { parseSummaryFromText, type ModelClient } from "./model-client.js";
import { ReceiptAuthority, trustedInvocationDigest } from "./receipts.js";

interface Assignment {
  readonly identity: RunIdentity;
  readonly stateId: string;
  readonly branchId: string | null;
  readonly agent: string;
  readonly attempt: number;
  readonly trustProfile: "trusted-interactive" | "hardened-untrusted";
  readonly modelOverride?: string;
  readonly task: string;
  readonly inputArtifacts: InputArtifacts;
  readonly outputArtifact: OutputArtifactMetadata;
}

export interface WorkerExecutorOptions {
  readonly projectRoot: string;
  readonly parallelConcurrency: number;
  readonly workerTimeoutMs?: number;
}

export class WorkerExecutor {
  private receiptAuthority: ReceiptAuthority | undefined;

  constructor(
    private readonly modelClient: ModelClient,
    private readonly artifactStore: ArtifactStore,
    private readonly options: WorkerExecutorOptions
  ) {}

  setReceiptAuthority(authority: ReceiptAuthority): void {
    this.receiptAuthority = authority;
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

  private async executeAssignment(
    assignment: Assignment,
    signal?: AbortSignal
  ): Promise<PhaseResult> {
    const workerId = randomUUID();
    const startedAt = new Date().toISOString();
    const timeoutMs = this.options.workerTimeoutMs ?? 15 * 60 * 1_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw new Error("workerTimeoutMs must be a positive integer");
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
        reject(
          new Error(
            `worker timed out after ${timeoutMs}ms for ${assignment.stateId}/${assignment.branchId ?? "single"}`
          )
        );
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
          artifactConsumer: assignment.inputArtifacts.consumer,
          signal: controller.signal,
          ...(assignment.modelOverride ? { modelOverride: assignment.modelOverride } : {}),
        }),
        timeout,
      ]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      signal?.removeEventListener("abort", abort);
    }
    const endedAt = new Date().toISOString();
    const outputDigest = sha256(completion.text);
    const receiptId = `receipt_${sha256(
      canonicalJson({
        run_id: assignment.identity.run_id,
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
      content: completion.text,
    });
    const authority = this.receiptAuthority;
    if (authority === undefined) {
      throw new Error("worker receipt authority is not configured");
    }
    const invocationDigest = trustedInvocationDigest({
      identity: assignment.identity,
      state_id: assignment.stateId,
      branch_id: assignment.branchId,
      agent: assignment.agent,
      attempt: assignment.attempt,
      trust_profile: assignment.trustProfile,
      model_override: assignment.modelOverride ?? null,
      task_sha256: sha256(assignment.task),
      input_artifacts: assignment.inputArtifacts,
      output_artifact: assignment.outputArtifact,
    });
    const signedReceipt = authority.sign({
      schema_version: 2,
      receipt_id: receiptId,
      run_id: assignment.identity.run_id,
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
    let routing;
    if (completion.confidence !== undefined && completion.details !== undefined) {
      routing = {
        confidence: completion.confidence,
        details: completion.details,
      };
    } else {
      try {
        routing = parseSummaryFromText(completion.text);
      } catch {
        // Persisted exact bytes remain authoritative. The engine accepts the signed
        // owner wrapper, records a malformed-result event, and reissues a versioned
        // output contract without trusting invented domain defaults.
        routing = { confidence: "UNCERTAIN" as const, details: {} };
      }
    }
    return validateContract(
      PhaseResultSchema,
      {
        schema_version: 2,
        run_id: assignment.identity.run_id,
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
  }

  acceptArtifact(result: PhaseResult): void {
    if (result.output_artifact === undefined) {
      throw new Error("accepted worker result is missing output_artifact");
    }
    this.artifactStore.select(result.output_artifact);
  }

  private async mapConcurrent<TInput, TOutput>(
    inputs: readonly TInput[],
    concurrency: number,
    operation: (input: TInput) => Promise<TOutput>
  ): Promise<TOutput[]> {
    const output: TOutput[] = new Array(inputs.length);
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
  }

  async runUntilBoundary(initial: Directive, signal?: AbortSignal): Promise<Directive> {
    let current = initial;
    while (current.action === "invoke_agent" || current.action === "invoke_agents_parallel") {
      if (signal?.aborted) {
        throw new Error("orchestration execution aborted");
      }
      const results = await this.workers.execute(current, signal);
      for (const result of results) {
        current = this.engine.handle({
          schema_version: 2,
          action: "step",
          identity: current.identity,
          result,
        });
        this.workers.acceptArtifact(result);
      }
    }
    return current;
  }
}
