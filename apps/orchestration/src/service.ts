import { assertCurrentShippingBuild } from "./build-provenance.js";
import { ImageAssetAuthority } from "./imagegen/asset-authority.js";
import {
  createScaAdvancedHostAdapters,
  type ScaAdvancedHostOptions,
} from "./sca/ordinary-advanced-host.js";
import { createScaOfflineRunner } from "./sca/ordinary-offline-runner.js";
import {
  createScaModelSessionRuntime,
  loadScaModelHost,
  type ScaModelHostOptions,
} from "./sca/ordinary-model-runtime.js";
import { ScaRequestV1Schema } from "./skill-contracts/sca-request.js";
import { captureScaStaticSourceFile } from "./sca/ordinary-source.js";
import path from "node:path";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { ArtifactStore } from "./artifact-store.js";
import { ProjectRetentionOwner } from "./catalog-session-retention.js";
import { Checkpointer } from "./checkpointer.js";
import { loadRuntimeConfig, type RuntimeConfig } from "./config.js";
import { validateContract, type ArtifactRef, type Directive } from "./contracts.js";
import { OrchestrationEngine } from "./engine.js";
import { createVideogenRegistration } from "./playbooks/videogen.js";
import { loadVideogenRuntimeFromEnvironment } from "./videogen/runtime-manifest.js";
import { videogenImagegenAdapters } from "./videogen/runtime-imagegen.js";
import type { VideogenRuntimeProvidersV1 } from "./videogen/runtime-config.js";
import { VideogenOwnerSelection } from "./videogen/owner-selection.js";
import { VideogenRuntime } from "./videogen/runtime.js";
import { videogenUseValidator } from "./videogen/use-validator.js";
import { VOICE_API_ADAPTER_ID } from "./videogen/voice-api-contracts.js";
import { ChildWorkflowRuntimeOwner } from "./child-workflows/owner.js";
import { ImagegenChildRuntimeAuthority } from "./child-workflows/imagegen.js";
import type { HostOperationAdapterV1 } from "./host-operations/contracts.js";
import type { HostOperationResultCacheV1 } from "./host-operations/result-cache.js";
import type {
  ImagegenActivationController,
  ImagegenActivationOutcomeV1,
} from "./imagegen/activation.js";
import {
  loadImagegenRuntimeFromEnvironment,
  type LoadedImagegenRuntimeV1,
} from "./imagegen/runtime-config.js";
import type { ImagegenStartAdmissionProvidersV1 } from "./imagegen/types.js";
import {
  HostCapacityProjectAuthority,
  HostOperationCapacityAuthority,
} from "./host-operations/capacity-authority.js";
import {
  HostOperationCapacityRuntimeBinding,
  type HostOperationCapacityRuntimeOptions,
} from "./host-operations/capacity-runtime.js";
import { HostOperationLeaseAuthority } from "./host-operations/lease-authority.js";
import {
  HostOperationRuntimeOwner,
  type HostOperationFaultPointV1,
  type HostOperationUseValidatorV1,
} from "./host-operations/owner.js";
import { KbWorkerClient } from "./kb/kb-worker-client.js";
import {
  PiAgentClient,
  type ModelClient,
  type InlineExtension,
  type WorkerExtensionSourceReplacement,
} from "./model-client.js";
import { ReceiptAuthority } from "./receipts.js";
import type { EffectEvidenceProviderV1 } from "./skill-contracts/effects.js";
import type { ScaP02ComponentValidationAuthorityV1 } from "./sca/p02-contracts.js";
import {
  createScaOrdinaryHostAdapters,
  createScaOrdinaryResultCache,
} from "./sca/ordinary-host.js";
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
  type PlaybookRegistration,
  type PlaybookRegistry,
  type OrdinaryHostFaultV1,
} from "./playbooks/registry.js";

