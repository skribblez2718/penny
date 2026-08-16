import { randomUUID } from "node:crypto";

import { ArtifactStore } from "./artifact-store.js";
import { canonicalJson, sha256 } from "./checkpointer.js";
import {
  PhaseResultSchema,
  type BranchDispatch,
  type Directive,
  type PhaseResult,
  type RunIdentity,
  validateContract,
} from "./contracts.js";
import { OrchestrationEngine } from "./engine.js";
import type { ModelClient } from "./model-client.js";

const CONSUMER_SCOPE = [
  "agent:carren",
  "agent:echo",
  "agent:piper",
  "agent:skribble",
  "agent:synthia",
  "agent:vera",
];

interface Assignment {
  readonly identity: RunIdentity;
  readonly stateId: string;
  readonly branchId: string | null;
  readonly agent: string;
  readonly attempt: number;
  readonly trustProfile: "trusted-interactive" | "hardened-untrusted";
  readonly modelOverride?: string;
  readonly task: string;
  readonly inputArtifacts: BranchDispatch["input_artifacts"];
}

export interface WorkerExecutorOptions {
  readonly projectRoot: string;
  readonly parallelConcurrency: number;
  readonly workerTimeoutMs?: number;
}

export class WorkerExecutor {
  constructor(
    private readonly modelClient: ModelClient,
    private readonly artifactStore: ArtifactStore,
    private readonly options: WorkerExecutorOptions
  ) {}

  async execute(directive: Directive): Promise<PhaseResult[]> {
    if (directive.action === "invoke_agent") {
      return [
        await this.executeAssignment({
          identity: directive.identity,
          stateId: directive.state_id,
          branchId: null,
          agent: directive.agent,
          attempt: directive.attempt,
          trustProfile: directive.trust_profile,
          ...(directive.model_override ? { modelOverride: directive.model_override } : {}),
          task: directive.task,
          inputArtifacts: directive.input_artifacts,
        }),
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
        })
      );
      return this.mapConcurrent(
        assignments,
        Math.max(1, this.options.parallelConcurrency),
        (assignment) => this.executeAssignment(assignment)
      );
    }
    throw new Error(`directive '${directive.action}' is not executable by a worker`);
  }

  private async executeAssignment(assignment: Assignment): Promise<PhaseResult> {
    const workerId = randomUUID();
    const startedAt = new Date().toISOString();
    const timeoutMs = this.options.workerTimeoutMs ?? 15 * 60 * 1_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw new Error("workerTimeoutMs must be a positive integer");
    }
    const controller = new AbortController();
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
          inputArtifacts: assignment.inputArtifacts,
          signal: controller.signal,
          ...(assignment.modelOverride ? { modelOverride: assignment.modelOverride } : {}),
        }),
        timeout,
      ]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
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
      runId: assignment.identity.run_id,
      phase: assignment.stateId,
      branchId: assignment.branchId,
      operationId: receiptId,
      producer: `agent:${assignment.agent}`,
      consumerScope: CONSUMER_SCOPE,
      content: completion.text,
    });
    return validateContract(
      PhaseResultSchema,
      {
        schema_version: 2,
        run_id: assignment.identity.run_id,
        state_id: assignment.stateId,
        agent: assignment.agent,
        attempt: assignment.attempt,
        ...(assignment.branchId ? { branch_id: assignment.branchId } : {}),
        confidence: completion.confidence,
        details: completion.details,
        output_artifact: artifact,
        worker_receipt: {
          schema_version: 2,
          receipt_id: receiptId,
          run_id: assignment.identity.run_id,
          state_id: assignment.stateId,
          agent: assignment.agent,
          attempt: assignment.attempt,
          worker_id: workerId,
          started_at: startedAt,
          ended_at: endedAt,
          exit_code: 0,
          output_digest: outputDigest,
        },
      },
      "worker phase result"
    );
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
        output[index] = await operation(inputs[index]!);
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
  ) {}

  async runUntilBoundary(initial: Directive): Promise<Directive> {
    let current = initial;
    while (current.action === "invoke_agent" || current.action === "invoke_agents_parallel") {
      const results = await this.workers.execute(current);
      for (const result of results) {
        current = this.engine.handle({
          schema_version: 2,
          action: "step",
          identity: current.identity,
          result,
        });
      }
    }
    return current;
  }
}
