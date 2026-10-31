import type { HostOperationAdapterV1 } from "../../orchestration/dist/host-operations/contracts.js";
import type { HostOperationUseValidatorV1 } from "../../orchestration/dist/host-operations/owner.js";
import { FileHostOperationResultCache } from "../../orchestration/dist/host-operations/result-cache.js";
import type { ModelClient } from "../../orchestration/dist/model-client.js";
import { runtimeRegistrationSha256 } from "../../orchestration/dist/playbooks/registry.js";
import { OrchestrationService } from "../../orchestration/dist/service.js";
import type { SqliteScaPhaseActivationRegistry } from "../../orchestration/dist/sca/phase-activation.js";
import {
  SCA_P02_CANDIDATE_PLAYBOOK_NAME,
  SCA_P02_CANDIDATE_REGISTRATION,
  SCA_P02_PHASE_PLAYBOOK_NAME,
  SCA_P02_PHASE_REGISTRATION,
} from "../../orchestration/dist/sca/p02-playbook.js";
import type {
  ScaActivationHostV1,
  ScaProposedActivationStartV1,
} from "../../orchestration/dist/sca/qualification-activation.js";
import type { ScaP02ComponentValidationAuthorityV1 } from "../../orchestration/dist/sca/p02-contracts.js";
import type { ScaOsvV2Transport } from "./adapters/osv-v2.js";
import type { P02ControlledInventoryRunnerV1 } from "./p02-host-inventory-runner.js";
import type { P02ControlledProcessRunnerV1 } from "./p02-host-process-runner.js";
import {
  createScaP02OperationAdaptersV1,
  type ScaP02IsolationRuntimeV1,
  type ScaP02OperationAdapterOptionsV1,
} from "./p02-operations.js";

export interface ScaP02ProductionAdapterBindingsV1 {
  readonly component_validation_authority: ScaP02ComponentValidationAuthorityV1;
  readonly isolation: Extract<
    ScaP02IsolationRuntimeV1,
    { readonly runtime_kind: "host_qualified" }
  >;
  readonly controlled_inventory_runner: P02ControlledInventoryRunnerV1;
  readonly controlled_process_runners: Readonly<
    Record<"semgrep_php" | "semgrep_js_ts" | "gitleaks", P02ControlledProcessRunnerV1>
  >;
  readonly osv_transports: Readonly<
    Record<
      "osv_composer" | "osv_npm",
      Readonly<{
        readonly transport_id: string;
        readonly transport: ScaOsvV2Transport;
      }>
    >
  >;
  readonly local_recovery?: ScaP02OperationAdapterOptionsV1["local_recovery"];
}

export interface ScaP02CandidateHostCompositionV1 {
  readonly adapters: ReadonlyMap<string, HostOperationAdapterV1>;
  readonly result_cache: FileHostOperationResultCache;
  readonly component_validation_authority: ScaP02ComponentValidationAuthorityV1;
}

export interface ScaP02CandidateServiceV1 extends ScaP02CandidateHostCompositionV1 {
  readonly service: OrchestrationService;
}

export interface ScaP02ActivatedProductionServiceV1 extends ScaP02CandidateHostCompositionV1 {
  readonly service: OrchestrationService;
  readonly use_validator: HostOperationUseValidatorV1;
  readonly runtime_registration_sha256: string;
}

function assertBindings(input: ScaP02ProductionAdapterBindingsV1): void {
  if (
    typeof input.component_validation_authority.validateComponents !== "function" ||
    input.isolation.runtime_kind !== "host_qualified" ||
    input.isolation.qualification_scope !== "live_qualified" ||
    input.isolation.operation_profiles === undefined ||
    input.controlled_inventory_runner === undefined ||
    input.controlled_process_runners.semgrep_php === undefined ||
    input.controlled_process_runners.semgrep_js_ts === undefined ||
    input.controlled_process_runners.gitleaks === undefined ||
    input.osv_transports.osv_composer === undefined ||
    input.osv_transports.osv_npm === undefined ||
    input.osv_transports.osv_composer === input.osv_transports.osv_npm ||
    input.osv_transports.osv_composer.transport === input.osv_transports.osv_npm.transport
  ) {
    throw new Error("p02_production_adapter_bindings_invalid");
  }
}

/**
 * Bind all six live P02 operations and the durable no-repeat result cache. The two OSV ecosystems
 * must carry distinct factory-issued object capabilities; one transport cannot be reused across
 * their exact plans. This is qualification/campaign plumbing and does not activate P02.
 */
