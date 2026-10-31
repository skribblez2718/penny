/**
 * Ollama Web Search API client.
 *
 * Wraps Ollama's cloud web search and web fetch endpoints:
 *   POST https://ollama.com/api/web_search  { query, max_results }
 *   POST https://ollama.com/api/web_fetch   { url }
 *
 * Both require an Ollama API key (Authorization: Bearer).
 * Docs: https://docs.ollama.com/capabilities/web-search
 */

// ── Constants (static, no env reads) ─────────────────────

export const DEFAULT_BASE_URL = "https://ollama.com";
export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_RESULTS = 5;
export const MAX_RESULTS_LIMIT = 10;
export const MAX_FETCH_CONTENT_CHARS = 80_000;
export const MAX_PROVIDER_RESPONSE_BYTES = 8 * 1024 * 1024;
export const MAX_PROVIDER_JSON_DEPTH = 32;
export const MAX_PROVIDER_JSON_VALUES = 50_000;

// ── Types ────────────────────────────────────────────────

export interface SearchConfig {
  baseUrl: string;
  apiKey: string;
  /** Backward-compatible name for the renewable transport inactivity interval. */
  timeoutMs: number;
}

export interface WebSearchResult {
  title: string;
  url: string;
  content: string;
}

export interface WebSearchResponse {
  results: WebSearchResult[];
}

export interface WebFetchResponse {
  title: string;
  content: string;
  links: string[];
}

export type SearchErrorKind =
  | "api_key_missing"
  | "client_error"
  | "server_error"
  | "network_error"
  | "aborted";

export type SearchOperation = "web_search" | "web_fetch";
export type SearchFailureReason =
  | "configuration"
  | "authentication"
  | "fetch_response"
  | "provider_response"
  | "network"
  | "timeout"
  | "cancelled";

export interface SearchApiErrorContext {
  readonly operation: SearchOperation;
  readonly reason: SearchFailureReason;
  readonly status?: number;
  readonly targetUrl?: string;
}

export class SearchApiError extends Error {
  readonly kind: SearchErrorKind;
  readonly operation: SearchOperation;
  readonly reason: SearchFailureReason;
  readonly status?: number;
  readonly targetUrl?: string;

  constructor(message: string, kind: SearchErrorKind, context: SearchApiErrorContext) {
    super(message);
    this.name = "SearchApiError";
    this.kind = kind;
    this.operation = context.operation;
    this.reason = context.reason;
    this.status = context.status;
    this.targetUrl = context.targetUrl;
  }
}

export type GithubApiFallbackKind =
  | "repository"
  | "issues"
  | "issue"
  | "pull_requests"
  | "pull_request"
  | "commits"
  | "commit"
  | "releases"
  | "release"
  | "contents";

export interface GithubApiFallback {
  readonly kind: GithubApiFallbackKind;
  readonly url: string;
  readonly expectedContent?: "file" | "directory";
}

export type GithubApiFallbackPageResult =
  | { readonly success: true; readonly page: WebFetchResponse }
  | { readonly success: false; readonly reason: string };

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

// ── Config ───────────────────────────────────────────────

export function resolveConfig(env: Record<string, string | undefined>): SearchConfig {
  const baseUrl = (env.OLLAMA_WEB_SEARCH_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const apiKey = env.OLLAMA_API_KEY?.trim() || "";
  const parsedTimeout = Number(env.OLLAMA_WEB_SEARCH_TIMEOUT_MS);
  const timeoutMs =
    Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : DEFAULT_TIMEOUT_MS;
  return { baseUrl, apiKey, timeoutMs };
}

// ── Helpers ──────────────────────────────────────────────

export function clampMaxResults(requested?: number): number {
  if (requested === undefined || Number.isNaN(requested)) return DEFAULT_MAX_RESULTS;
  return Math.min(MAX_RESULTS_LIMIT, Math.max(1, Math.floor(requested)));
}

export function truncateContent(
  text: string,
  maxChars: number
): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(0, maxChars), truncated: true };
}

