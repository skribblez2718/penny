import { ArtifactStore } from "./artifact-store.js";
import { ProjectRetentionOwner } from "./catalog-session-retention.js";
import { Checkpointer } from "./checkpointer.js";
import { loadRuntimeConfig, type RuntimeConfig } from "./config.js";
import type { Directive } from "./contracts.js";
import { OrchestrationEngine } from "./engine.js";
import { KbWorkerClient } from "./kb/kb-worker-client.js";
import { PiAgentClient, type ModelClient, type InlineExtension } from "./model-client.js";
import { ReceiptAuthority } from "./receipts.js";
import {
  ResearchContextOwnerV1,
  type ResearchContextProviderHandlersV1,
} from "./research-context.js";
import { ObservabilityClient } from "./observability.js";
import { OrchestrationRunner, WorkerExecutor, type OrchestrationProgressSink } from "./worker.js";
import {
  resolvePlaybook,
  validateRegistrationContract,
  type PlaybookRegistrationV1,
} from "./playbooks/registry.js";

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
  /** Exact candidate registration resolved through the static allowed-candidate path. */
  readonly playbookRegistration?: PlaybookRegistrationV1;
  /** Identifier-only document/approved-KB context resolvers owned by the host. */
  readonly researchContextProviders?: ResearchContextProviderHandlersV1;
}

export class OrchestrationService implements Disposable {
  readonly config: RuntimeConfig;
  readonly checkpointer: Checkpointer;
  readonly artifacts: ArtifactStore;
  readonly retention: ProjectRetentionOwner;
  readonly engine: OrchestrationEngine;
  readonly researchContext: ResearchContextOwnerV1 | undefined;
  readonly workers: WorkerExecutor;
  readonly runner: OrchestrationRunner;
  private activeExecutions = 0;
  private closed = false;

  constructor(options: OrchestrationServiceOptions) {
    const env = options.env ?? process.env;
    this.config = loadRuntimeConfig(options.projectRoot, env);
    const selectedName = options.playbookName ?? options.playbookRegistration?.name ?? "research";
    const selectedRegistration = options.playbookRegistration ?? resolvePlaybook(selectedName);
    if (selectedRegistration === undefined || selectedRegistration.name !== selectedName) {
      throw new Error(`playbook '${selectedName}' is not available for service construction`);
    }
    validateRegistrationContract(
      selectedRegistration,
      options.playbookRegistration === undefined
        ? "production"
        : selectedRegistration.contract.release_status
    );
    const observability = new ObservabilityClient({ env });
    this.checkpointer = Checkpointer.openExisting(this.config.dbPath, observability.observe, {
      maxRetainedRuns: this.config.maxRetainedRuns,
      projectId: this.config.projectId,
    });
    this.artifacts = ArtifactStore.openExisting(this.config.artifactRoot, {
      projectId: this.config.projectId,
    });
    this.retention = new ProjectRetentionOwner(this.checkpointer, {
      projectId: this.config.projectId,
      sessionRoot: this.config.subagentSessionRoot,
    });
    const client =
      options.modelClient ??
      new PiAgentClient({
        catalogSessions: {
          projectId: this.config.projectId,
          root: this.config.subagentSessionRoot,
        },
        ...(options.workerExtensions ? { workerExtensions: options.workerExtensions } : {}),
      });
    if (client instanceof KbWorkerClient) client.bindCheckpointer(this.checkpointer);
    const kbPolicy = client instanceof KbWorkerClient ? client.livenessPolicy() : undefined;
    const activeRegistration: PlaybookRegistrationV1 =
      kbPolicy === undefined
        ? selectedRegistration
        : {
            ...selectedRegistration,
            liveness: {
              ...selectedRegistration.liveness,
              resolve: () => kbPolicy,
            },
          };
    this.researchContext =
      selectedRegistration.ingress === "skill"
        ? new ResearchContextOwnerV1(this.artifacts, {
            ...options.researchContextProviders,
            callerInput:
              options.researchContextProviders?.callerInput ??
              ((_source, runId) => {
                const run = this.checkpointer.loadRunById(runId);
                if (run === undefined) {
                  throw new Error(`caller context run '${runId}' is unavailable`);
                }
                return run.research.report_format;
              }),
          })
        : undefined;
    this.engine = new OrchestrationEngine(this.checkpointer, {
      projectRoot: this.config.projectRoot,
      maxSteps: this.config.maxSteps,
      receiptAuthority: ReceiptAuthority.loadExisting(this.config.receiptKeyPath),
      artifactRevisions: this.artifacts,
      artifactStore: this.artifacts,
      artifactReader: this.artifacts,
      ...(this.researchContext === undefined ? {} : { researchContext: this.researchContext }),
      ...(options.dispatchMode ? { dispatchMode: options.dispatchMode } : {}),
      playbookName: selectedName,
      playbookRegistration: activeRegistration,
    });
    this.workers = new WorkerExecutor(client, this.artifacts, {
      projectRoot: this.config.projectRoot,
      parallelConcurrency: this.config.parallelConcurrency,
      workerTimeoutMs: this.config.workerTimeoutMs,
      registration: this.engine.registration,
      ...(this.researchContext === undefined ? {} : { researchContext: this.researchContext }),
    });
    // The workers sign receipts with the engine's authority so the engine can
    // verify them. Without this wiring, every agent-driven run fails open at the
    // receipt gate.
    this.workers.setReceiptAuthority(this.engine.receiptAuthority);
    this.workers.setLivenessController(this.engine.liveness);
    this.runner = new OrchestrationRunner(this.engine, this.workers);
  }

  handle(request: unknown): Directive {
    return this.engine.handle(request);
  }

  async execute(
    request: unknown,
    signal?: AbortSignal,
    onProgress?: OrchestrationProgressSink
  ): Promise<Directive> {
    this.activeExecutions += 1;
    try {
      return await this.runner.runUntilBoundary(this.engine.handle(request), signal, onProgress);
    } finally {
      this.activeExecutions -= 1;
    }
  }

  close(): void {
    if (this.closed) return;
    if (this.activeExecutions !== 0) {
      throw new Error("orchestration service cannot finalize retention while workers are active");
    }
    this.closed = true;
    const failures: unknown[] = [];
    try {
      this.retention.run();
    } catch (error) {
      failures.push(error);
    }
    try {
      this.artifacts.close();
    } catch (error) {
      failures.push(error);
    }
    try {
      this.checkpointer.close();
    } catch (error) {
      failures.push(error);
    }
    const first = failures[0];
    if (failures.length === 1 && first !== undefined) throw first;
    if (failures.length > 1) {
      throw new AggregateError(failures, "orchestration service finalization failed");
    }
  }

  [Symbol.dispose](): void {
    this.close();
  }
}
