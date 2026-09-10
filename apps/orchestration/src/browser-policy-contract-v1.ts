import { isIP } from "node:net";

/** Wire-contract version shared by the orchestration host and Playwright consumer. */
export const BROWSER_POLICY_CONTRACT_VERSION = 1;
export const BROWSER_POLICY_CARRIER_SOURCE = "orchestration-registration";
export const BROWSER_POLICY_STORAGE_SYMBOL_KEY = "penny.browser-network-policy-carrier.v1";
export const BROWSER_NETWORK_SCHEMES = Object.freeze(["http", "https", "ws", "wss"] as const);
export const MAX_BROWSER_POLICY_PATTERNS = 64;
export const MAX_BROWSER_POLICY_PATTERN_CHARS = 512;
export const MAX_BROWSER_POLICY_TOTAL_CHARS = 8_192;
export const MAX_BROWSER_POLICY_ID_CHARS = 128;

export type BrowserNetworkSchemeV1 = (typeof BROWSER_NETWORK_SCHEMES)[number];

export interface CanonicalBrowserNetworkPatternV1 {
  readonly canonical: string;
  readonly scheme: BrowserNetworkSchemeV1 | null;
  readonly hostname: string;
  readonly includeSubdomains: boolean;
  readonly port: number | null;
}

export interface CanonicalBrowserNetworkPatternFieldsV1 {
  readonly scheme: BrowserNetworkSchemeV1 | null;
  readonly hostname: string;
  readonly includeSubdomains: boolean;
  readonly port: number | null;
}

export interface RegisteredBrowserPolicyCarrierV1 {
  readonly schema_version: 1;
  readonly source: "orchestration-registration";
  readonly owner_scope_id: string;
  readonly invocation_id: string;
  readonly registration_name: string;
  readonly state_id: string;
  readonly allowlist: readonly string[];
}

const REGISTERED_CARRIER_KEYS = new Set([
  "schema_version",
  "source",
  "owner_scope_id",
  "invocation_id",
  "registration_name",
  "state_id",
  "allowlist",
]);

export class BrowserPolicyContractError extends Error {
  readonly code = "BROWSER_POLICY_CONTRACT_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "BrowserPolicyContractError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isBrowserNetworkSchemeV1(value: string): value is BrowserNetworkSchemeV1 {
  return BROWSER_NETWORK_SCHEMES.some((scheme) => scheme === value);
}

export function browserNetworkDefaultPortV1(scheme: BrowserNetworkSchemeV1): number {
  return scheme === "http" || scheme === "ws" ? 80 : 443;
}

function explicitPort(authority: string): number | null {
  let portText: string | null = null;
  if (authority.startsWith("[")) {
    const closingBracket = authority.indexOf("]");
    if (closingBracket < 0) {
      throw new BrowserPolicyContractError("IPv6 host is missing a closing bracket");
    }
    const suffix = authority.slice(closingBracket + 1);
    if (suffix.length > 0) {
      if (!suffix.startsWith(":")) {
        throw new BrowserPolicyContractError("unexpected text after IPv6 host");
      }
      portText = suffix.slice(1);
    }
  } else {
    const colon = authority.lastIndexOf(":");
    if (colon >= 0) portText = authority.slice(colon + 1);
  }

  if (portText === null) return null;
  if (!/^\d{1,5}$/u.test(portText)) {
    throw new BrowserPolicyContractError("port must be a decimal integer from 1 to 65535");
  }
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new BrowserPolicyContractError("port must be a decimal integer from 1 to 65535");
  }
  return port;
}

function unbracketHostname(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

export function normalizeBrowserNetworkHostnameV1(hostname: string): string {
  const lower = hostname.toLowerCase();
  if (lower.startsWith("[") && lower.endsWith("]")) return lower;
  return lower.endsWith(".") ? lower.slice(0, -1) : lower;
}

function validateHostname(hostname: string, wildcard: boolean): void {
  if (isIP(unbracketHostname(hostname)) > 0) {
    if (wildcard) {
      throw new BrowserPolicyContractError("wildcards are not valid for IP literals");
    }
    return;
  }
  if (hostname.length > 253) {
    throw new BrowserPolicyContractError("hostname exceeds 253 characters");
  }
  const labels = hostname.split(".");
  if (
    labels.some(
      (label) =>
        label.length < 1 || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label)
    )
  ) {
    throw new BrowserPolicyContractError("hostname contains an invalid DNS label");
  }
}

