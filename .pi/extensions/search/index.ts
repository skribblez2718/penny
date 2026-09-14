import { registerTool } from "../../lib/pi-tool-registration.js";
/**
 * Search Extension — web search and web fetch via Ollama's Web Search API
 *
 * Two tools:
 *   - web_search: search the web for a query, returns titles, URLs, and content snippets
 *   - web_fetch: fetch a single web page, returns its title, content, and links
 *
 * Both call Ollama's cloud API (https://ollama.com/api/web_search and
 * /api/web_fetch) authenticated with OLLAMA_API_KEY.
 * Docs: https://docs.ollama.com/capabilities/web-search
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  opendirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger, setSessionId, type ErrorCode } from "../../lib/logger/logger.js";
import {
  DEFAULT_TOOL_RESULT_BUDGET,
  ToolResultBudgetConfigError,
  fitUtf8ToolResult,
  fitsToolResultBudget,
  measureToolResult,
  resolveToolResultBudget,
  type TextToolResult,
  type ToolResultBudget,
} from "../lib/tool-result-budget.js";
import {
  clampMaxResults,
  githubApiFallbackForUrl,
  MAX_FETCH_CONTENT_CHARS,
  MAX_PROVIDER_RESPONSE_BYTES,
  MAX_RESULTS_LIMIT,
  normalizeGithubApiFallbackPage,
  resolveConfig,
  SearchApiError,
  truncateContent,
  validateHttpUrl,
  webFetch,
  webSearch,
  type GithubApiFallback,
  type SearchErrorKind,
  type WebSearchResult,
} from "./client.js";

const logger = createLogger("search");

export const WEB_SEARCH_MAX_OUTPUT_LINES = 2_000;
export const WEB_SEARCH_MAX_SPILLS_PER_SESSION = 4;
export const WEB_SEARCH_MAX_SPILL_BYTES = MAX_PROVIDER_RESPONSE_BYTES + 64 * 1024;
export const WEB_SEARCH_STALE_SPILL_AGE_MS = 24 * 60 * 60 * 1_000;
export const WEB_SEARCH_STALE_VISIT_LIMIT = 1_024;
export const WEB_SEARCH_STALE_REMOVAL_LIMIT = 256;
const WEB_SEARCH_SPILL_ROOT_NAME = "penny-web-search-spills";
const WEB_SEARCH_SPILL_PREFIX = "spill-";

export function truncateWebSearchLines(
  text: string,
  maxLines: number
): { content: string; truncated: boolean } {
  const lines = text.split("\n");
  return lines.length > maxLines
    ? { content: lines.slice(0, maxLines).join("\n"), truncated: true }
    : { content: text, truncated: false };
}

function formatOutputSize(bytes: number): string {
  return bytes < 1024 ? `${bytes}B` : `${(bytes / 1024).toFixed(1)}KB`;
}

const WebSearchParams = Type.Object({
  query: Type.String({ description: "The search query", minLength: 1, maxLength: 16_384 }),
  max_results: Type.Optional(
    Type.Integer({
      description: `Maximum number of results to return (1-${MAX_RESULTS_LIMIT}, default 5)`,
      minimum: 1,
      maximum: MAX_RESULTS_LIMIT,
    })
  ),
});

const WebFetchParams = Type.Object({
  url: Type.String({ description: "The http(s) URL of the page to fetch" }),
});

export interface SearchToolFailure {
  readonly success: false;
  readonly error: string;
}

export interface WebSearchToolSuccess {
  readonly success: true;
  readonly query: string;
  readonly results: WebSearchResult[];
}

export interface GithubFallbackSuccess {
  readonly strategy: "github_api";
  readonly kind: GithubApiFallback["kind"];
  readonly fetched_url: string;
  readonly reason: string;
}

export interface WebFetchToolSuccess {
  readonly success: true;
  readonly url: string;
  readonly title: string;
  readonly content: string;
  readonly truncated: boolean;
  readonly links: string[];
  readonly fallback?: GithubFallbackSuccess;
}

export type FetchFailureScope =
  | "validation"
  | "configuration"
  | "authentication"
  | "target_fetch"
  | "provider"
  | "cancelled"
  | "url_fetch";

export interface PlaywrightRetry {
  readonly tool: "playwright_navigate";
  readonly arguments: { readonly url: string };
  readonly available: boolean;
  readonly reason: string;
}

export interface WebFetchToolFailure extends SearchToolFailure {
  readonly url: string;
  readonly failure_scope: FetchFailureScope;
  readonly provider_status?: number;
  readonly primary_provider_status?: number;
  readonly diagnostic?: string;
  readonly github_api_fallback?: GithubFallbackFailure;
  readonly retry_with?: PlaywrightRetry;
}

export type SearchToolResult =
  | SearchToolFailure
  | WebSearchToolSuccess
  | WebFetchToolSuccess
  | WebFetchToolFailure;

const ERROR_CODES: Record<SearchErrorKind, ErrorCode> = {
  api_key_missing: "SEARCH_API_KEY_MISSING",
  client_error: "SEARCH_CLIENT_ERROR",
  server_error: "SEARCH_SERVER_ERROR",
  network_error: "SEARCH_NETWORK_ERROR",
  aborted: "SEARCH_ABORTED",
};

function textResult(payload: SearchToolResult) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    details: undefined,
  };
}

function searchResultBudget(): ToolResultBudget {
  try {
    return resolveToolResultBudget(process.env);
  } catch (error) {
    if (error instanceof ToolResultBudgetConfigError) {
      logger.warn("Invalid search result budget; enforcing shared hard defaults", {
        error: error.message,
      });
      return DEFAULT_TOOL_RESULT_BUDGET;
    }
    throw error;
  }
}

function removeSpillDirectory(directory: string): void {
  rmSync(directory, { recursive: true, force: true });
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function searchSpillRoot(create: boolean): string | undefined {
  const root = join(tmpdir(), WEB_SEARCH_SPILL_ROOT_NAME);
  if (create) {
    try {
      mkdirSync(root, { mode: 0o700 });
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
  } else {
    try {
      lstatSync(root);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return undefined;
      throw error;
    }
  }
  const stat = lstatSync(root);
  const uid = typeof process.geteuid === "function" ? process.geteuid() : undefined;
  if (
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    (uid !== undefined && stat.uid !== uid) ||
    (stat.mode & 0o077) !== 0
  ) {
    throw new Error("web-search spill root has unsafe custody");
  }
  return root;
}

function createSearchSpill(payload: WebSearchToolSuccess, spillDirectories: string[]): string {
  const pretty = JSON.stringify(payload, null, 2);
  const serialized =
    Buffer.byteLength(pretty, "utf8") <= WEB_SEARCH_MAX_SPILL_BYTES
      ? pretty
      : JSON.stringify(payload);
  if (Buffer.byteLength(serialized, "utf8") > WEB_SEARCH_MAX_SPILL_BYTES) {
    throw new Error(`complete web-search result exceeds ${WEB_SEARCH_MAX_SPILL_BYTES} spill bytes`);
  }
  while (spillDirectories.length >= WEB_SEARCH_MAX_SPILLS_PER_SESSION) {
    const oldest = spillDirectories.shift();
    if (oldest !== undefined) removeSpillDirectory(oldest);
  }
  const root = searchSpillRoot(true);
  if (root === undefined) throw new Error("web-search spill root is unavailable");
  const directory = mkdtempSync(join(root, WEB_SEARCH_SPILL_PREFIX));
  chmodSync(directory, 0o700);
  const fullResultPath = join(directory, "result.json");
  try {
    writeFileSync(fullResultPath, serialized, { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch (error) {
    removeSpillDirectory(directory);
    throw error;
  }
  spillDirectories.push(directory);
  return fullResultPath;
}

export function cleanupStaleWebSearchSpills(now = Date.now()): void {
  const root = searchSpillRoot(false);
  if (root === undefined) return;
  const uid = typeof process.geteuid === "function" ? process.geteuid() : undefined;
  const directory = opendirSync(root, { bufferSize: 32 });
  let visited = 0;
  let removed = 0;
  try {
    while (visited < WEB_SEARCH_STALE_VISIT_LIMIT && removed < WEB_SEARCH_STALE_REMOVAL_LIMIT) {
      const entry = directory.readSync();
      if (entry === null) break;
      visited += 1;
      if (!entry.name.startsWith(WEB_SEARCH_SPILL_PREFIX)) continue;
      const candidate = join(root, entry.name);
      const stat = lstatSync(candidate);
      if (
        stat.isSymbolicLink() ||
        !stat.isDirectory() ||
        (uid !== undefined && stat.uid !== uid) ||
        (stat.mode & 0o077) !== 0 ||
        now - stat.mtimeMs < WEB_SEARCH_STALE_SPILL_AGE_MS
      ) {
        continue;
      }
      removeSpillDirectory(candidate);
      removed += 1;
    }
  } finally {
    directory.closeSync();
  }
}

function boundedSearchResult(
  payload: WebSearchToolSuccess,
  spillDirectories: string[]
): TextToolResult {
  const serialized = JSON.stringify(payload, null, 2);
  const budget = searchResultBudget();
  const ordinary = textResult(payload);
  const exceedsLineLimit = serialized.split("\n").length > WEB_SEARCH_MAX_OUTPUT_LINES;
  if (!exceedsLineLimit && fitsToolResultBudget(measureToolResult(ordinary), budget)) {
    // Keep ordinary search responses byte-compatible and parseable.
    return ordinary;
  }

  const fullResultPath = createSearchSpill(payload, spillDirectories);
  const notice = [
    "",
    "[web_search output truncated]",
    `Full result: ${fullResultPath}`,
    `Original size: ${formatOutputSize(Buffer.byteLength(serialized, "utf8"))}; visible output is limited by the shared tool-result budget and ${WEB_SEARCH_MAX_OUTPUT_LINES} lines.`,
    "The full-result file lasts for this Pi session. Use read with offset/limit to inspect only the ranges needed.",
  ].join("\n");
  const noticeLines = notice.split("\n").length - 1;
  const lineBounded = truncateWebSearchLines(
    serialized,
    Math.max(1, WEB_SEARCH_MAX_OUTPUT_LINES - noticeLines)
  ).content;
  const source = Buffer.from(lineBounded, "utf8");
  return fitUtf8ToolResult({
    source,
    start: 0,
    end: source.length,
    budget,
    build: (end, text) => {
      const lastLineBreak = text.lastIndexOf("\n");
      const completeLines =
        end === source.length ? text : lastLineBreak < 0 ? "" : text.slice(0, lastLineBreak);
      return {
        content: [{ type: "text", text: `${completeLines}${notice}` }],
      };
    },
  }).result;
}

export interface GithubFallbackFailure {
  readonly kind: GithubApiFallback["kind"];
  readonly url: string;
  readonly error: string;
  readonly provider_status?: number;
}

interface FetchFailureContext {
  readonly requestedUrl: string;
  readonly playwrightAvailable: boolean;
  readonly recommendPlaywright: boolean;
  readonly primaryProviderStatus?: number;
  readonly githubFallback?: GithubFallbackFailure;
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function urlOrigin(raw: string): string {
  try {
    return new URL(raw).origin;
  } catch {
    return "invalid-url";
  }
}

function fetchFailureScope(value: unknown): FetchFailureScope {
  if (!(value instanceof SearchApiError)) return "url_fetch";
  switch (value.reason) {
    case "configuration":
      return "configuration";
    case "authentication":
      return "authentication";
    case "fetch_response":
      return "target_fetch";
    case "cancelled":
      return "cancelled";
    default:
      return "provider";
  }
}

function fetchDiagnostic(value: unknown): string {
  if (value instanceof SearchApiError && value.reason === "cancelled") {
    return "The caller cancelled the fetch, so no automatic fallback is recommended.";
  }
  if (value instanceof SearchApiError && value.status !== undefined) {
    return "The provider status describes Ollama Web Fetch's attempt and is not proof of the destination's own HTTP status.";
  }
  return "Ollama Web Fetch did not return content for the requested URL.";
}

function errorResult(tool: string, e: unknown, fetchContext?: FetchFailureContext) {
  const err = e instanceof Error ? e : new Error(String(e));
  const kind: SearchErrorKind = e instanceof SearchApiError ? e.kind : "network_error";
  const errorForLog = Object.assign(new Error(`${tool} failed with ${kind}`), {
    name: err.name,
  });
  logger.error(
    `${tool} failed`,
    {
      kind,
      failureReason: e instanceof SearchApiError ? e.reason : undefined,
      providerStatus: e instanceof SearchApiError ? e.status : undefined,
      targetOrigin: fetchContext === undefined ? undefined : urlOrigin(fetchContext.requestedUrl),
      primaryProviderStatus: fetchContext?.primaryProviderStatus,
      githubApiFallbackAttempted: fetchContext?.githubFallback !== undefined,
      githubApiFallbackStatus: fetchContext?.githubFallback?.provider_status,
    },
    Object.assign(errorForLog, { code: ERROR_CODES[kind] })
  );
  if (fetchContext === undefined) return textResult({ success: false, error: err.message });

  const failure: WebFetchToolFailure = {
    success: false,
    url: fetchContext.requestedUrl,
    error: err.message,
    failure_scope: fetchFailureScope(e),
    provider_status: e instanceof SearchApiError ? e.status : undefined,
    primary_provider_status: fetchContext.primaryProviderStatus,
    diagnostic: fetchDiagnostic(e),
    github_api_fallback: fetchContext.githubFallback,
  };
  if (!fetchContext.recommendPlaywright) return textResult(failure);

  const playwrightReason = fetchContext.playwrightAvailable
    ? "Browser navigation may succeed when the text-fetch provider blocks or cannot extract the page."
    : "Playwright is not active in this context; retry with a browser-capable agent or enable the Playwright tools.";
  return textResult({
    ...failure,
    retry_with: {
      tool: "playwright_navigate",
      arguments: { url: fetchContext.requestedUrl },
      available: fetchContext.playwrightAvailable,
      reason: playwrightReason,
    },
  });
}

function shouldTryGithubApiFallback(value: unknown): boolean {
  return (
    value instanceof SearchApiError &&
    value.operation === "web_fetch" &&
    value.reason === "fetch_response" &&
    value.status === 404
  );
}

function shouldRecommendPlaywright(value: unknown): boolean {
  return !(
    value instanceof SearchApiError &&
    (value.reason === "cancelled" || (value.reason === "fetch_response" && value.status === 451))
  );
}

function isCancelled(value: unknown): boolean {
  return value instanceof SearchApiError && value.reason === "cancelled";
}

function cancelledWebFetchError(url: string): SearchApiError {
  return new SearchApiError(
    "Unable to fetch the requested URL because the caller cancelled Ollama Web Fetch",
    "aborted",
    { operation: "web_fetch", reason: "cancelled", targetUrl: url }
  );
}

export default function searchExtension(pi: ExtensionAPI): void {
  const spillDirectories: string[] = [];
  let staleCleanupDone = false;
  pi.on("session_start", async (_event, ctx) => {
    setSessionId(ctx.sessionManager.getSessionId());
    if (!staleCleanupDone) {
      staleCleanupDone = true;
      try {
        cleanupStaleWebSearchSpills();
      } catch (error) {
        logger.warn("Stale web-search spill cleanup failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  });
  pi.on("session_shutdown", async () => {
    for (const directory of spillDirectories.splice(0)) {
      try {
        removeSpillDirectory(directory);
      } catch (error) {
        logger.warn("Web-search spill cleanup failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  });

  // ── Tool 1: web_search ──
  registerTool(pi, {
    name: "web_search",
    label: "Web Search",
    description: [
      "Search the web for a query using Ollama's Web Search API.",
      "Returns up to 10 results, each with title, url, and content (page excerpt).",
      "Use for current information, external documentation, or sources beyond local project material and durable memory.",
      "Do not use when the supplied or local material is sufficient.",
      "Prefer specific queries, refine before broadening, cite result URLs, and follow up with web_fetch for a relevant page's full content.",
      "Example: web_search({query: 'ollama web search api', max_results: 5})",
    ].join(" "),
    promptSnippet: "web_search with { query, max_results }",
    parameters: WebSearchParams,
    execute: async (_toolCallId, params, signal) => {
      // Read env at call time — after the environment extension has loaded .env
      const config = resolveConfig(process.env);
      try {
        const { results } = await webSearch(
          params.query,
          clampMaxResults(params.max_results),
          config,
          signal
        );
        logger.info("web_search succeeded", { query: params.query, results: results.length });
        return boundedSearchResult(
          { success: true, query: params.query, results },
          spillDirectories
        );
      } catch (e) {
        return errorResult("web_search", e);
      }
    },
  });

  // ── Tool 2: web_fetch ──
  registerTool(pi, {
    name: "web_fetch",
    label: "Web Fetch",
    description: [
      "Fetch a single HTTP(S) page by URL using Ollama's Web Fetch API.",
      "Returns the page title, extracted text content, and links found on the page.",
      "Common GitHub HTML and raw URLs automatically retry through api.github.com when they can be translated safely.",
      "If fetching still fails, follow the returned playwright_navigate retry when that tool is available.",
      "Use to read a relevant result discovered through web_search or a known URL; do not use it as a broad discovery tool.",
      `Content beyond ${MAX_FETCH_CONTENT_CHARS} characters is truncated.`,
      "Example: web_fetch({url: 'https://docs.ollama.com/capabilities/web-search'})",
    ].join(" "),
    promptSnippet: "web_fetch with { url }",
    parameters: WebFetchParams,
    execute: async (_toolCallId, params, signal) => {
      const urlError = validateHttpUrl(params.url);
      if (urlError) {
        return textResult({
          success: false,
          url: params.url,
          error: `Unable to fetch the requested URL: ${urlError}`,
          failure_scope: "validation",
        });
      }
      const config = resolveConfig(process.env);
      try {
        const page = await webFetch(params.url, config, signal);
        const { text, truncated } = truncateContent(page.content, MAX_FETCH_CONTENT_CHARS);
        logger.info("web_fetch succeeded", {
          targetOrigin: urlOrigin(params.url),
          contentChars: page.content.length,
          truncated,
        });
        return textResult({
          success: true,
          url: params.url,
          title: page.title,
          content: text,
          truncated,
          links: page.links,
        });
      } catch (primaryError) {
        if (signal?.aborted === true && !isCancelled(primaryError)) {
          const cancellation = cancelledWebFetchError(params.url);
          return errorResult("web_fetch", cancellation, {
            requestedUrl: params.url,
            playwrightAvailable: pi.getActiveTools().includes("playwright_navigate"),
            recommendPlaywright: false,
          });
        }
        const githubFallback = githubApiFallbackForUrl(params.url);
        if (githubFallback !== null && shouldTryGithubApiFallback(primaryError)) {
          try {
            const apiPage = await webFetch(githubFallback.url, config, signal);
            if (signal?.aborted === true) {
              const cancellation = cancelledWebFetchError(params.url);
              return errorResult("web_fetch", cancellation, {
                requestedUrl: params.url,
                playwrightAvailable: pi.getActiveTools().includes("playwright_navigate"),
                recommendPlaywright: false,
                primaryProviderStatus:
                  primaryError instanceof SearchApiError ? primaryError.status : undefined,
                githubFallback: {
                  kind: githubFallback.kind,
                  url: githubFallback.url,
                  error: cancellation.message,
                },
              });
            }
            const normalized = normalizeGithubApiFallbackPage(apiPage, githubFallback);
            if (!normalized.success) {
              return errorResult("web_fetch", primaryError, {
                requestedUrl: params.url,
                playwrightAvailable: pi.getActiveTools().includes("playwright_navigate"),
                recommendPlaywright: true,
                primaryProviderStatus:
                  primaryError instanceof SearchApiError ? primaryError.status : undefined,
                githubFallback: {
                  kind: githubFallback.kind,
                  url: githubFallback.url,
                  error: normalized.reason,
                },
              });
            }
            const page = normalized.page;
            const { text, truncated } = truncateContent(page.content, MAX_FETCH_CONTENT_CHARS);
            logger.info("web_fetch succeeded via GitHub API fallback", {
              targetOrigin: urlOrigin(params.url),
              fallbackKind: githubFallback.kind,
              contentChars: page.content.length,
              truncated,
            });
            return textResult({
              success: true,
              url: params.url,
              title: page.title,
              content: text,
              truncated,
              links: page.links,
              fallback: {
                strategy: "github_api",
                kind: githubFallback.kind,
                fetched_url: githubFallback.url,
                reason:
                  "Ollama Web Fetch did not return content for the requested GitHub URL, so a safe public GitHub API equivalent was used.",
              },
            });
          } catch (fallbackError) {
            const finalError =
              signal?.aborted === true
                ? cancelledWebFetchError(params.url)
                : shouldRecommendPlaywright(fallbackError)
                  ? primaryError
                  : fallbackError;
            return errorResult("web_fetch", finalError, {
              requestedUrl: params.url,
              playwrightAvailable: pi.getActiveTools().includes("playwright_navigate"),
              recommendPlaywright: shouldRecommendPlaywright(finalError),
              primaryProviderStatus:
                primaryError instanceof SearchApiError ? primaryError.status : undefined,
              githubFallback: {
                kind: githubFallback.kind,
                url: githubFallback.url,
                error: errorMessage(fallbackError),
                provider_status:
                  fallbackError instanceof SearchApiError ? fallbackError.status : undefined,
              },
            });
          }
        }
        return errorResult("web_fetch", primaryError, {
          requestedUrl: params.url,
          playwrightAvailable: pi.getActiveTools().includes("playwright_navigate"),
          recommendPlaywright: shouldRecommendPlaywright(primaryError),
        });
      }
    },
  });
}
