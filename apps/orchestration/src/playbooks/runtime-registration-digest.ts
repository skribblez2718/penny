import { canonicalJson, sha256 } from "../checkpointer.js";
import { validateHostOperationAuthority } from "../host-operations/contracts.js";
import { validateSealPolicy } from "../skill-contracts/sealing.js";
import type { PlaybookRegistration } from "./registry.js";

/**
 * Canonical runtime-registration digest, isolated from the registry's concrete imports so
 * composition verification can compare an active producer without creating a module cycle.
 */
export function runtimeRegistrationSha256(registration: PlaybookRegistration): string {
  const worker =
    registration.worker.kind === "catalog-agent"
      ? {
          kind: registration.worker.kind,
          workflow_name: registration.worker.workflow_name,
          guidance: registration.worker.guidance,
          ...(registration.worker.documentation_sources === undefined
            ? {}
            : { documentation_sources: registration.worker.documentation_sources }),
          ...(registration.worker.prompt_sources === undefined
            ? {}
            : { prompt_sources: registration.worker.prompt_sources }),
          guidance_required: registration.worker.guidance_required,
          result_transport: registration.worker.result_transport,
          opening_policy: registration.worker.opening_policy,
          model_policy: registration.worker.model_policy,
          phases: [...registration.worker.phases.entries()]
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([state_id, phase]) => ({
              state_id,
              agent: phase.agent,
              result_schema_id: phase.result_schema_id,
              result_schema_version: phase.result_schema_version,
              schema: phase.schema,
              ...(phase.result_projection === undefined
                ? {}
                : { result_projection: phase.result_projection.declaration }),
              ...(phase.routing_repair_policy === undefined
                ? {}
                : { routing_repair_policy: phase.routing_repair_policy }),
              allowed_tools: phase.allowed_tools ?? null,
              ...(phase.required_model === undefined
                ? {}
                : { required_model: phase.required_model }),
              ...(phase.provider_opening_guard === undefined
                ? {}
                : { provider_opening_guard: phase.provider_opening_guard }),
              ...(phase.browser_network_allowlist === undefined
                ? {}
                : { browser_network_allowlist: phase.browser_network_allowlist }),
              ...(phase.directive_state_id === undefined
                ? {}
                : { directive_state_id: phase.directive_state_id }),
              ...(phase.guidance_state_id === undefined
                ? {}
                : { guidance_state_id: phase.guidance_state_id }),
              ...(phase.requires_image_input === undefined
                ? {}
                : { requires_image_input: phase.requires_image_input }),
            })),
        }
      : {
          kind: registration.worker.kind,
          workflow_name: registration.worker.workflow_name,
          guidance: registration.worker.guidance,
          ...(registration.worker.documentation_sources === undefined
            ? {}
            : { documentation_sources: registration.worker.documentation_sources }),
          ...(registration.worker.prompt_sources === undefined
            ? {}
            : { prompt_sources: registration.worker.prompt_sources }),
          guidance_required: registration.worker.guidance_required,
          result_transport: registration.worker.result_transport,
          opening_policy: registration.worker.opening_policy,
          model_policy: registration.worker.model_policy,
          phases: [...registration.worker.phases.entries()]
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([state_id, phase]) => ({ state_id, agent: phase.agent })),
        };
  return sha256(
    canonicalJson({
      name: registration.name,
      contract: registration.contract,
      ingress: registration.ingress,
      ...(registration.contextual_inputs === undefined
        ? {}
        : { contextual_inputs: registration.contextual_inputs }),
      start_admission:
        registration.start_admission === undefined
          ? null
          : {
              schema_id: registration.start_admission.schema_id,
              schema_version: registration.start_admission.schema_version,
              ...(registration.start_admission.invocation_versions === undefined
                ? {}
                : { invocation_versions: registration.start_admission.invocation_versions }),
            },
      liveness: {
        resolver_id: registration.liveness.resolver_id,
        thinking_policy: registration.liveness.thinking_policy,
      },
      worker,
      host_states: [...(registration.host_states ?? [])],
      generic_child: registration.generic_child ?? null,
      ...(registration.information_child === undefined
        ? {}
        : { information_child: registration.information_child }),
      ...(registration.imagegen_child === undefined
        ? {}
        : { imagegen_child: registration.imagegen_child }),
      ...(registration.repair_progress_policy === undefined
        ? {}
        : { repair_progress_policy: registration.repair_progress_policy }),
      ...(registration.seal_policy === undefined
        ? {}
        : { seal_policy: validateSealPolicy(registration.seal_policy) }),
      ...(registration.host_operations === undefined
        ? {}
        : {
            host_operations: {
              ...validateHostOperationAuthority(registration.host_operations),
              declarations: [...registration.host_operations.declarations].sort((left, right) =>
                left.operation_kind.localeCompare(right.operation_kind)
              ),
            },
          }),
      completion_receipt_predicate_ids: [...registration.completionReceiptPredicates.keys()].sort(),
    })
  );
}