export function canonicalBrowserNetworkPatternValueV1(
  input: CanonicalBrowserNetworkPatternFieldsV1
): string {
  const host = `${input.includeSubdomains ? "*." : ""}${input.hostname}`;
  const port = input.port === null ? "" : `:${input.port}`;
  return `${input.scheme === null ? "" : `${input.scheme}://`}${host}${port}`;
}

/** Parse one destination pattern into the canonical v1 wire representation. */
export function parseBrowserNetworkPatternV1(rawPattern: string): CanonicalBrowserNetworkPatternV1 {
  const pattern = rawPattern.trim();
  if (pattern.length < 1 || pattern.length > MAX_BROWSER_POLICY_PATTERN_CHARS) {
    throw new BrowserPolicyContractError(
      `pattern must contain 1-${MAX_BROWSER_POLICY_PATTERN_CHARS} characters`
    );
  }
  if (/\s/u.test(pattern)) {
    throw new BrowserPolicyContractError("pattern must not contain whitespace");
  }

  const schemeMatch = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//u.exec(pattern);
  const schemeText = schemeMatch?.[1]?.toLowerCase() ?? null;
  if (schemeText !== null && !isBrowserNetworkSchemeV1(schemeText)) {
    throw new BrowserPolicyContractError("scheme must be http, https, ws, or wss");
  }
  const authority = schemeMatch === null ? pattern : pattern.slice(schemeMatch[0].length);
  if (authority.length < 1 || /[/?#@]/u.test(authority)) {
    throw new BrowserPolicyContractError(
      "pattern must contain only a host and optional port; paths, credentials, query, and fragments are not allowed"
    );
  }

  const includeSubdomains = authority.startsWith("*.");
  const parseAuthority = includeSubdomains ? `wildcard.${authority.slice(2)}` : authority;
  const port = explicitPort(parseAuthority);
  let parsed: URL;
  try {
    parsed = new URL(`${schemeText ?? "http"}://${parseAuthority}/`);
  } catch {
    throw new BrowserPolicyContractError("pattern is not a valid URL authority");
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    throw new BrowserPolicyContractError("credentials are not allowed in a network pattern");
  }

  let hostname = normalizeBrowserNetworkHostnameV1(parsed.hostname);
  if (includeSubdomains) {
    if (!hostname.startsWith("wildcard.")) {
      throw new BrowserPolicyContractError("wildcard host is invalid");
    }
    hostname = hostname.slice("wildcard.".length);
  }
  validateHostname(hostname, includeSubdomains);

  const effectivePort =
    port ?? (schemeText === null ? null : browserNetworkDefaultPortV1(schemeText));
  return Object.freeze({
    canonical: canonicalBrowserNetworkPatternValueV1({
      scheme: schemeText,
      hostname,
      includeSubdomains,
      port: effectivePort,
    }),
    scheme: schemeText,
    hostname,
    includeSubdomains,
    port: effectivePort,
  });
}

/** Parse, bound, deduplicate, and sort a v1 destination allowlist. */
export function parseBrowserNetworkAllowlistV1(
  rawPatterns: readonly string[],
  source = "browser network policy"
): readonly CanonicalBrowserNetworkPatternV1[] {
  if (rawPatterns.length > MAX_BROWSER_POLICY_PATTERNS) {
    throw new BrowserPolicyContractError(
      `${source} exceeds the ${MAX_BROWSER_POLICY_PATTERNS}-pattern limit`
    );
  }

  const totalChars = rawPatterns.reduce((total, pattern) => total + pattern.length, 0);
  if (totalChars > MAX_BROWSER_POLICY_TOTAL_CHARS) {
    throw new BrowserPolicyContractError(
      `${source} exceeds the ${MAX_BROWSER_POLICY_TOTAL_CHARS}-character limit`
    );
  }

  const unique = new Map<string, CanonicalBrowserNetworkPatternV1>();
  for (const [index, rawPattern] of rawPatterns.entries()) {
    let parsed: CanonicalBrowserNetworkPatternV1;
    try {
      parsed = parseBrowserNetworkPatternV1(rawPattern);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "invalid pattern";
      throw new BrowserPolicyContractError(`${source} entry ${index + 1} is invalid: ${reason}`);
    }
    unique.set(parsed.canonical, parsed);
  }

  const values = [...unique.values()].sort((left, right) =>
    left.canonical < right.canonical ? -1 : left.canonical > right.canonical ? 1 : 0
  );
  const canonicalChars = values.reduce((total, pattern) => total + pattern.canonical.length, 0);
  if (canonicalChars > MAX_BROWSER_POLICY_TOTAL_CHARS) {
    throw new BrowserPolicyContractError(
      `canonical ${source} exceeds the ${MAX_BROWSER_POLICY_TOTAL_CHARS}-character limit`
    );
  }
  return Object.freeze(values);
}

/** Canonical frozen strings for registration authoring. */
export function canonicalBrowserNetworkAllowlistV1(
  rawPatterns: readonly string[],
  source = "browser policy"
): readonly string[] {
  return Object.freeze(
    parseBrowserNetworkAllowlistV1(rawPatterns, source).map((pattern) => pattern.canonical)
  );
}

/** Require an exact immutable canonical registration allowlist. */
export function validateCanonicalBrowserNetworkAllowlistV1(
  value: unknown,
  source: string
): readonly string[] {
  if (!Array.isArray(value)) {
    throw new BrowserPolicyContractError(`${source} must be an array`);
  }
  if (!Object.isFrozen(value)) {
    throw new BrowserPolicyContractError(`${source} must be immutable`);
  }
  const rawPatterns: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      throw new BrowserPolicyContractError(`${source} entries must be strings`);
    }
    rawPatterns.push(entry);
  }
  const canonical = canonicalBrowserNetworkAllowlistV1(rawPatterns, source);
  if (
    canonical.length !== rawPatterns.length ||
    canonical.some((pattern, index) => pattern !== rawPatterns[index])
  ) {
    throw new BrowserPolicyContractError(`${source} must be canonical, sorted, and duplicate-free`);
  }
  return Object.freeze(rawPatterns);
}

