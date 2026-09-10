import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";

import {
  BROWSER_POLICY_CONTRACT_VERSION,
  BROWSER_POLICY_CARRIER_SOURCE,
  BROWSER_POLICY_STORAGE_SYMBOL_KEY,
  BrowserPolicyContractError as BrowserPolicyCarrierError,
  canonicalBrowserNetworkAllowlistV1,
  validateBrowserPolicyCarrierIdV1,
  validateCanonicalBrowserNetworkAllowlistV1,
  validateRegisteredBrowserPolicyCarrierV1,
  type RegisteredBrowserPolicyCarrierV1,
} from "./browser-policy-contract-v1.js";

export { BrowserPolicyCarrierError };
export type { RegisteredBrowserPolicyCarrierV1 };

/** Canonicalize a registration-authored browser allowlist into a frozen exact v1 value. */
export function canonicalBrowserNetworkAllowlist(
  rawPatterns: readonly string[]
): readonly string[] {
  return canonicalBrowserNetworkAllowlistV1(rawPatterns, "browser policy");
}

/** Require the registration value itself to be the frozen canonical list later projected. */
export function validateRegisteredBrowserNetworkAllowlist(
  value: unknown,
  source: string
): readonly string[] {
  return validateCanonicalBrowserNetworkAllowlistV1(value, source);
}

function carrierStorage(): AsyncLocalStorage<unknown> {
  const storageKey = Symbol.for(BROWSER_POLICY_STORAGE_SYMBOL_KEY);
  const existing: unknown = Reflect.get(globalThis, storageKey);
  if (existing instanceof AsyncLocalStorage) return existing;
  const created = new AsyncLocalStorage<unknown>();
  Reflect.set(globalThis, storageKey, created);
  return created;
}

const registeredBrowserPolicies = carrierStorage();

export function currentRegisteredBrowserPolicyCarrier():
  | RegisteredBrowserPolicyCarrierV1
  | undefined {
  const value = registeredBrowserPolicies.getStore();
  return value === undefined ? undefined : validateRegisteredBrowserPolicyCarrierV1(value);
}

/** Stable opaque owner identity shared by the worker and runtime-host admission check. */
export function registeredBrowserPolicyOwnerScopeId(input: {
  readonly projectRoot: string;
  readonly registrationName: string;
  readonly runId: string;
}): string {
  return `run-${createHash("sha256")
    .update("penny.browser-policy-owner.v1")
    .update("\0")
    .update(input.projectRoot)
    .update("\0")
    .update(input.registrationName)
    .update("\0")
    .update(input.runId)
    .digest("hex")
    .slice(0, 32)}`;
}

export function assertRegisteredBrowserPolicyCarrier(input: {
  readonly registrationName: string;
  readonly stateId: string;
  readonly ownerScopeId?: string;
  readonly invocationId?: string;
  readonly allowlist?: readonly string[];
}): void {
  const rawCarrier = registeredBrowserPolicies.getStore();
  if (input.allowlist === undefined) {
    if (rawCarrier !== undefined) {
      throw new BrowserPolicyCarrierError(
        "ordinary registration refuses an unregistered browser policy carrier"
      );
    }
    return;
  }
  const expected = validateRegisteredBrowserNetworkAllowlist(
    input.allowlist,
    "worker invocation browser policy"
  );
  if (input.ownerScopeId === undefined || input.invocationId === undefined) {
    throw new BrowserPolicyCarrierError(
      "restricted registration has no complete expected browser policy identity"
    );
  }
  if (rawCarrier === undefined) {
    throw new BrowserPolicyCarrierError(
      "restricted registration has no host-owned browser policy carrier"
    );
  }
  const carrier = validateRegisteredBrowserPolicyCarrierV1(rawCarrier);
  if (
    carrier.registration_name !== input.registrationName ||
    carrier.state_id !== input.stateId ||
    carrier.owner_scope_id !== input.ownerScopeId ||
    carrier.invocation_id !== input.invocationId ||
    carrier.allowlist.length !== expected.length ||
    carrier.allowlist.some((pattern, index) => pattern !== expected[index])
  ) {
    throw new BrowserPolicyCarrierError(
      "worker invocation browser policy does not match its host-owned registration carrier"
    );
  }
}

export function runWithRegisteredBrowserPolicy<T>(
  input: {
    readonly ownerScopeId: string;
    readonly invocationId: string;
    readonly registrationName: string;
    readonly stateId: string;
    readonly allowlist: readonly string[];
  },
  operation: () => T
): T {
  const carrier = validateRegisteredBrowserPolicyCarrierV1(
    Object.freeze({
      schema_version: BROWSER_POLICY_CONTRACT_VERSION,
      source: BROWSER_POLICY_CARRIER_SOURCE,
      owner_scope_id: validateBrowserPolicyCarrierIdV1(input.ownerScopeId, "ownerScopeId"),
      invocation_id: validateBrowserPolicyCarrierIdV1(input.invocationId, "invocationId"),
      registration_name: validateBrowserPolicyCarrierIdV1(
        input.registrationName,
        "registrationName"
      ),
      state_id: validateBrowserPolicyCarrierIdV1(input.stateId, "stateId"),
      allowlist: validateRegisteredBrowserNetworkAllowlist(
        input.allowlist,
        "registered browser policy"
      ),
    })
  );
  return registeredBrowserPolicies.run(carrier, operation);
}
