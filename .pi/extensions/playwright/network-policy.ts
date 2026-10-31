import { AsyncLocalStorage } from "node:async_hooks";

import {
  BROWSER_POLICY_STORAGE_SYMBOL_KEY,
  BrowserPolicyContractError as NetworkPolicyValidationError,
  browserNetworkDefaultPortV1,
  canonicalBrowserNetworkPatternValueV1,
  isBrowserNetworkSchemeV1,
  MAX_BROWSER_POLICY_ID_CHARS,
  MAX_BROWSER_POLICY_PATTERN_CHARS,
  MAX_BROWSER_POLICY_PATTERNS,
  MAX_BROWSER_POLICY_TOTAL_CHARS,
  normalizeBrowserNetworkHostnameV1,
  parseBrowserNetworkAllowlistV1,
  parseBrowserNetworkPatternV1,
  validateCanonicalBrowserNetworkAllowlistV1,
  validateRegisteredBrowserPolicyCarrierV1,
  type BrowserNetworkSchemeV1,
  type CanonicalBrowserNetworkPatternV1,
} from "../../../apps/orchestration/dist/browser-policy-contract.js";

export const MAX_NETWORK_POLICY_PATTERNS = MAX_BROWSER_POLICY_PATTERNS;
export const MAX_NETWORK_POLICY_PATTERN_CHARS = MAX_BROWSER_POLICY_PATTERN_CHARS;
export const MAX_NETWORK_POLICY_TOTAL_CHARS = MAX_BROWSER_POLICY_TOTAL_CHARS;
export const MAX_BROWSER_URL_CHARS = 8_192;
export const MAX_POLICY_SCOPE_ID_CHARS = MAX_BROWSER_POLICY_ID_CHARS;
export { NetworkPolicyValidationError };

export type BrowserNetworkScheme = BrowserNetworkSchemeV1;
export type CanonicalNetworkPattern = CanonicalBrowserNetworkPatternV1;

export type NetworkPolicy =
  | {
      readonly mode: "unrestricted";
      readonly patterns: readonly CanonicalNetworkPattern[];
    }
  | {
      readonly mode: "allow";
      readonly patterns: readonly CanonicalNetworkPattern[];
    }
  | {
      readonly mode: "deny-all";
      readonly patterns: readonly CanonicalNetworkPattern[];
    };

export type NetworkDecision =
  | {
      readonly allowed: true;
      readonly reasonCode: "BROWSER_NETWORK_UNRESTRICTED" | "BROWSER_NETWORK_ALLOWED";
      readonly destination: string;
    }
  | {
      readonly allowed: false;
      readonly reasonCode:
        | "BROWSER_NETWORK_DENY_ALL"
        | "BROWSER_NETWORK_DESTINATION_DENIED"
        | "BROWSER_NETWORK_INVALID_URL"
        | "BROWSER_NETWORK_UNSUPPORTED_SCHEME"
        | "BROWSER_NETWORK_URL_TOO_LONG";
      readonly destination: string;
    };

export interface TrustedBrowserInvocationPolicy {
  readonly ownerScopeId: string;
  readonly invocationId: string;
  readonly policy: NetworkPolicy;
}

export interface EffectiveBrowserPolicyBinding {
  readonly ownerScopeId: string;
  readonly invocationId: string;
  readonly invocationPolicyPresent: boolean;
  readonly policy: NetworkPolicy;
}

const UNRESTRICTED_POLICY: NetworkPolicy = Object.freeze({
  mode: "unrestricted",
  patterns: Object.freeze([]),
});
const DENY_ALL_POLICY: NetworkPolicy = Object.freeze({
  mode: "deny-all",
  patterns: Object.freeze([]),
});

function trustedPolicyStorage(): AsyncLocalStorage<unknown> {
  const storageKey = Symbol.for(BROWSER_POLICY_STORAGE_SYMBOL_KEY);
  const existing: unknown = Reflect.get(globalThis, storageKey);
  if (existing instanceof AsyncLocalStorage) return existing;
  const created = new AsyncLocalStorage<unknown>();
  Reflect.set(globalThis, storageKey, created);
  return created;
}

// The global symbol keeps one context-local carrier when Pi's Jiti loader and the
// compiled orchestration host evaluate the modules through different URLs.
const trustedInvocationPolicies = trustedPolicyStorage();