/** Returns an error message for invalid URLs, or null if the URL is a valid http(s) URL. */
export function validateHttpUrl(raw: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return `Invalid URL: ${raw}`;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return `Unsupported URL scheme '${parsed.protocol}' — only http and https are supported`;
  }
  if (parsed.username || parsed.password) {
    return "URLs containing embedded credentials are not supported";
  }
  return null;
}

const GITHUB_NON_REPOSITORY_PREFIXES = new Set([
  "about",
  "collections",
  "enterprise",
  "events",
  "explore",
  "features",
  "login",
  "marketplace",
  "new",
  "notifications",
  "orgs",
  "search",
  "security",
  "settings",
  "site",
  "sponsors",
  "topics",
  "users",
]);
const MAX_GITHUB_API_RESPONSE_CHARS = 1_500_000;

function decodedPathSegment(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value);
    if (!decoded || decoded.includes("/") || decoded.includes("\\") || decoded.includes("\0")) {
      return null;
    }
    return decoded;
  } catch {
    return null;
  }
}

function encodedPathSegments(values: readonly string[]): string | null {
  const encoded: string[] = [];
  for (const value of values) {
    const decoded = decodedPathSegment(value);
    if (decoded === null) return null;
    encoded.push(encodeURIComponent(decoded));
  }
  return encoded.join("/");
}

/**
 * Returns a deterministic public GitHub REST equivalent for common HTML pages.
 * Unsupported or ambiguous GitHub routes deliberately fall through to browser guidance.
 */
