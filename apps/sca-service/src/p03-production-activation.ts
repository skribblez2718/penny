import { createScaP03ActivationHostV1 } from "../../orchestration/dist/sca/p03-activation-host.js";
import { canonicalJson } from "../../orchestration/dist/canonical-json.js";
import {
  createScaP03ProductionBootstrapSamplerV1,
  type ScaP03SamplerAuthorityV1,
  type ScaP03ProductionSamplerInputV1,
} from "./p03-production-sampler.js";

import type { ScaAsyncActivationHostV1 } from "../../orchestration/dist/sca/qualification-activation.js";
import { ScaP03NativeVerificationInvocationV1 } from "./p03-bootstrap-verification.js";
export type ScaP03ProductionActivationInputV1 = Omit<
  Parameters<typeof createScaP03ActivationHostV1>[0],
  "sample_current_bootstrap" | "owner"
> & {
  readonly sampling_authority: ScaP03SamplerAuthorityV1;
  readonly sampler: ScaP03ProductionSamplerInputV1;
};

/** Asynchronous host sampling uses one explicitly supplied, independently human-authorized
 * native invocation. No direct child, model callback, historical or latest lookup is admitted. */
export function createScaP03ProductionActivationHostAsyncV1(
  input: ScaP03ProductionActivationInputV1 & {
    operator_invocation: ScaP03NativeVerificationInvocationV1;
  }
): ScaAsyncActivationHostV1 {
  if (
    "sample_current_bootstrap" in input ||
    !(input.operator_invocation instanceof ScaP03NativeVerificationInvocationV1)
  )
    throw new Error("p03_production_sample_override_denied");
  const scope = input.sampling_authority.installation.authority.scope;
  if (
    scope.tenant_id !== input.tenant_id ||
    scope.project_id !== input.project_id ||
    scope.issuer_policy_id !== input.issuer_policy_id ||
    scope.revocation_generation !== input.revocation_generation ||
    scope.qualification_run_id !== input.definition_ref.run_id ||
    canonicalJson(scope.gate_ref) !== canonicalJson(input.gate_ref)
  )
    throw new Error("p03_production_sampling_authority_mismatch");
  const sampler = createScaP03ProductionBootstrapSamplerV1(
    input.sampler,
    input.sampling_authority,
    input.operator_invocation
  );
  return Object.freeze({
    async sample() {
      const sample = await sampler();
      const host = createScaP03ActivationHostV1({
        ...input,
        owner: input.sampling_authority.owner,
        sample_current_bootstrap: () => sample,
      });
      return host.sample();
    },
    verifyIssuance: (claim) => input.sampling_authority.owner.verifyIssuance(claim),
  } satisfies ScaAsyncActivationHostV1);
}
/** P03 operational composition. No replacement bootstrap callback is admitted here.
 * Generic synchronous activation and separately authorized issuance remain unchanged. */
export function createScaP03ProductionActivationHostV1(input: ScaP03ProductionActivationInputV1) {
  if ("sample_current_bootstrap" in input) throw new Error("p03_production_sample_override_denied");
  const scope = input.sampling_authority.installation.authority.scope;
  if (
    scope.tenant_id !== input.tenant_id ||
    scope.project_id !== input.project_id ||
    scope.issuer_policy_id !== input.issuer_policy_id ||
    scope.revocation_generation !== input.revocation_generation ||
    scope.qualification_run_id !== input.definition_ref.run_id ||
    canonicalJson(scope.gate_ref) !== canonicalJson(input.gate_ref)
  )
    throw new Error("p03_production_sampling_authority_mismatch");
  const host = createScaP03ActivationHostV1({
    ...input,
    owner: input.sampling_authority.owner,
    sample_current_bootstrap: createScaP03ProductionBootstrapSamplerV1(
      input.sampler,
      input.sampling_authority
    ),
  });
  return Object.freeze({
    sample: (): ReturnType<typeof host.sample> => {
      // No preliminary binding/gate scan may accidentally reach a proof callback before a
      // canonical guarded operator operation exists. The legacy sampler stays read-only too.
      throw new Error("p03_guarded_bootstrap_verification_unavailable");
    },
    verifyIssuance: host.verifyIssuance,
  });
}
