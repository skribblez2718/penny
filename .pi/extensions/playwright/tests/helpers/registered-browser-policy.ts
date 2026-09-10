import {
  assertRegisteredBrowserPolicyCarrier,
  canonicalBrowserNetworkAllowlist,
  runWithRegisteredBrowserPolicy,
} from "../../../../../apps/orchestration/src/browser-policy-carrier.js";

export interface RegisteredBrowserPolicyTestInput {
  readonly ownerScopeId: string;
  readonly invocationId: string;
  readonly rawAllowlist: readonly string[];
  readonly registrationName?: string;
  readonly stateId?: string;
}

/** Exercise the production orchestration carrier and its model-client admission check. */
export function runWithAdmittedRegisteredBrowserPolicy<T>(
  input: RegisteredBrowserPolicyTestInput,
  operation: (allowlist: readonly string[]) => T
): T {
  const registrationName = input.registrationName ?? "synthetic-browser-registration";
  const stateId = input.stateId ?? "browser-phase";
  const allowlist = canonicalBrowserNetworkAllowlist(input.rawAllowlist);
  return runWithRegisteredBrowserPolicy(
    {
      ownerScopeId: input.ownerScopeId,
      invocationId: input.invocationId,
      registrationName,
      stateId,
      allowlist,
    },
    () => {
      assertRegisteredBrowserPolicyCarrier({
        ownerScopeId: input.ownerScopeId,
        invocationId: input.invocationId,
        registrationName,
        stateId,
        allowlist,
      });
      return operation(allowlist);
    }
  );
}