export function parseCanonicalNetworkPattern(rawPattern: string): CanonicalNetworkPattern {
  return parseBrowserNetworkPatternV1(rawPattern);
}

function allowPolicy(patterns: readonly CanonicalNetworkPattern[]): NetworkPolicy {
  if (patterns.length === 0) return DENY_ALL_POLICY;
  return Object.freeze({
    mode: "allow",
    patterns: Object.freeze([...patterns]),
  });
}

export function parseConfiguredNetworkPolicy(
  rawPatterns: readonly string[],
  source = "network policy"
): NetworkPolicy {
  if (rawPatterns.length === 0) return UNRESTRICTED_POLICY;
  return allowPolicy(parseBrowserNetworkAllowlistV1(rawPatterns, source));
}

function hostPatternContains(
  container: CanonicalNetworkPattern,
  candidate: CanonicalNetworkPattern
): boolean {
  if (!container.includeSubdomains) {
    return !candidate.includeSubdomains && container.hostname === candidate.hostname;
  }
  if (!candidate.includeSubdomains) {
    return (
      candidate.hostname !== container.hostname &&
      candidate.hostname.endsWith(`.${container.hostname}`)
    );
  }
  return (
    candidate.hostname === container.hostname ||
    candidate.hostname.endsWith(`.${container.hostname}`)
  );
}

function intersectPatterns(
  left: CanonicalNetworkPattern,
  right: CanonicalNetworkPattern
): CanonicalNetworkPattern | null {
  let scheme: BrowserNetworkScheme | null;
  if (left.scheme === null) scheme = right.scheme;
  else if (right.scheme === null) scheme = left.scheme;
  else if (left.scheme === right.scheme) scheme = left.scheme;
  else return null;

  let port: number | null;
  if (left.port === null) port = right.port;
  else if (right.port === null) port = left.port;
  else if (left.port === right.port) port = left.port;
  else return null;

  let hostPattern: CanonicalNetworkPattern;
  if (hostPatternContains(left, right)) hostPattern = right;
  else if (hostPatternContains(right, left)) hostPattern = left;
  else return null;

  return parseBrowserNetworkPatternV1(
    canonicalBrowserNetworkPatternValueV1({
      scheme,
      hostname: hostPattern.hostname,
      includeSubdomains: hostPattern.includeSubdomains,
      port,
    })
  );
}

export function composeNetworkPolicies(
  processCeiling: NetworkPolicy,
  invocationPolicy: NetworkPolicy
): NetworkPolicy {
  if (processCeiling.mode === "deny-all" || invocationPolicy.mode === "deny-all") {
    return DENY_ALL_POLICY;
  }
  if (processCeiling.mode === "unrestricted") return invocationPolicy;
  if (invocationPolicy.mode === "unrestricted") return processCeiling;

  const intersections = processCeiling.patterns.flatMap((processPattern) =>
    invocationPolicy.patterns
      .map((invocationPattern) => intersectPatterns(processPattern, invocationPattern))
      .filter((pattern): pattern is CanonicalNetworkPattern => pattern !== null)
  );
  const unique = new Map(intersections.map((pattern) => [pattern.canonical, pattern]));
  return allowPolicy(
    [...unique.values()].sort((left, right) =>
      left.canonical < right.canonical ? -1 : left.canonical > right.canonical ? 1 : 0
    )
  );
}

function patternMatchesUrl(pattern: CanonicalNetworkPattern, url: URL): boolean {
  const schemeText = url.protocol.slice(0, -1).toLowerCase();
  if (!isBrowserNetworkSchemeV1(schemeText)) return false;
  if (pattern.scheme !== null && pattern.scheme !== schemeText) return false;
  const port = url.port.length > 0 ? Number(url.port) : browserNetworkDefaultPortV1(schemeText);
  if (pattern.port !== null && pattern.port !== port) return false;

  const hostname = normalizeBrowserNetworkHostnameV1(url.hostname);
  if (!pattern.includeSubdomains) return pattern.hostname === hostname;
  return hostname !== pattern.hostname && hostname.endsWith(`.${pattern.hostname}`);
}

