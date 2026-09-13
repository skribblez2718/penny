import { ArtifactStore } from "./artifact-store.js";
import { ProjectRetentionOwner } from "./catalog-session-retention.js";
import { Checkpointer } from "./checkpointer.js";
import { loadRuntimeConfig, type RuntimeConfig } from "./config.js";
import type { Directive } from "./contracts.js";
import { OrchestrationEngine } from "./engine.js";
import { ChildWorkflowRuntimeOwner } from "./child-workflows/owner.js";
import { KbWorkerClient } from "./kb/kb-worker-client.js";
import { PiAgentClient, type ModelClient, type InlineExtension } from "./model-client.js";
import { ReceiptAuthority } from "./receipts.js";
import type { EffectEvidenceProviderV1 } from "./skill-contracts/effects.js";
import {
  ResearchContextOwnerV2,
  type ResearchContextProviderHandlers,
} from "./research-context.js";
import { ObservabilityClient } from "./observability.js";
import { OrchestrationRunner, WorkerExecutor, type OrchestrationProgressSink } from "./worker.js";
import {
  PLAYBOOK_REGISTRY,
  resolvePlaybook,
  validateRegistrationContract,
  type PlaybookRegistrationV1,
  type PlaybookRegistryV1,
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
  /** Which registered playbook this service drives. Defaults to research. */
  readonly playbookName?: string;
  /** Optional exact registration injection for tests and dedicated host entrypoints. */
  readonly playbookRegistration?: PlaybookRegistrationV1;
  /** Identifier-only document/approved-KB context resolvers owned by the host. */
  readonly researchContextProviders?: ResearchContextProviderHandlers;
  /** Optional trusted immutable effect-trace snapshot provider. Absence means unknown. */
  readonly effectEvidenceProvider?: EffectEvidenceProviderV1;
  /** Enable/disable internal depth-one child execution. Ordinary skill services default on. */
  readonly enableChildWorkflows?: boolean;
  /** @deprecated Compatibility alias; true still enables the same production owner. */
  readonly enableCandidateChildWorkflows?: true;
  /** Exact registry used by the depth-one child owner; tests may supply isolated fixtures. */
  readonly childWorkflowRegistry?: PlaybookRegistryV1;
}

export class OrchestrationService implements Disposable {
  readonly config: RuntimeConfig;
  readonly checkpointer: Checkpointer;
  readonly artifacts: ArtifactStore;
  readonly retention: ProjectRetentionOwner;
  readonly engine: OrchestrationEngine;
  readonly researchContext: ResearchContextOwnerV2 | undefined;
  readonly workers: WorkerExecutor;
  readonly childWorkflows: ChildWorkflowRuntimeOwner | undefined;
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
    validateRegistrationContract(selectedRegistration);
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
    const configuredContextProviders = options.researchContextProviders;
    let currentContextProviders: ResearchContextProviderHandlers;
    if (
      configuredContextProviders !== undefined &&
      configuredContextProviders.resolver_contract_version !== 2
    ) {
      currentContextProviders = configuredContextProviders;
    } else {
      const callerInput =
        configuredContextProviders?.callerInput ??
        (async (_source, runId, control) => {
          if (control.signal.aborted) {
            throw new Error("caller context recovery was cancelled");
          }
          const run = this.checkpointer.loadRunById(runId);
          if (run === undefined) {
            throw new Error(`caller context run '${runId}' is unavailable`);
          }
          return run.research.report_format;
        });
      currentContextProviders =
        configuredContextProviders === undefined
          ? {
              resolver_contract_version: 2,
              provider_execution: "trusted_in_process",
              admission_resolutions: [],
              callerInput,
            }
          : { ...configuredContextProviders, callerInput };
    }
    this.researchContext =
      selectedRegistration.ingress === "skill"
        ? new ResearchContextOwnerV2(this.artifacts, currentContextProviders)
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
      ...(options.effectEvidenceProvider === undefined
        ? {}
        : { effectEvidenceProvider: options.effectEvidenceProvider }),
      playbookName: selectedName,
      playbookRegistration: activeRegistration,
    });
    this.workers = new WorkerExecutor(client, this.artifacts, {
      projectRoot: this.config.projectRoot,
      parallelConcurrency: this.config.parallelConcurrency,
      hostOperationDeadlineMs: this.config.hostOperationDeadlineMs,
      registration: this.engine.registration,
      ...(this.researchContext === undefined ? {} : { researchContext: this.researchContext }),
    });
    // The workers sign receipts with the engine's authority so the engine can
    // verify them. Without this wiring, every agent-driven run fails open at the
    // receipt gate.
    this.workers.setReceiptAuthority(this.engine.receiptAuthority);
    this.workers.setLivenessController(this.engine.liveness);
    const childWorkflowsEnabled =
      options.enableChildWorkflows ??
      (options.enableCandidateChildWorkflows === true || selectedRegistration.ingress === "skill");
    this.childWorkflows =
      childWorkflowsEnabled && selectedRegistration.ingress === "skill"
        ? new ChildWorkflowRuntimeOwner({
            checkpointer: this.checkpointer,
            artifacts: this.artifacts,
            registry: options.childWorkflowRegistry ?? PLAYBOOK_REGISTRY,
            projectRoot: this.config.projectRoot,
            executionEnabled: true,
            engines: {
              create: ({ registration, maxSteps }) => {
                const childMaxSteps = maxSteps ?? this.config.maxSteps;
                const childEngine = new OrchestrationEngine(this.checkpointer, {
                  projectRoot: this.config.projectRoot,
                  maxSteps: childMaxSteps,
                  receiptAuthority: this.engine.receiptAuthority,
                  artifactRevisions: this.artifacts,
                  artifactStore: this.artifacts,
                  artifactReader: this.artifacts,
                  ...(this.researchContext === undefined
                    ? {}
                    : { researchContext: this.researchContext }),
                  ...(options.dispatchMode ? { dispatchMode: options.dispatchMode } : {}),
                  ...(options.effectEvidenceProvider === undefined
                    ? {}
                    : { effectEvidenceProvider: options.effectEvidenceProvider }),
                  playbookRegistration: registration,
                  playbookRegistry: options.childWorkflowRegistry ?? PLAYBOOK_REGISTRY,
                });
                const childWorkers = new WorkerExecutor(client, this.artifacts, {
                  projectRoot: this.config.projectRoot,
                  parallelConcurrency: this.config.parallelConcurrency,
                  hostOperationDeadlineMs: this.config.hostOperationDeadlineMs,
                  registration: childEngine.registration,
                  ...(this.researchContext === undefined
                    ? {}
                    : { researchContext: this.researchContext }),
                });
                childWorkers.setReceiptAuthority(childEngine.receiptAuthority);
                childWorkers.setLivenessController(childEngine.liveness);
                return {
                  engine: childEngine,
                  runner: new OrchestrationRunner(childEngine, childWorkers),
                  maxSteps: childMaxSteps,
                };
              },
            },
          })
        : undefined;
    this.runner = new OrchestrationRunner(this.engine, this.workers, this.childWorkflows);
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
