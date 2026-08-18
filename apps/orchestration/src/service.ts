import { ArtifactStore } from "./artifact-store.js";
import { Checkpointer } from "./checkpointer.js";
import { loadRuntimeConfig, type RuntimeConfig } from "./config.js";
import type { Directive } from "./contracts.js";
import { OrchestrationEngine } from "./engine.js";
import { PiAgentClient, type ModelClient, type InlineExtension } from "./model-client.js";
import { ObservabilityClient } from "./observability.js";
import { OrchestrationRunner, WorkerExecutor } from "./worker.js";

export interface OrchestrationServiceOptions {
  readonly projectRoot: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly modelClient?: ModelClient;
  readonly dispatchMode?: () => string | undefined;
  /** Owner-supplied worker extension factories (e.g. worker-read memory). Not a tool list. */
  readonly workerExtensions?: readonly InlineExtension[];
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
    this.checkpointer = new Checkpointer(this.config.dbPath, observability.observe);
    this.artifacts = new ArtifactStore(this.config.artifactRoot);
    this.engine = new OrchestrationEngine(this.checkpointer, {
      projectRoot: this.config.projectRoot,
      maxSteps: this.config.maxSteps,
      artifactRevisions: this.artifacts,
      ...(options.dispatchMode ? { dispatchMode: options.dispatchMode } : {}),
    });
    const client =
      options.modelClient ??
      new PiAgentClient({
        readArtifact: (ref, consumer) => this.artifacts.read(ref, consumer),
        ...(options.workerExtensions ? { workerExtensions: options.workerExtensions } : {}),
      });
    this.workers = new WorkerExecutor(client, this.artifacts, {
      projectRoot: this.config.projectRoot,
      parallelConcurrency: this.config.parallelConcurrency,
      workerTimeoutMs: this.config.workerTimeoutMs,
    });
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
