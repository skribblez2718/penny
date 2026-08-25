import { ArtifactStore } from "./artifact-store.js";
import { Checkpointer } from "./checkpointer.js";
import { loadRuntimeConfig, type RuntimeConfig } from "./config.js";
import type { Directive } from "./contracts.js";
import { OrchestrationEngine } from "./engine.js";
import { KbWorkerClient } from "./kb/kb-worker-client.js";
import { PiAgentClient, type ModelClient, type InlineExtension } from "./model-client.js";
import { ObservabilityClient } from "./observability.js";
import { OrchestrationRunner, WorkerExecutor } from "./worker.js";

export interface OrchestrationServiceOptions {
  readonly projectRoot: string;
  readonly env?: NodeJS.ProcessEnv;
  /**
   * The `ModelClient` the worker executor drives. Research passes the default
   * (or omits it); KB passes a `KbWorkerClient` with the §5.8 private-reader
   * posture. Since each service instance owns exactly one engine/playbook, the
   * right client is a caller decision, not a runtime dispatch.
   */
  readonly modelClient?: ModelClient;
  readonly dispatchMode?: () => string | undefined;
  /** Owner-supplied worker extension factories (e.g. worker-read memory). Not a tool list. */
  readonly workerExtensions?: readonly InlineExtension[];
  /**
   * Which registered playbook this service drives ('knowledge-base' for the KB
   * skill). Defaults to the sole production playbook (research).
   */
  readonly playbookName?: string;
}

export class OrchestrationService implements Disposable {
  readonly config: RuntimeConfig;
  readonly checkpointer: Checkpointer;
  readonly artifacts: ArtifactStore;
  readonly engine: OrchestrationEngine;
  readonly workers: WorkerExecutor;
  readonly runner: OrchestrationRunner;

  constructor(options: OrchestrationServiceOptions) {
    const env = options.env ?? process.env;
    this.config = loadRuntimeConfig(options.projectRoot, env);
    const observability = new ObservabilityClient({ env });
    this.checkpointer = new Checkpointer(this.config.dbPath, observability.observe, {
      projectId: this.config.projectId,
    });
    this.artifacts = new ArtifactStore(this.config.artifactRoot, {
      projectId: this.config.projectId,
    });
    this.engine = new OrchestrationEngine(this.checkpointer, {
      projectRoot: this.config.projectRoot,
      maxSteps: this.config.maxSteps,
      receiptKeyPath: this.config.receiptKeyPath,
      artifactRevisions: this.artifacts,
      ...(options.dispatchMode ? { dispatchMode: options.dispatchMode } : {}),
      ...(options.playbookName ? { playbookName: options.playbookName } : {}),
    });
    const client =
      options.modelClient ??
      new PiAgentClient({
        ...(options.workerExtensions ? { workerExtensions: options.workerExtensions } : {}),
      });
    if (client instanceof KbWorkerClient) client.bindCheckpointer(this.checkpointer);
    this.workers = new WorkerExecutor(client, this.artifacts, {
      projectRoot: this.config.projectRoot,
      parallelConcurrency: this.config.parallelConcurrency,
      workerTimeoutMs: this.config.workerTimeoutMs,
    });
    // The workers sign receipts with the engine's authority so the engine can
    // verify them. Without this wiring, every agent-driven run fails open at the
    // receipt gate.
    this.workers.setReceiptAuthority(this.engine.receiptAuthority);
    this.runner = new OrchestrationRunner(this.engine, this.workers);
  }

  handle(request: unknown): Directive {
    return this.engine.handle(request);
  }

  async execute(request: unknown, signal?: AbortSignal): Promise<Directive> {
    return this.runner.runUntilBoundary(this.engine.handle(request), signal);
  }

  close(): void {
    this.artifacts.close();
    this.checkpointer.close();
  }

  [Symbol.dispose](): void {
    this.close();
  }
}