export async function createScaP02CandidateHostCompositionV1(input: {
  readonly result_cache_root: string;
  readonly bindings: ScaP02ProductionAdapterBindingsV1;
}): Promise<ScaP02CandidateHostCompositionV1> {
  assertBindings(input.bindings);
  const resultCache = await FileHostOperationResultCache.openExisting(input.result_cache_root);
  const controlledProcessRunners = Object.freeze({
    semgrep_php: input.bindings.controlled_process_runners.semgrep_php,
    semgrep_js_ts: input.bindings.controlled_process_runners.semgrep_js_ts,
    gitleaks: input.bindings.controlled_process_runners.gitleaks,
  });
  const osvTransports = Object.freeze({
    osv_composer: Object.freeze({ ...input.bindings.osv_transports.osv_composer }),
    osv_npm: Object.freeze({ ...input.bindings.osv_transports.osv_npm }),
  });
  const options: ScaP02OperationAdapterOptionsV1 = Object.freeze({
    component_validation_authority: input.bindings.component_validation_authority,
    isolation: input.bindings.isolation,
    controlled_inventory_runner: input.bindings.controlled_inventory_runner,
    controlled_process_runners: controlledProcessRunners,
    osv_transports: osvTransports,
    ...(input.bindings.local_recovery === undefined
      ? {}
      : { local_recovery: input.bindings.local_recovery }),
  });
  return Object.freeze({
    adapters: createScaP02OperationAdaptersV1(options),
    result_cache: resultCache,
    component_validation_authority: input.bindings.component_validation_authority,
  });
}

/**
 * Construct a private zero-model P02 candidate service from existing stores and exact live host
 * capabilities. Start admission still owns accepted-P01 lineage. Formal review and phase activation
 * remain separate and this factory must not be exposed as ordinary skill ingress.
 */
function noP02ModelClient(): ModelClient {
  return Object.freeze({
    async runAgent() {
      throw new Error("p02_model_dispatch_forbidden");
    },
  });
}

export async function createScaP02CandidateServiceV1(input: {
  readonly project_root: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly host: Parameters<typeof createScaP02CandidateHostCompositionV1>[0];
}): Promise<ScaP02CandidateServiceV1> {
  const host = await createScaP02CandidateHostCompositionV1(input.host);
  const service = new OrchestrationService({
    projectRoot: input.project_root,
    ...(input.env === undefined ? {} : { env: input.env }),
    modelClient: noP02ModelClient(),
    playbookName: SCA_P02_CANDIDATE_PLAYBOOK_NAME,
    playbookRegistration: SCA_P02_CANDIDATE_REGISTRATION,
    enableChildWorkflows: false,
    hostOperationAdapters: host.adapters,
    hostOperationResultCache: host.result_cache,
    scaP02ComponentValidationAuthority: host.component_validation_authority,
  });
  return Object.freeze({ ...host, service });
}

function requireActiveP02Registration(input: {
  readonly activation_host: ScaActivationHostV1;
  readonly proposed_start: ScaProposedActivationStartV1;
  readonly phase_registry: Pick<SqliteScaPhaseActivationRegistry, "resolve">;
}): string {
  const registration = input.phase_registry.resolve({
    host: input.activation_host,
    proposed: input.proposed_start,
  });
  const expected = runtimeRegistrationSha256(SCA_P02_PHASE_REGISTRATION);
  if (
    registration.name !== SCA_P02_PHASE_PLAYBOOK_NAME ||
    runtimeRegistrationSha256(registration) !== expected
  ) {
    throw new Error("p02_active_registration_changed");
  }
  return expected;
}

/**
 * Construct the campaign-facing P02 service only after current durable activation replay. The
 * active registration is checked before and after host composition and before every host-operation
 * journal/cache path. Candidate qualification remains available only through the explicitly named
 * candidate factory above.
 */
export async function createScaP02ActivatedProductionServiceV1(input: {
  readonly project_root: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly activation_host: ScaActivationHostV1;
  readonly proposed_start: ScaProposedActivationStartV1;
  readonly phase_registry: Pick<SqliteScaPhaseActivationRegistry, "resolve">;
  readonly host: Parameters<typeof createScaP02CandidateHostCompositionV1>[0];
}): Promise<ScaP02ActivatedProductionServiceV1> {
  const activation = {
    activation_host: input.activation_host,
    proposed_start: input.proposed_start,
    phase_registry: input.phase_registry,
  };
  const registrationSha256 = requireActiveP02Registration(activation);
  const host = await createScaP02CandidateHostCompositionV1(input.host);
  if (requireActiveP02Registration(activation) !== registrationSha256) {
    throw new Error("p02_active_registration_changed");
  }
  const useValidator: HostOperationUseValidatorV1 = Object.freeze({
    validateUse(useInput: Parameters<HostOperationUseValidatorV1["validateUse"]>[0]) {
      useInput.signal.throwIfAborted();
      useInput.reportWorkMilestone();
      if (requireActiveP02Registration(activation) !== registrationSha256) {
        throw new Error("p02_active_registration_changed");
      }
      useInput.signal.throwIfAborted();
      useInput.reportWorkMilestone();
    },
  });
  const service = new OrchestrationService({
    projectRoot: input.project_root,
    ...(input.env === undefined ? {} : { env: input.env }),
    modelClient: noP02ModelClient(),
    playbookName: SCA_P02_PHASE_PLAYBOOK_NAME,
    playbookRegistration: SCA_P02_PHASE_REGISTRATION,
    enableChildWorkflows: false,
    hostOperationAdapters: host.adapters,
    hostOperationResultCache: host.result_cache,
    hostOperationUseValidator: useValidator,
    scaP02ComponentValidationAuthority: host.component_validation_authority,
  });
  return Object.freeze({
    ...host,
    service,
    use_validator: useValidator,
    runtime_registration_sha256: registrationSha256,
  });
}
