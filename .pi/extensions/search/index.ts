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

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { type Static, Type } from "@sinclair/typebox";
import { createLogger, setSessionId, type ErrorCode } from "../../lib/logger/logger.js";
import {
  clampMaxResults,
  MAX_FETCH_CONTENT_CHARS,
  MAX_RESULTS_LIMIT,
  resolveConfig,
  SearchApiError,
  truncateContent,
  validateHttpUrl,
  webFetch,
  webSearch,
  type SearchErrorKind,
} from "./client.js";

const logger = createLogger("search");

const WebSearchParams = Type.Object({
  query: Type.String({ description: "The search query" }),
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

interface SessionContext {
  sessionManager: { getSessionId(): string };
}

const ERROR_CODES: Record<SearchErrorKind, ErrorCode> = {
  api_key_missing: "SEARCH_API_KEY_MISSING",
  client_error: "SEARCH_CLIENT_ERROR",
  server_error: "SEARCH_SERVER_ERROR",
  network_error: "SEARCH_NETWORK_ERROR",
  aborted: "SEARCH_ABORTED",
};

function textResult(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    details: undefined,
  };
}

function errorResult(tool: string, e: unknown) {
  const err = e instanceof Error ? e : new Error(String(e));
  const kind = e instanceof SearchApiError ? e.kind : ("network_error" as SearchErrorKind);
  logger.error(`${tool} failed`, { kind }, Object.assign(err, { code: ERROR_CODES[kind] }));
  return textResult({ success: false, error: err.message });
}

export default function searchExtension(pi: ExtensionAPI): void {
  pi.on("session_start", async (_event: unknown, ctx: SessionContext) => {
    setSessionId(ctx.sessionManager.getSessionId());
  });

  // ── Tool 1: web_search ──
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description: [
      "Search the web for a query using Ollama's Web Search API.",
      "Returns up to 10 results, each with title, url, and content (page excerpt).",
      "Use for discovering current information, documentation, or sources beyond local files.",
      "Follow up with web_fetch to read a specific result's full page.",
      "Example: web_search({query: 'ollama web search api', max_results: 5})",
    ].join(" "),
    promptSnippet: "web_search with { query, max_results }",
    promptGuidelines: [
      "Use web_search for current events, external documentation, or anything not in the local project or memory.",
      "Prefer specific queries over broad ones; refine and re-search rather than requesting more results.",
      "Cite result URLs when using searched information in output.",
    ],
    parameters: WebSearchParams,
    execute: async (
      _toolCallId: string,
      params: Static<typeof WebSearchParams>,
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      _ctx: unknown
    ) => {
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
        return textResult({ success: true, query: params.query, results });
      } catch (e) {
        return errorResult("web_search", e);
      }
    },
  });

  // ── Tool 2: web_fetch ──
  pi.registerTool({
    name: "web_fetch",
    label: "Web Fetch",
    description: [
      "Fetch a single web page by URL using Ollama's Web Fetch API.",
      "Returns the page title, extracted text content, and links found on the page.",
      "Use to read the full content of a page discovered via web_search or a known URL.",
      "Example: web_fetch({url: 'https://docs.ollama.com/capabilities/web-search'})",
    ].join(" "),
    promptSnippet: "web_fetch with { url }",
    promptGuidelines: [
      "Use web_fetch to read full page content after web_search identifies relevant URLs.",
      "Only http and https URLs are supported; content is truncated beyond " +
        `${MAX_FETCH_CONTENT_CHARS} characters.`,
    ],
    parameters: WebFetchParams,
    execute: async (
      _toolCallId: string,
      params: Static<typeof WebFetchParams>,
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      _ctx: unknown
    ) => {
      const urlError = validateHttpUrl(params.url);
      if (urlError) {
        return textResult({ success: false, error: urlError });
      }
      const config = resolveConfig(process.env);
      try {
        const page = await webFetch(params.url, config, signal);
        const { text, truncated } = truncateContent(page.content, MAX_FETCH_CONTENT_CHARS);
        logger.info("web_fetch succeeded", {
          url: params.url,
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
      } catch (e) {
        return errorResult("web_fetch", e);
      }
    },
  });
}