export interface OrchestrationServiceOptions {
  /** Trusted private construction only. Never a skill/model-selected runtime or qualification. */
  readonly videogen?: VideogenRuntimeProvidersV1;
  readonly projectRoot: string;
  readonly env?: NodeJS.ProcessEnv;
  /**
   * The `ModelClient` the worker executor drives. Research passes the default
   * (or omits it); KB passes a `KbWorkerClient` with the §5.8 private-reader
   * posture. Since each service instance owns exactly one engine/playbook, the
   * right client is a caller decision, not a runtime dispatch.
   */
  readonly modelClient?: ModelClient;
  /** Caller-approved override for every worker in this invocation, including child workflows. */
  readonly modelOverride?: string;
  readonly dispatchMode?: () => string | undefined;
  /** Owner-supplied worker extension factories (e.g. worker-read memory). Not a tool list. */
  readonly workerExtensions?: readonly InlineExtension[];
  /** Exact ambient entry files replaced before loading by their host-owned scoped providers. */
  readonly workerExtensionReplacements?: readonly WorkerExtensionSourceReplacement[];
  /** Which registered playbook this service drives. Defaults to research. */
  readonly playbookName?: string;
  /** Optional exact registration injection for tests and dedicated host entrypoints. */
  readonly playbookRegistration?: PlaybookRegistration;
  /** Identifier-only document/approved-KB context resolvers owned by the host. */
  readonly researchContextProviders?: ResearchContextProviderHandlers;
  /** Optional trusted immutable effect-trace snapshot provider. Absence means unknown. */
  readonly effectEvidenceProvider?: EffectEvidenceProviderV1;
  /** Enable/disable internal depth-one child execution. Ordinary skill services default on. */
  readonly enableChildWorkflows?: boolean;
  /** @deprecated Compatibility alias; true still enables the same production owner. */
  readonly enableCandidateChildWorkflows?: true;
  /** Exact registry used by the depth-one child owner; tests may supply isolated fixtures. */
  readonly childWorkflowRegistry?: PlaybookRegistry;
  /** Trusted host adapters. Registration remains the authority; an absent adapter fails closed. */
  readonly hostOperationAdapters?: ReadonlyMap<string, HostOperationAdapterV1>;
  /** Host-owned durable exact-result cache required by no-repeat operation adapters. */
  readonly hostOperationResultCache?: HostOperationResultCacheV1;
  /** Host-selected use-time authority applied before every host-operation recovery/cache path. */
  readonly hostOperationUseValidator?: HostOperationUseValidatorV1;
  /** Host-only opt-in for every driven operation. Reads installed policy; never configures state. */
  readonly hostOperationCapacity?: HostOperationCapacityRuntimeOptions;
  /** Host-only ordinary disclosure/cost consent. Never accepted from a model/skill request. */
  readonly scaModel?: ScaModelHostOptions;
  /** Host-owned ordinary application and empirical configuration. */
  readonly scaAdvanced?: ScaAdvancedHostOptions;
  readonly scaP02ComponentValidationAuthority?: ScaP02ComponentValidationAuthorityV1;
  /**
   * Narrow host-only interruption seam threaded to the host-operation owner. Only a trusted
   * in-process qualification runner sets it; it is absent from every request, directive,
   * registration, model, and skill surface, so no caller or model can select an interruption.
   */
  readonly hostOperationFault?: (point: HostOperationFaultPointV1, operation_kind: string) => void;
  /** Host-only ordinary-skill fault injection, absent from public requests and environment. */
  readonly hostFault?: OrdinaryHostFaultV1;
  /** Legacy Research-only injection, mutually exclusive with hostFault. */
  readonly researchHostFault?: (point: string) => void;
  /** Private image profile/export/storage registries. No concrete profile is compiled into Penny. */
  readonly imagegen?: ImagegenStartAdmissionProvidersV1;
}