export function describeBrowserDestination(rawUrl: string): string {
  if (rawUrl.length > MAX_BROWSER_URL_CHARS) return "invalid-destination";
  try {
    const url = new URL(rawUrl);
    const schemeText = url.protocol.slice(0, -1).toLowerCase();
    if (!isBrowserNetworkSchemeV1(schemeText)) return `${url.protocol}//unsupported`;
    const port = url.port.length > 0 ? Number(url.port) : browserNetworkDefaultPortV1(schemeText);
    return `${schemeText}://${normalizeBrowserNetworkHostnameV1(url.hostname)}:${port}`;
  } catch {
    return "invalid-destination";
  }
}

export function authorizeNetworkUrl(policy: NetworkPolicy, rawUrl: string): NetworkDecision {
  const destination = describeBrowserDestination(rawUrl);
  if (policy.mode === "unrestricted") {
    return Object.freeze({
      allowed: true,
      reasonCode: "BROWSER_NETWORK_UNRESTRICTED",
      destination,
    });
  }
  if (rawUrl.length > MAX_BROWSER_URL_CHARS) {
    return Object.freeze({
      allowed: false,
      reasonCode: "BROWSER_NETWORK_URL_TOO_LONG",
      destination,
    });
  }

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return Object.freeze({
      allowed: false,
      reasonCode: "BROWSER_NETWORK_INVALID_URL",
      destination,
    });
  }
  const schemeText = url.protocol.slice(0, -1).toLowerCase();
  if (!isBrowserNetworkSchemeV1(schemeText)) {
    return Object.freeze({
      allowed: false,
      reasonCode: "BROWSER_NETWORK_UNSUPPORTED_SCHEME",
      destination,
    });
  }
  if (policy.mode === "deny-all") {
    return Object.freeze({
      allowed: false,
      reasonCode: "BROWSER_NETWORK_DENY_ALL",
      destination,
    });
  }
  if (policy.patterns.some((pattern) => patternMatchesUrl(pattern, url))) {
    return Object.freeze({
      allowed: true,
      reasonCode: "BROWSER_NETWORK_ALLOWED",
      destination,
    });
  }
  return Object.freeze({
    allowed: false,
    reasonCode: "BROWSER_NETWORK_DESTINATION_DENIED",
    destination,
  });
}

function networkPolicyFromRegisteredAllowlist(value: unknown): NetworkPolicy {
  const allowlist = validateCanonicalBrowserNetworkAllowlistV1(
    value,
    "orchestration browser policy allowlist"
  );
  if (allowlist.length === 0) return DENY_ALL_POLICY;
  return allowPolicy(
    parseBrowserNetworkAllowlistV1(allowlist, "orchestration browser policy allowlist")
  );
}

export function currentRegisteredBrowserPolicy(): TrustedBrowserInvocationPolicy | undefined {
  const value = trustedInvocationPolicies.getStore();
  if (value === undefined) return undefined;
  const carrier = validateRegisteredBrowserPolicyCarrierV1(value);
  return Object.freeze({
    ownerScopeId: carrier.owner_scope_id,
    invocationId: carrier.invocation_id,
    policy: networkPolicyFromRegisteredAllowlist(carrier.allowlist),
  });
}

export function effectiveBrowserPolicyBinding(
  processCeiling: NetworkPolicy,
  defaultOwnerScopeId: string
): EffectiveBrowserPolicyBinding {
  const invocation = currentRegisteredBrowserPolicy();
  if (invocation === undefined) {
    return Object.freeze({
      ownerScopeId: defaultOwnerScopeId,
      invocationId: "default",
      invocationPolicyPresent: false,
      policy: processCeiling,
    });
  }
  return Object.freeze({
    ownerScopeId: invocation.ownerScopeId,
    invocationId: invocation.invocationId,
    invocationPolicyPresent: true,
    policy: composeNetworkPolicies(processCeiling, invocation.policy),
  });
}

export function networkPolicySignature(policy: NetworkPolicy): string {
  return policy.mode === "allow"
    ? `${policy.mode}:${policy.patterns.map((pattern) => pattern.canonical).join(",")}`
    : policy.mode;
}

export function unrestrictedNetworkPolicy(): NetworkPolicy {
  return UNRESTRICTED_POLICY;
}