export function githubApiFallbackForUrl(raw: string): GithubApiFallback | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  const hostname = parsed.hostname.toLowerCase();
  const isGithubHtml = hostname === "github.com" || hostname === "www.github.com";
  const isGithubRaw = hostname === "raw.githubusercontent.com";
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    (!isGithubHtml && !isGithubRaw) ||
    parsed.port ||
    parsed.username ||
    parsed.password
  ) {
    return null;
  }

  const segments = parsed.pathname.split("/").filter((segment) => segment.length > 0);
  if (segments.length < 2) return null;
  const owner = decodedPathSegment(segments[0] ?? "");
  const repository = decodedPathSegment(segments[1] ?? "");
  if (
    owner === null ||
    repository === null ||
    GITHUB_NON_REPOSITORY_PREFIXES.has(owner.toLowerCase())
  ) {
    return null;
  }
  const base = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`;
  if (isGithubRaw) {
    const ref = decodedPathSegment(segments[2] ?? "");
    const contentPath = encodedPathSegments(segments.slice(3));
    if (ref === null || !/^[0-9a-f]{40}$/iu.test(ref) || !contentPath) return null;
    return {
      kind: "contents",
      url: `${base}/contents/${contentPath}?ref=${encodeURIComponent(ref)}`,
      expectedContent: "file",
    };
  }
  if (segments.length === 2) return { kind: "repository", url: base };

  const section = segments[2];
  const identifier = segments[3];
  if (segments.length === 3 && section === "issues") {
    return { kind: "issues", url: `${base}/issues` };
  }
  if (segments.length === 3 && section === "pulls") {
    return { kind: "pull_requests", url: `${base}/pulls` };
  }
  if (segments.length === 3 && section === "commits") {
    return { kind: "commits", url: `${base}/commits` };
  }
  if (segments.length === 3 && section === "releases") {
    return { kind: "releases", url: `${base}/releases` };
  }
  if (segments.length === 4 && section === "issues" && /^\d+$/u.test(identifier ?? "")) {
    return { kind: "issue", url: `${base}/issues/${identifier}` };
  }
  if (segments.length === 4 && section === "pull" && /^\d+$/u.test(identifier ?? "")) {
    return { kind: "pull_request", url: `${base}/pulls/${identifier}` };
  }
  if (segments.length === 4 && section === "commit") {
    const commit = decodedPathSegment(identifier ?? "");
    if (commit !== null) {
      return { kind: "commit", url: `${base}/commits/${encodeURIComponent(commit)}` };
    }
  }
  if (segments.length === 4 && section === "releases" && identifier === "latest") {
    return { kind: "release", url: `${base}/releases/latest` };
  }
  if (section === "releases" && identifier === "tag" && segments.length >= 5) {
    const tagSegments = segments.slice(4).map((segment) => decodedPathSegment(segment));
    if (tagSegments.every((segment) => segment !== null)) {
      const tag = tagSegments.join("/");
      return { kind: "release", url: `${base}/releases/tags/${encodeURIComponent(tag)}` };
    }
  }
  if ((section === "blob" || section === "tree") && segments.length >= 4) {
    const ref = decodedPathSegment(identifier ?? "");
    const contentPath = encodedPathSegments(segments.slice(4));
    if (
      ref !== null &&
      /^[0-9a-f]{40}$/iu.test(ref) &&
      contentPath !== null &&
      (section === "tree" || contentPath)
    ) {
      const suffix = contentPath ? `/contents/${contentPath}` : "/contents";
      return {
        kind: "contents",
        url: `${base}${suffix}?ref=${encodeURIComponent(ref)}`,
        expectedContent: section === "tree" ? "directory" : "file",
      };
    }
  }
  return null;
}

function githubDirectoryEntry(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.type === "string" &&
    typeof value.name === "string" &&
    typeof value.path === "string"
  );
}

function githubRepository(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === "number" &&
    typeof value.full_name === "string" &&
    typeof value.html_url === "string"
  );
}

function githubIssueOrPullRequest(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.number === "number" &&
    typeof value.title === "string" &&
    typeof value.html_url === "string"
  );
}

function githubCommit(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.sha === "string" &&
    isRecord(value.commit) &&
    typeof value.html_url === "string"
  );
}

function githubRelease(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === "number" &&
    typeof value.tag_name === "string" &&
    typeof value.html_url === "string"
  );
}

function validGithubApiResponse(value: unknown, kind: GithubApiFallbackKind): boolean {
  switch (kind) {
    case "repository":
      return githubRepository(value);
    case "issues":
    case "pull_requests":
      return Array.isArray(value) && value.every(githubIssueOrPullRequest);
    case "issue":
    case "pull_request":
      return githubIssueOrPullRequest(value);
    case "commits":
      return Array.isArray(value) && value.every(githubCommit);
    case "commit":
      return githubCommit(value);
    case "releases":
      return Array.isArray(value) && value.every(githubRelease);
    case "release":
      return githubRelease(value);
    case "contents":
      return false;
  }
}

/** Validate and, for files, decode a GitHub API fallback response. */
export function normalizeGithubApiFallbackPage(
  page: WebFetchResponse,
  fallback: GithubApiFallback
): GithubApiFallbackPageResult {
  if (page.content.length > MAX_GITHUB_API_RESPONSE_CHARS) {
    return { success: false, reason: "the GitHub API response exceeded the validation limit" };
  }

  let value: unknown;
  try {
    value = JSON.parse(page.content);
  } catch {
    const resource = fallback.kind === "contents" ? "GitHub Contents API" : "GitHub API";
    return { success: false, reason: `the ${resource} response was not valid JSON` };
  }
  if (fallback.kind !== "contents") {
    return validGithubApiResponse(value, fallback.kind)
      ? { success: true, page }
      : {
          success: false,
          reason: `the GitHub API response did not match the expected ${fallback.kind} schema`,
        };
  }
  if (fallback.expectedContent === "directory") {
    return Array.isArray(value) && value.every(githubDirectoryEntry)
      ? { success: true, page }
      : { success: false, reason: "the GitHub Contents API response was not a directory listing" };
  }
  if (
    !isRecord(value) ||
    value.type !== "file" ||
    value.encoding !== "base64" ||
    typeof value.content !== "string"
  ) {
    return {
      success: false,
      reason: "the GitHub Contents API response was not a base64-encoded file",
    };
  }
  if (value.content.length > MAX_GITHUB_API_RESPONSE_CHARS) {
    return { success: false, reason: "the GitHub Contents API response exceeded the decode limit" };
  }
  const encoded = value.content.replace(/\s+/gu, "");
  if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(encoded)) {
    return { success: false, reason: "the GitHub Contents API response used invalid base64" };
  }

  let bytes: Buffer;
  let content: string;
  try {
    bytes = Buffer.from(encoded, "base64");
    if (bytes.toString("base64") !== encoded) {
      return {
        success: false,
        reason: "the GitHub Contents API response used noncanonical base64",
      };
    }
    content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { success: false, reason: "the GitHub Contents API response was not valid UTF-8" };
  }
  if (content.includes("\0")) {
    return { success: false, reason: "the GitHub Contents API response was not readable text" };
  }

  const downloadUrl = typeof value.download_url === "string" ? value.download_url : undefined;
  const links =
    downloadUrl !== undefined && validateHttpUrl(downloadUrl) === null
      ? [...new Set([...page.links, downloadUrl])]
      : page.links;
  return {
    success: true,
    page: {
      title: typeof value.name === "string" ? value.name : page.title,
      content,
      links,
    },
  };
}

// ── HTTP ─────────────────────────────────────────────────

interface RenewableInactivitySignal {
  readonly signal: AbortSignal;
  readonly expired: () => boolean;
  readonly renew: () => void;
  readonly dispose: () => void;
}

function renewableInactivitySignal(
  inactivityMs: number,
  callerSignal?: AbortSignal
): RenewableInactivitySignal {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inactivityExpired = false;
  const forwardAbort = (): void => controller.abort(callerSignal?.reason);
  const renew = (): void => {
    if (controller.signal.aborted) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      inactivityExpired = true;
      controller.abort(new Error("search transport inactivity lease expired"));
    }, inactivityMs);
    timer.unref?.();
  };
  if (callerSignal?.aborted) forwardAbort();
  else callerSignal?.addEventListener("abort", forwardAbort, { once: true });
  renew();
  return {
    signal: controller.signal,
    expired: () => inactivityExpired,
    renew,
    dispose: () => {
      if (timer !== undefined) clearTimeout(timer);
      callerSignal?.removeEventListener("abort", forwardAbort);
    },
  };
}

interface JsonResponse {
  readonly value: unknown;
  readonly status: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface ApiRequestContext {
  readonly operation: SearchOperation;
  readonly path: string;
  readonly targetUrl?: string;
}

function operationLabel(operation: SearchOperation): string {
  return operation === "web_fetch" ? "Ollama Web Fetch" : "Ollama Web Search";
}

function transportAbortError(
  request: ApiRequestContext,
  inactivityMs: number,
  cancelled: boolean
): SearchApiError {
  const message = cancelled
    ? request.operation === "web_fetch"
      ? "Unable to fetch the requested URL because the caller cancelled Ollama Web Fetch"
      : "Ollama Web Search was cancelled by the caller"
    : request.operation === "web_fetch"
      ? `Unable to fetch the requested URL because Ollama Web Fetch was inactive for ${inactivityMs}ms`
      : `Ollama Web Search was inactive for ${inactivityMs}ms`;
  return new SearchApiError(message, "aborted", {
    operation: request.operation,
    reason: cancelled ? "cancelled" : "timeout",
    targetUrl: request.targetUrl,
  });
}

function malformedResponse(
  request: ApiRequestContext,
  status: number,
  detail: string
): SearchApiError {
  const message =
    request.operation === "web_fetch"
      ? `Unable to fetch the requested URL because Ollama Web Fetch returned a malformed response: ${detail}`
      : `${operationLabel(request.operation)} returned a malformed response: ${detail}`;
  return new SearchApiError(message, "server_error", {
    operation: request.operation,
    reason: "provider_response",
    status,
    targetUrl: request.targetUrl,
  });
}

function isWebSearchResult(value: unknown): value is WebSearchResult {
  return (
    isRecord(value) &&
    typeof value.title === "string" &&
    typeof value.url === "string" &&
    typeof value.content === "string"
  );
}

function parseWebSearchResponse(response: JsonResponse, maxResults: number): WebSearchResponse {
  const request: ApiRequestContext = { operation: "web_search", path: "/api/web_search" };
  if (!isRecord(response.value)) {
    throw malformedResponse(request, response.status, "expected a JSON object");
  }
  const value = response.value.results;
  if (value === undefined || !Array.isArray(value)) return { results: [] };
  if (value.length > maxResults) {
    throw malformedResponse(
      request,
      response.status,
      `received ${value.length} results for a maximum of ${maxResults}`
    );
  }

  const results: WebSearchResult[] = [];
  for (const [index, result] of value.entries()) {
    if (!isWebSearchResult(result)) {
      throw malformedResponse(
        request,
        response.status,
        `results[${index}] must contain string title, url, and content fields`
      );
    }
    results.push(result);
  }
  return { results };
}

function stringArrayOrDefault(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const strings: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return [];
    strings.push(item);
  }
  return strings;
}

function parseWebFetchResponse(response: JsonResponse, targetUrl: string): WebFetchResponse {
  const request: ApiRequestContext = {
    operation: "web_fetch",
    path: "/api/web_fetch",
    targetUrl,
  };
  if (!isRecord(response.value)) {
    throw malformedResponse(request, response.status, "expected a JSON object");
  }
  return {
    title: typeof response.value.title === "string" ? response.value.title : "",
    content: typeof response.value.content === "string" ? response.value.content : "",
    links: stringArrayOrDefault(response.value.links),
  };
}

function assertBoundedJsonComplexity(
  value: unknown,
  request: ApiRequestContext,
  status: number
): void {
  const pending: Array<{ readonly value: unknown; readonly depth: number }> = [{ value, depth: 0 }];
  let visited = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    visited += 1;
    if (visited > MAX_PROVIDER_JSON_VALUES) {
      throw malformedResponse(request, status, "response JSON contains too many values");
    }
    if (current.depth > MAX_PROVIDER_JSON_DEPTH) {
      throw malformedResponse(request, status, "response JSON is nested too deeply");
    }
    const children = Array.isArray(current.value)
      ? current.value
      : isRecord(current.value)
        ? Object.values(current.value)
        : [];
    if (visited + pending.length + children.length > MAX_PROVIDER_JSON_VALUES) {
      throw malformedResponse(request, status, "response JSON contains too many values");
    }
    for (const child of children) {
      pending.push({ value: child, depth: current.depth + 1 });
    }
  }
}

async function readBoundedResponseJson(
  response: Response,
  request: ApiRequestContext,
  reportActivity: () => void
): Promise<unknown> {
  const contentLength = response.headers.get("content-length")?.trim();
  if (contentLength !== undefined && /^\d+$/u.test(contentLength)) {
    const declared = Number(contentLength);
    if (!Number.isSafeInteger(declared) || declared > MAX_PROVIDER_RESPONSE_BYTES) {
      throw malformedResponse(
        request,
        response.status,
        `response exceeds ${MAX_PROVIDER_RESPONSE_BYTES} bytes`
      );
    }
  }
  if (response.body === null) {
    throw malformedResponse(request, response.status, "response body is absent");
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      reportActivity();
      total += part.value.byteLength;
      if (total > MAX_PROVIDER_RESPONSE_BYTES) {
        await reader.cancel();
        throw malformedResponse(
          request,
          response.status,
          `response exceeds ${MAX_PROVIDER_RESPONSE_BYTES} bytes`
        );
      }
      chunks.push(Buffer.from(part.value));
    }
  } finally {
    reader.releaseLock();
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, total));
  const value: unknown = JSON.parse(text);
  assertBoundedJsonComplexity(value, request, response.status);
  return value;
}

async function postJson(
  config: SearchConfig,
  request: ApiRequestContext,
  body: Record<string, unknown>,
  signal: AbortSignal | undefined,
  fetchImpl: FetchLike
): Promise<JsonResponse> {
  if (!config.apiKey) {
    const guidance =
      "OLLAMA_API_KEY is not set. Web search and web fetch use Ollama's cloud API — " +
      "create a key at https://ollama.com/settings/keys and add OLLAMA_API_KEY to .env";
    const message =
      request.operation === "web_fetch"
        ? `Unable to fetch the requested URL because ${guidance}`
        : guidance;
    throw new SearchApiError(message, "api_key_missing", {
      operation: request.operation,
      reason: "configuration",
      targetUrl: request.targetUrl,
    });
  }

  const inactivity = renewableInactivitySignal(config.timeoutMs, signal);
  try {
    let response: Response;
    try {
      response = await fetchImpl(`${config.baseUrl}${request.path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: inactivity.signal,
      });
      inactivity.renew();
    } catch (e: unknown) {
      const name = e instanceof Error ? e.name : "";
      if (
        signal?.aborted === true ||
        inactivity.expired() ||
        name === "AbortError" ||
        name === "TimeoutError"
      ) {
        throw transportAbortError(request, config.timeoutMs, signal?.aborted === true);
      }
      const message = e instanceof Error && e.message ? e.message : String(e);
      const diagnostic =
        request.operation === "web_fetch"
          ? `Unable to fetch the requested URL because Ollama Web Fetch could not be reached: ${message}`
          : `Network error calling Ollama Web Search: ${message}`;
      throw new SearchApiError(diagnostic, "network_error", {
        operation: request.operation,
        reason: "network",
        targetUrl: request.targetUrl,
      });
    }

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        const guidance = `Authentication failed (HTTP ${response.status}) — check that OLLAMA_API_KEY is valid.`;
        const message =
          request.operation === "web_fetch"
            ? `Unable to fetch the requested URL because ${guidance}`
            : guidance;
        throw new SearchApiError(message, "client_error", {
          operation: request.operation,
          reason: "authentication",
          status: response.status,
          targetUrl: request.targetUrl,
        });
      }
      const message =
        request.operation === "web_fetch"
          ? `Unable to fetch the requested URL through Ollama Web Fetch (provider HTTP ${response.status}). The provider status does not establish that the destination URL itself returned HTTP ${response.status}; the destination may be unavailable, blocked, or unsupported by the fetch service.`
          : `Ollama Web Search request failed (HTTP ${response.status}).`;
      throw new SearchApiError(message, response.status >= 500 ? "server_error" : "client_error", {
        operation: request.operation,
        reason: response.status >= 500 ? "provider_response" : "fetch_response",
        status: response.status,
        targetUrl: request.targetUrl,
      });
    }

    try {
      const value = await readBoundedResponseJson(response, request, inactivity.renew);
      return { value, status: response.status };
    } catch (error) {
      if (error instanceof SearchApiError) throw error;
      if (signal?.aborted === true || inactivity.expired()) {
        throw transportAbortError(request, config.timeoutMs, signal?.aborted === true);
      }
      const message =
        request.operation === "web_fetch"
          ? "Unable to fetch the requested URL because Ollama Web Fetch returned invalid JSON"
          : `${operationLabel(request.operation)} returned invalid JSON`;
      throw new SearchApiError(message, "server_error", {
        operation: request.operation,
        reason: "provider_response",
        status: response.status,
        targetUrl: request.targetUrl,
      });
    }
  } finally {
    inactivity.dispose();
  }
}

// ── API operations ───────────────────────────────────────

export async function webSearch(
  query: string,
  maxResults: number,
  config: SearchConfig,
  signal?: AbortSignal,
  fetchImpl: FetchLike = fetch
): Promise<WebSearchResponse> {
  const response = await postJson(
    config,
    { operation: "web_search", path: "/api/web_search" },
    { query, max_results: maxResults },
    signal,
    fetchImpl
  );
  return parseWebSearchResponse(response, maxResults);
}

export async function webFetch(
  url: string,
  config: SearchConfig,
  signal?: AbortSignal,
  fetchImpl: FetchLike = fetch
): Promise<WebFetchResponse> {
  const response = await postJson(
    config,
    { operation: "web_fetch", path: "/api/web_fetch", targetUrl: url },
    { url },
    signal,
    fetchImpl
  );
  return parseWebFetchResponse(response, url);
}
