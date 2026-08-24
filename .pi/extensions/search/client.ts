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

// ── Types ────────────────────────────────────────────────

export interface SearchConfig {
  baseUrl: string;
  apiKey: string;
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

export class SearchApiError extends Error {
  readonly kind: SearchErrorKind;
  readonly status?: number;

  constructor(message: string, kind: SearchErrorKind, status?: number) {
    super(message);
    this.name = "SearchApiError";
    this.kind = kind;
    this.status = status;
  }
}

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
  return null;
}

// ── HTTP ─────────────────────────────────────────────────

function combineSignals(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

interface JsonResponse {
  readonly value: unknown;
  readonly status: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function malformedResponse(path: string, status: number, detail: string): SearchApiError {
  return new SearchApiError(
    `Ollama API ${path} returned a malformed response: ${detail}`,
    "server_error",
    status
  );
}

function isWebSearchResult(value: unknown): value is WebSearchResult {
  return (
    isRecord(value) &&
    typeof value.title === "string" &&
    typeof value.url === "string" &&
    typeof value.content === "string"
  );
}

function parseWebSearchResponse(response: JsonResponse): WebSearchResponse {
  if (!isRecord(response.value)) {
    throw malformedResponse("/api/web_search", response.status, "expected a JSON object");
  }
  const value = response.value.results;
  if (value === undefined || !Array.isArray(value)) return { results: [] };

  const results: WebSearchResult[] = [];
  for (const [index, result] of value.entries()) {
    if (!isWebSearchResult(result)) {
      throw malformedResponse(
        "/api/web_search",
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

function parseWebFetchResponse(response: JsonResponse): WebFetchResponse {
  if (!isRecord(response.value)) {
    throw malformedResponse("/api/web_fetch", response.status, "expected a JSON object");
  }
  return {
    title: typeof response.value.title === "string" ? response.value.title : "",
    content: typeof response.value.content === "string" ? response.value.content : "",
    links: stringArrayOrDefault(response.value.links),
  };
}

async function postJson(
  config: SearchConfig,
  path: string,
  body: Record<string, unknown>,
  signal: AbortSignal | undefined,
  fetchImpl: FetchLike
): Promise<JsonResponse> {
  if (!config.apiKey) {
    throw new SearchApiError(
      "OLLAMA_API_KEY is not set. Web search and web fetch use Ollama's cloud API — " +
        "create a key at https://ollama.com/settings/keys and add OLLAMA_API_KEY to .env",
      "api_key_missing"
    );
  }

  let response: Response;
  try {
    response = await fetchImpl(`${config.baseUrl}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: combineSignals(config.timeoutMs, signal),
    });
  } catch (e: unknown) {
    const name = e instanceof Error ? e.name : "";
    if (name === "AbortError" || name === "TimeoutError") {
      throw new SearchApiError(
        `Request to ${path} aborted or timed out after ${config.timeoutMs}ms`,
        "aborted"
      );
    }
    const message = e instanceof Error && e.message ? e.message : String(e);
    throw new SearchApiError(
      `Network error calling ${config.baseUrl}${path}: ${message}`,
      "network_error"
    );
  }

  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 500);
    if (response.status === 401 || response.status === 403) {
      throw new SearchApiError(
        `Authentication failed (HTTP ${response.status}) — check that OLLAMA_API_KEY is valid. ${detail}`,
        "client_error",
        response.status
      );
    }
    throw new SearchApiError(
      `Ollama API ${path} returned HTTP ${response.status}: ${detail}`,
      response.status >= 500 ? "server_error" : "client_error",
      response.status
    );
  }

  try {
    const value: unknown = await response.json();
    return { value, status: response.status };
  } catch {
    throw new SearchApiError(
      `Ollama API ${path} returned invalid JSON`,
      "server_error",
      response.status
    );
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
    "/api/web_search",
    { query, max_results: maxResults },
    signal,
    fetchImpl
  );
  return parseWebSearchResponse(response);
}

export async function webFetch(
  url: string,
  config: SearchConfig,
  signal?: AbortSignal,
  fetchImpl: FetchLike = fetch
): Promise<WebFetchResponse> {
  const response = await postJson(config, "/api/web_fetch", { url }, signal, fetchImpl);
  return parseWebFetchResponse(response);
}