/** Validate all v1 carrier identities with the same bound on both sides of the wire. */
export function validateBrowserPolicyCarrierIdV1(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new BrowserPolicyContractError(`${field} must be a string`);
  }
  if (value.length < 1 || value.length > MAX_BROWSER_POLICY_ID_CHARS) {
    throw new BrowserPolicyContractError(
      `${field} must contain 1-${MAX_BROWSER_POLICY_ID_CHARS} characters`
    );
  }
  if (!/^[A-Za-z0-9._:-]+$/u.test(value)) {
    throw new BrowserPolicyContractError(
      `${field} may contain only ASCII letters, digits, dot, underscore, colon, and hyphen`
    );
  }
  return value;
}

/** Validate and freeze the sole production-accepted v1 browser policy carrier. */
export function validateRegisteredBrowserPolicyCarrierV1(
  value: unknown
): RegisteredBrowserPolicyCarrierV1 {
  if (!isRecord(value)) {
    throw new BrowserPolicyContractError("active browser policy carrier is malformed");
  }
  const unknownKey = Object.keys(value).find((key) => !REGISTERED_CARRIER_KEYS.has(key));
  if (unknownKey !== undefined) {
    throw new BrowserPolicyContractError(
      `active browser policy carrier has unknown field '${unknownKey}'`
    );
  }
  if (
    value.schema_version !== BROWSER_POLICY_CONTRACT_VERSION ||
    value.source !== BROWSER_POLICY_CARRIER_SOURCE
  ) {
    throw new BrowserPolicyContractError(
      "active browser policy carrier is not owned by orchestration registration"
    );
  }
  return Object.freeze({
    schema_version: BROWSER_POLICY_CONTRACT_VERSION,
    source: BROWSER_POLICY_CARRIER_SOURCE,
    owner_scope_id: validateBrowserPolicyCarrierIdV1(value.owner_scope_id, "owner_scope_id"),
    invocation_id: validateBrowserPolicyCarrierIdV1(value.invocation_id, "invocation_id"),
    registration_name: validateBrowserPolicyCarrierIdV1(
      value.registration_name,
      "registration_name"
    ),
    state_id: validateBrowserPolicyCarrierIdV1(value.state_id, "state_id"),
    allowlist: validateCanonicalBrowserNetworkAllowlistV1(
      value.allowlist,
      "active browser policy carrier allowlist"
    ),
  });
}