export class OrchestrationService implements Disposable {
  readonly #hostAdapterClosers: (() => void)[] = [];
  readonly config: RuntimeConfig;
  readonly checkpointer: Checkpointer;
  readonly artifacts: ArtifactStore;
  readonly retention: ProjectRetentionOwner;
  readonly engine: OrchestrationEngine;
  readonly researchContext: ResearchContextOwnerV2 | undefined;
  readonly workers: WorkerExecutor;
  readonly childWorkflows: ChildWorkflowRuntimeOwner | undefined;
  readonly hostOperations: HostOperationRuntimeOwner | undefined;
  private readonly hostOperationCapacity: HostOperationCapacityAuthority | undefined;
  private readonly hostOperationLeases: HostOperationLeaseAuthority | undefined;
  private readonly loadedImagegenRuntime: LoadedImagegenRuntimeV1 | undefined;
  private readonly imagegenActivation: ImagegenActivationController | undefined;
  readonly runner: OrchestrationRunner;
  private activeExecutions = 0;
  private closed = false;
  private readonly videogenProviders: VideogenRuntimeProvidersV1 | undefined;

  constructor(options: OrchestrationServiceOptions) {
    assertCurrentShippingBuild();
    if (options.hostFault !== undefined && options.researchHostFault !== undefined) {
      throw new Error("ambiguous host fault hooks: choose hostFault or researchHostFault");
    }
    const env = options.env ?? process.env;
    this.config = loadRuntimeConfig(options.projectRoot, env);
    const selectedName = options.playbookName ?? options.playbookRegistration?.name ?? "research";
    this.loadedImagegenRuntime =
      (selectedName === "imagegen" ||
        (selectedName === "videogen" &&
          env["PENNY_VIDEOGEN_RUNTIME_MANIFEST_FILE"] !== undefined)) &&
      options.imagegen === undefined &&
      options.hostOperationAdapters === undefined
        ? loadImagegenRuntimeFromEnvironment({
            env,
            state_root: this.config.stateRoot,
          })
        : undefined;
    const imagegen = options.imagegen ?? this.loadedImagegenRuntime?.providers;
    this.imagegenActivation = selectedName === "imagegen" ? imagegen?.activation : undefined;
    const observability = new ObservabilityClient({ env });
    this.checkpointer = Checkpointer.openExisting(this.config.dbPath, observability.observe, {
      maxRetainedRuns: this.config.maxRetainedRuns,
      projectId: this.config.projectId,
    });
    this.artifacts = ArtifactStore.openExisting(this.config.artifactRoot, {
      projectId: this.config.projectId,
    });
    let videogen: VideogenRuntimeProvidersV1 | undefined;
    let selectedRegistration: PlaybookRegistration | undefined;
    try {
      videogen =
        options.videogen ??
        (selectedName === "videogen"
          ? loadVideogenRuntimeFromEnvironment({
              env,
              store: this.artifacts,
              project_id: this.config.projectId,
              project_root: this.config.projectRoot,
            })
          : undefined);
      if (selectedName === "videogen" && videogen !== undefined && videogen.effects.size > 0)
        videogen = {
          ...videogen,
          host_owners: {
            leases: new HostOperationLeaseAuthority(this.config.stateRoot),
            state_root: this.config.stateRoot,
          },
        };
      selectedRegistration =
        options.playbookRegistration ??
        (selectedName === "videogen" && videogen !== undefined
          ? createVideogenRegistration(videogen)
          : resolvePlaybook(selectedName));
      if (selectedRegistration === undefined || selectedRegistration.name !== selectedName) {
        throw new Error(`playbook '${selectedName}' is not available for service construction`);
      }
      validateRegistrationContract(selectedRegistration);
    } catch (error) {
      if (selectedName === "videogen" && videogen !== undefined && videogen.effects.size > 0)
        videogen.host_owners?.leases.close();
      this.artifacts.close();
      this.checkpointer.close();
      this.loadedImagegenRuntime?.close();
      throw error;
    }
    this.videogenProviders = videogen;
    const childTargets = new Set([
      ...(
        selectedRegistration.generic_child?.parent_policy.targets ??
        selectedRegistration.information_child?.parent_policy.targets ??
        []
      ).map((t) => t.child_name),
      ...(selectedRegistration.imagegen_child === undefined ? [] : ["imagegen"]),
    ]);
    const childRegistry = new Map(
      [...(options.childWorkflowRegistry ?? PLAYBOOK_REGISTRY)].filter(
        ([name]) => name === selectedName || childTargets.has(name)
      )
    );
    childRegistry.set(selectedName, selectedRegistration);
    const assetAuthorities = new Map<string, ImageAssetAuthority>();
    const imageAssets = (parentRunId: string): ImageAssetAuthority => {
      let authority = assetAuthorities.get(parentRunId);
      if (authority === undefined) {
        authority = this.imageAssetAuthorityForRun(parentRunId);
        assetAuthorities.set(parentRunId, authority);
      }
      return authority;
    };
    const imageProvidersForParent = (parentRunId: string) =>
      imagegen === undefined ? undefined : { ...imagegen, assets: imageAssets(parentRunId) };
    this.retention = new ProjectRetentionOwner(this.checkpointer, {
      projectId: this.config.projectId,
      sessionRoot: this.config.subagentSessionRoot,
    });
    const scaModelHost =
      selectedName === "sca" ? (options.scaModel ?? loadScaModelHost(env)) : undefined;
    const scaSessionRuntime =
      selectedName === "sca"
        ? createScaModelSessionRuntime({
            projectRoot: this.config.projectRoot,
            ...(scaModelHost === undefined
              ? {}
              : {
                  host: scaModelHost,
                }),
            readArtifact: (ref) => this.artifacts.readById(ref.artifact_id),
            requestForRun: (runId) => {
              const ref = this.checkpointer
                .loadRunById(runId)
                ?.selectedArtifacts.find((x) => x.kind === "sca-request");
              if (ref === undefined) return undefined;
              const value: unknown = JSON.parse(
                this.artifacts.readById(ref.artifact_id).toString("utf8")
              );
              return validateContract(ScaRequestV1Schema, value, "Exact caller disclosure scope");
            },
          })
        : undefined;
    const client =
      options.modelClient ??
      new PiAgentClient({
        ...(options.workerExtensionReplacements === undefined
          ? {}
          : { workerExtensionReplacements: options.workerExtensionReplacements }),
        ...(scaSessionRuntime === undefined ? {} : { sessionRuntime: scaSessionRuntime }),
        catalogSessions: {
          projectId: this.config.projectId,
          root: this.config.subagentSessionRoot,
        },
        ...(selectedName === "sca"
          ? {
              workerExtensions: [
                ...(options.workerExtensions ?? []),
                {
                  name: "artifact-worker-read",
                  hidden: true,
                  factory: async (pi) => {
                    // Fixed installed helper, independent of ambient discovery or target checkout paths.
                    assertCurrentShippingBuild();
                    const module: unknown = await import(
                      new URL("../dist/artifact-worker.js", import.meta.url).href
                    );
                    if (!isArtifactWorkerModule(module))
                      throw new Error("Installed artifact reader unavailable");
                    await module.createArtifactReadExtension({
                      projectRoot: this.config.projectRoot,
                      env: { ...env },
                    })(pi);
                  },
                },
              ],
            }
          : options.workerExtensions
            ? { workerExtensions: options.workerExtensions }
            : {}),
      });
    if (client instanceof KbWorkerClient) client.bindCheckpointer(this.checkpointer);
    const kbPolicy = client instanceof KbWorkerClient ? client.livenessPolicy() : undefined;
    const activeRegistration: PlaybookRegistration =
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
      maxIterations: this.config.maxIterations,
      receiptAuthority: ReceiptAuthority.loadExisting(this.config.receiptKeyPath),
      artifactRevisions: this.artifacts,
      artifactStore: this.artifacts,
      artifactReader: this.artifacts,
      assuranceProjectId: this.config.projectId,
      ...(this.researchContext === undefined ? {} : { researchContext: this.researchContext }),
      ...(imagegen === undefined ? {} : { imagegen }),
      ...(options.dispatchMode ? { dispatchMode: options.dispatchMode } : {}),
      ...(options.effectEvidenceProvider === undefined
        ? {}
        : { effectEvidenceProvider: options.effectEvidenceProvider }),
      ...(options.scaP02ComponentValidationAuthority === undefined
        ? {}
        : {
            scaP02ComponentValidationAuthority: options.scaP02ComponentValidationAuthority,
          }),
      playbookName: selectedName,
      playbookRegistration: activeRegistration,
      ...(options.hostFault === undefined ? {} : { hostFault: options.hostFault }),
      ...(options.researchHostFault === undefined
        ? {}
        : { researchHostFault: options.researchHostFault }),
    });
    this.workers = new WorkerExecutor(client, this.artifacts, {
      projectRoot: this.config.projectRoot,
      parallelConcurrency: this.config.parallelConcurrency,
      registration: this.engine.registration,
      ...(options.modelOverride === undefined ? {} : { modelOverride: options.modelOverride }),
      ...(this.researchContext === undefined ? {} : { researchContext: this.researchContext }),
    });
    // The workers sign receipts with the engine's authority so the engine can
    // verify them. Without this wiring, every agent-driven run fails open at the
    // receipt gate.
    this.workers.setReceiptAuthority(this.engine.receiptAuthority);
    this.workers.setLivenessController(this.engine.liveness);
    const capacityOptions = options.hostOperationCapacity ?? videogen?.capacity_options;
    let capacityRuntime: HostOperationCapacityRuntimeBinding | undefined;
    if (capacityOptions !== undefined) {
      try {
        const project = new HostCapacityProjectAuthority(
          this.config.projectId,
          this.checkpointer,
          this.artifacts,
          capacityOptions.measurements,
          capacityOptions.productive
        );
        this.hostOperationCapacity = new HostOperationCapacityAuthority({
          stateRoot: this.config.stateRoot,
          policy: capacityOptions.policy,
          projects: [project],
          ...(capacityOptions.now === undefined ? {} : { now: capacityOptions.now }),
        });
        capacityRuntime = new HostOperationCapacityRuntimeBinding(
          this.hostOperationCapacity,
          project,
          capacityOptions.demands
        );
      } catch (error) {
        this.artifacts.close();
        this.checkpointer.close();
        throw error;
      }
    } else this.hostOperationCapacity = undefined;
    const hostOperationAdapters =
      selectedName === "sca"
        ? new Map([
            ...createScaOrdinaryHostAdapters(),
            ...createScaAdvancedHostAdapters(
              options.scaAdvanced ?? loadScaAdvancedHost(env),
              this.artifacts,
              this.config.projectId
            ),
            ...(options.hostOperationAdapters ?? []),
          ])
        : (options.hostOperationAdapters ??
          (selectedName === "videogen" && videogen !== undefined
            ? new Map<string, HostOperationAdapterV1>(
                [...videogen.effects.values()].map((provider) => [
                  provider.declaration.adapter_id,
                  (() => {
                    const byRun = new Map<string, HostOperationAdapterV1>();
                    const adapter = (runId: string) => {
                      let found = byRun.get(runId);
                      if (found === undefined) {
                        const owner = new VideogenOwnerSelection({
                          store: this.artifacts,
                          checkpointer: this.checkpointer,
                          project_id: this.config.projectId,
                          run_id: runId,
                        });
                        found = provider.createAdapter({
                          owner,
                          ...(videogen.host_owners ? { leases: videogen.host_owners.leases } : {}),
                          store: this.artifacts,
                          checkpointer: this.checkpointer,
                          ...(capacityRuntime === undefined ||
                          this.hostOperationCapacity === undefined
                            ? {}
                            : {
                                capacity: {
                                  runtime: capacityRuntime,
                                  authority: this.hostOperationCapacity,
                                },
                              }),
                        });
                        byRun.set(runId, found);
                        const created = found;
                        this.#hostAdapterClosers.push(() => created.close?.());
                      }
                      return found;
                    };
                    return {
                      adapter_id: provider.declaration.adapter_id,
                      inspectRequest: (input) =>
                        adapter(input.directive.identity.run_id).inspectRequest(input),
                      prepare: async (context) => {
                        await adapter(context.directive.identity.run_id).prepare?.(context);
                      },
                      run: (context) => adapter(context.directive.identity.run_id).run(context),
                    } satisfies HostOperationAdapterV1;
                  })(),
                ])
              )
            : undefined) ??
          this.loadedImagegenRuntime?.adapters ??
          (capacityOptions === undefined ? undefined : new Map<string, HostOperationAdapterV1>()));
    if (
      selectedName === "videogen" &&
      videogen?.imagegen_child !== undefined &&
      imagegen !== undefined &&
      hostOperationAdapters instanceof Map
    ) {
      for (const [id, adapter] of videogenImagegenAdapters(imagegen, (childRunId) => {
        const call = this.checkpointer.childWorkflowCallForChild(childRunId);
        if (call === undefined) throw new Error("image operation has no reserved child linkage");
        return imageAssets(call.parent_identity.run_id);
      }))
        if (!hostOperationAdapters.has(id)) hostOperationAdapters.set(id, adapter);
    }
    this.hostOperationLeases =
      hostOperationAdapters === undefined
        ? undefined
        : (videogen?.host_owners?.leases ?? new HostOperationLeaseAuthority(this.config.stateRoot));
    this.hostOperations =
      this.hostOperationLeases === undefined || hostOperationAdapters === undefined
        ? undefined
        : new HostOperationRuntimeOwner({
            projectId: this.config.projectId,
            checkpointer: this.checkpointer,
            artifacts: this.artifacts,
            leaseAuthority: this.hostOperationLeases,
            adapters: hostOperationAdapters,
            ...(selectedName === "videogen"
              ? {
                  resultCacheBypassOperationKinds: [
                    "media_decode_extract",
                    "timeline_master",
                    "kdenlive_build_verify",
                    "local_delivery",
                    // The selected API adapter requires durable reads AND writes; native Voice
                    // keeps its existing bypass. Requests cannot select this cache policy.
                    ...(selectedRegistration.host_operations?.declarations.some(
                      (d) =>
                        d.operation_kind === "voice_job" && d.adapter_id === VOICE_API_ADAPTER_ID
                    )
                      ? []
                      : ["voice_job"]),
                  ],
                }
              : {}),
            ...(capacityRuntime === undefined ? {} : { capacityRuntime }),
            ...(capacityOptions?.now === undefined ? {} : { now: capacityOptions.now }),
            ...(options.hostOperationResultCache !== undefined
              ? { resultCache: options.hostOperationResultCache }
              : videogen?.result_cache !== undefined
                ? { resultCache: videogen.result_cache }
                : selectedName === "sca"
                  ? { resultCache: createScaOrdinaryResultCache(this.config.dbPath) }
                  : {}),
            ...(selectedName === "videogen" && videogen !== undefined
              ? {
                  useValidator: (() => {
                    const fixed = videogenUseValidator(
                      new VideogenRuntime(
                        this.artifacts,
                        this.checkpointer,
                        this.config.projectId,
                        videogen
                      )
                    );
                    const extra = options.hostOperationUseValidator;
                    return {
                      preflightRefs: (input) => {
                        if (input.directive.identity.playbook === "videogen")
                          fixed.preflightRefs?.(input);
                        extra?.preflightRefs?.(input);
                      },
                      validateUse: async (input) => {
                        if (input.directive.identity.playbook === "videogen")
                          await fixed.validateUse(input);
                        await extra?.validateUse(input);
                      },
                    } satisfies HostOperationUseValidatorV1;
                  })(),
                }
              : options.hostOperationUseValidator === undefined
                ? {}
                : { useValidator: options.hostOperationUseValidator }),
            ...(options.hostOperationFault === undefined
              ? {}
              : { fault: options.hostOperationFault }),
          });
    const childWorkflowsEnabled =
      options.enableChildWorkflows ??
      (options.enableCandidateChildWorkflows === true || selectedRegistration.ingress === "skill");
    this.childWorkflows =
      childWorkflowsEnabled && selectedRegistration.ingress === "skill"
        ? new ChildWorkflowRuntimeOwner({
            checkpointer: this.checkpointer,
            artifacts: this.artifacts,
            registry: childRegistry,
            projectRoot: this.config.projectRoot,
            executionEnabled: true,
            ...(selectedRegistration.imagegen_child === undefined || imagegen === undefined
              ? {}
              : {
                  imagegenChildrenForRun: (runId: string) =>
                    new ImagegenChildRuntimeAuthority({
                      artifacts: this.artifacts,
                      checkpointer: this.checkpointer,
                      providers: { ...imagegen, assets: imageAssets(runId) },
                    }),
                }),
            engines: {
              create: ({ registration, maxSteps, parentRunId }) => {
                const childImagegen =
                  registration.name === "imagegen" && parentRunId !== undefined
                    ? imageProvidersForParent(parentRunId)
                    : imagegen;
                const childMaxSteps = maxSteps ?? this.config.maxSteps;
                const childEngine = new OrchestrationEngine(this.checkpointer, {
                  projectRoot: this.config.projectRoot,
                  maxSteps: childMaxSteps,
                  maxIterations: this.config.maxIterations ?? null,
                  receiptAuthority: this.engine.receiptAuthority,
                  artifactRevisions: this.artifacts,
                  artifactStore: this.artifacts,
                  artifactReader: this.artifacts,
                  assuranceProjectId: this.config.projectId,
                  ...(this.researchContext === undefined
                    ? {}
                    : { researchContext: this.researchContext }),
                  ...(childImagegen === undefined ? {} : { imagegen: childImagegen }),
                  ...(options.dispatchMode ? { dispatchMode: options.dispatchMode } : {}),
                  ...(options.effectEvidenceProvider === undefined
                    ? {}
                    : { effectEvidenceProvider: options.effectEvidenceProvider }),
                  ...(options.scaP02ComponentValidationAuthority === undefined
                    ? {}
                    : {
                        scaP02ComponentValidationAuthority:
                          options.scaP02ComponentValidationAuthority,
                      }),
                  playbookRegistration: registration,
                  playbookRegistry: childRegistry,
                });
                const childWorkers = new WorkerExecutor(client, this.artifacts, {
                  projectRoot: this.config.projectRoot,
                  parallelConcurrency: this.config.parallelConcurrency,
                  registration: childEngine.registration,
                  ...(options.modelOverride === undefined
                    ? {}
                    : { modelOverride: options.modelOverride }),
                  ...(this.researchContext === undefined
                    ? {}
                    : { researchContext: this.researchContext }),
                });
                childWorkers.setReceiptAuthority(childEngine.receiptAuthority);
                childWorkers.setLivenessController(childEngine.liveness);
                return {
                  engine: childEngine,
                  runner: new OrchestrationRunner(
                    childEngine,
                    childWorkers,
                    undefined,
                    this.hostOperations
                  ),
                  maxSteps: childMaxSteps,
                };
              },
            },
          })
        : undefined;
    this.runner = new OrchestrationRunner(
      this.engine,
      this.workers,
      this.childWorkflows,
      this.hostOperations
    );
  }

  /** Host-only binding to this service's exact stores. It reads no caller approval/rights index,
   * and neither enables imagegen nor registers/activates a videogen workflow. */
  imageAssetAuthorityForRun(parentRunId: string): ImageAssetAuthority {
    return new ImageAssetAuthority(
      new VideogenOwnerSelection({
        store: this.artifacts,
        checkpointer: this.checkpointer,
        project_id: this.config.projectId,
        run_id: parentRunId,
      })
    );
  }

  /** Trusted host capture only; not reachable through the skill/model request surface. The
   * operator must independently watch/hear and persist the exact record before calling. */
  captureVideogenPlaybackForRun(runId: string, ref: ArtifactRef): void {
    if (this.engine.registration.name !== "videogen") throw new Error("not a videogen service");
    const context = this.checkpointer.loadRunById(runId);
    if (context === undefined) throw new Error("videogen run missing");
    // Reuse the construction-bound domain executor; this performs no media/player process.
    const providers = this.videogenProviders;
    if (providers === undefined) throw new Error("videogen private runtime missing");
    new VideogenRuntime(
      this.artifacts,
      this.checkpointer,
      this.config.projectId,
      providers
    ).capturePlayback(context, ref);
    this.checkpointer.saveRun(context, "videogen_human_playback_captured", {
      artifact_id: ref.artifact_id,
    });
  }

  handle(request: unknown): Directive {
    assertCurrentShippingBuild();
    return this.engine.handle(request);
  }

  async execute(
    request: unknown,
    signal?: AbortSignal,
    onProgress?: OrchestrationProgressSink
  ): Promise<Directive> {
    assertCurrentShippingBuild();
    this.activeExecutions += 1;
    try {
      const directive = await this.runner.runUntilBoundary(
        this.engine.handle(request),
        signal,
        onProgress
      );
      this.finalizeImagegenActivation(
        request,
        signal?.aborted === true
          ? "cancelled"
          : directive.action === "complete"
            ? "completed"
            : "failed"
      );
      return directive;
    } catch (error) {
      try {
        this.finalizeImagegenActivation(request, signal?.aborted === true ? "cancelled" : "failed");
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "imagegen activation cleanup failed after a run error"
        );
      }
      throw error;
    } finally {
      this.activeExecutions -= 1;
    }
  }

  /**
   * Fail-closed one-shot activation cleanup. A run that consumed no canary is untouched; a
   * conflicting durable disposition throws instead of being silently forgiven.
   */
  private finalizeImagegenActivation(request: unknown, outcome: ImagegenActivationOutcomeV1): void {
    const activation = this.imagegenActivation;
    if (activation === undefined) return;
    if (this.engine.registration.name !== "imagegen") return;
    if (request === null || typeof request !== "object" || !("identity" in request)) return;
    const identity = request.identity;
    if (identity === null || typeof identity !== "object" || !("run_id" in identity)) return;
    const runId = identity.run_id;
    if (typeof runId !== "string" || runId.length === 0) return;
    activation.finalizeRun({ run_id: runId, outcome });
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
      for (const close of this.#hostAdapterClosers) close();
      this.videogenProviders?.capacity_options?.measurements.close?.();
      this.hostOperationCapacity?.close();
    } catch (error) {
      failures.push(error);
    }
    try {
      this.hostOperationLeases?.close();
    } catch (error) {
      failures.push(error);
    }
    try {
      this.loadedImagegenRuntime?.close();
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

/** Fixed host-only configuration paths; never taken from constraints/prompts/model output. */
function loadScaAdvancedHost(env: NodeJS.ProcessEnv): ScaAdvancedHostOptions {
  const read = (file: string): unknown => {
    if (!path.isAbsolute(file)) throw new Error("Ordinary SCA host config must be absolute");
    return JSON.parse(
      captureScaStaticSourceFile({
        sourceRoot: path.dirname(file),
        relativePath: path.basename(file),
        maximumBytes: 1048576,
      }).toString("utf8")
    );
  };
  const vm = env.PENNY_SCA_ORDINARY_APPLICATION_VM_CONFIG;
  const runtime = env.PENNY_SCA_ORDINARY_APPLICATION_CONFIG;
  if (vm !== undefined && runtime !== undefined)
    throw new Error("Ambiguous application runtime and legacy VM configuration");
  const offline = env.PENNY_SCA_ORDINARY_OFFLINE_CONFIG;
  return {
    ...(vm === undefined ? {} : { applicationVm: read(vm) }),
    ...(runtime === undefined ? {} : { applicationRuntime: read(runtime) }),
    ...(offline === undefined ? {} : { learning: createScaOfflineRunner(read(offline)) }),
  };
}

function isArtifactWorkerModule(value: unknown): value is {
  createArtifactReadExtension(host: {
    projectRoot: string;
    env: NodeJS.ProcessEnv;
  }): ExtensionFactory;
} {
  return (
    value !== null &&
    typeof value === "object" &&
    "createArtifactReadExtension" in value &&
    typeof value.createArtifactReadExtension === "function"
  );
}
