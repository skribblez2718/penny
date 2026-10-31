import type { HostOperationAdapterV1 } from "../../orchestration/dist/host-operations/contracts.js";
import type { HostOperationUseValidatorV1 } from "../../orchestration/dist/host-operations/owner.js";
import { FileHostOperationResultCache } from "../../orchestration/dist/host-operations/result-cache.js";
import { OrchestrationService } from "../../orchestration/dist/service.js";
import type { SqliteScaPhaseActivationRegistry } from "../../orchestration/dist/sca/phase-activation.js";
import {
  prepareScaAsyncActivationHostV1,
  type ScaAsyncActivationHostV1,
  type ScaProposedActivationStartV1,
} from "../../orchestration/dist/sca/qualification-activation.js";
import {
  scaP03ProductionUseAuthorityFromBindingsV1,
  type ScaP03FrozenProductionBindingsV1,
} from "./p03-bootstrap.js";
import {
  createScaP03ProductionDockerJoernRuntimeV1,
  type DockerRunnerV1,
  type ScaP03DockerRuntimeConfigV1,
} from "./p03-docker-runtime.js";
import {
  createScaP03OperationAdaptersV1,
  type ScaP03JoernRuntimeV1,
  type ScaP03OperationAdapterOptionsV1,
} from "./p03-operations.js";
import { SCA_P03_PHASE_REGISTRATION } from "../../orchestration/dist/sca/p03-playbook.js";
import { runtimeRegistrationSha256 } from "../../orchestration/dist/playbooks/runtime-registration-digest.js";
import { createScaP03ProductionUseValidatorV1 } from "../../orchestration/dist/sca/p03-admission.js";
export type ScaP03ProductionRuntimeProofV1 = Parameters<
  typeof createScaP03ProductionDockerJoernRuntimeV1
>[1];

export interface ScaP03ProductionHostCompositionV1 {
  readonly runtime: ScaP03JoernRuntimeV1;
  readonly adapters: ReadonlyMap<string, HostOperationAdapterV1>;
  readonly use_validator: HostOperationUseValidatorV1;
  readonly result_cache: FileHostOperationResultCache;
  readonly production_bindings: ScaP03FrozenProductionBindingsV1;
}

export interface ScaP03ActivatedProductionServiceV1 extends ScaP03ProductionHostCompositionV1 {
  readonly service: OrchestrationService;
  readonly runtime_registration_sha256: string;
}

/** Construction is read-only. Live proof and work share the ordinary P03 owner context. */
export async function createScaP03ProductionHostCompositionV1(input: {
  readonly config: ScaP03DockerRuntimeConfigV1;
  readonly proof: ScaP03ProductionRuntimeProofV1;
  /** Existing owner-private cache root. Production composition never creates or repairs it. */
  readonly result_cache_root: string;
  readonly runner?: DockerRunnerV1;
  readonly adapter_options?: Omit<ScaP03OperationAdapterOptionsV1, "runtime">;
}): Promise<ScaP03ProductionHostCompositionV1> {
  const proof = input.proof;
  const runtime = await createScaP03ProductionDockerJoernRuntimeV1(
    input.config,
    proof,
    input.runner
  );
  const result_cache = await FileHostOperationResultCache.openExisting(input.result_cache_root);
  const baseline = createScaP03ProductionUseValidatorV1(
    proof.store,
    scaP03ProductionUseAuthorityFromBindingsV1(proof.production_bindings)
  );
  const policy = proof.owner_policy;
  if (policy === undefined) throw new Error("p03_production_native_policy_required");
  const resources = structuredClone(policy.resources);
  const sealed = structuredClone(policy.sealed_inputs);
  const use_validator: HostOperationUseValidatorV1 = {
    validateUse(input) {
      input.signal.throwIfAborted();
      policy.native_host.assertSealedCurrent(sealed, resources);
      baseline.validateUse(input);
      const bytes: unknown = JSON.parse(Buffer.from(input.request_bytes).toString("utf8"));
      if (
        typeof bytes !== "object" ||
        bytes === null ||
        !("backend_resource_sha256" in bytes) ||
        bytes.backend_resource_sha256 !== input.directive.policy_binding.backend_key_sha256 ||
        input.directive.policy_binding.backend_key_sha256 !==
          policy.native_host.backendResourceSha256()
      )
        throw new Error("p03_production_backend_resource_required");
    },
  };
  return Object.freeze({
    runtime,
    result_cache,
    use_validator,
    adapters: createScaP03OperationAdaptersV1({ ...input.adapter_options, runtime }),
    production_bindings: structuredClone(proof.production_bindings),
  });
}

/** Fail before activation-host sampling as well as before runtime construction. */
export async function createScaP03ActivatedProductionServiceV1(input: {
  readonly project_root: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly activation_host: ScaAsyncActivationHostV1;
  readonly proposed_start: ScaProposedActivationStartV1;
  readonly phase_registry: Pick<SqliteScaPhaseActivationRegistry, "resolve">;
  readonly host: Parameters<typeof createScaP03ProductionHostCompositionV1>[0];
}): Promise<ScaP03ActivatedProductionServiceV1> {
  // Independently authorized native verification is awaited OUTSIDE registry/issuer
  // transactions and outside the ordinary phase-host use guard.
  const composition = await createScaP03ProductionHostCompositionV1(input.host);
  const host = await prepareScaAsyncActivationHostV1(input.activation_host);
  const registration = input.phase_registry.resolve({ host, proposed: input.proposed_start });
  if (registration !== SCA_P03_PHASE_REGISTRATION)
    throw new Error("p03_production_registration_mismatch");
  const service = new OrchestrationService({
    projectRoot: input.project_root,
    env: input.env,
    playbookRegistration: registration,
    enableChildWorkflows: false,
    hostOperationAdapters: composition.adapters,
    hostOperationResultCache: composition.result_cache,
    hostOperationUseValidator: composition.use_validator,
  });
  return Object.freeze({
    ...composition,
    service,
    runtime_registration_sha256: runtimeRegistrationSha256(registration),
  });
}
