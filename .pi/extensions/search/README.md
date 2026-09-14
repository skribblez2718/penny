# Search Extension

Web search and web fetch tools for Penny, powered by [Ollama's Web Search API](https://docs.ollama.com/capabilities/web-search).

## Overview

- **Purpose**: Give Penny and her subagents the ability to search the web and read pages without driving a full browser session.
- **Provides**: Two tools — `web_search` and `web_fetch`.
- **Use When**: The task needs current external information, documentation lookup, or reading a known URL. For interactive browsing (forms, JS-heavy pages, screenshots), use the playwright extension instead.

Both tools call Ollama's **cloud** API (`https://ollama.com`), not the local Ollama instance. A free Ollama account and API key are required.

## Tools

### web_search

**Description**: Search the web for a query. Returns results with title, URL, and a content excerpt.

**Parameters**:
| Name | Type | Required | Description |
|------|------|----------|-------------|
| query | string | Yes | The search query (1–16,384 characters) |
| max_results | integer | No | Max results, 1-10 (default 5) |

**Returns**: `{ success, query, results: [{ title, url, content }] }` as JSON text. Bounded responses keep this representation unchanged. The complete Pi result envelope obeys Penny's shared budget (by default 32,768 bytes, 32,768 characters, and 8,192 estimated tokens) and an independent 2,000-line ceiling; owner-supplied lower shared caps are honored. If truncation is needed, the model-visible value contains a UTF-8-safe prefix ending on a complete line and an explicit notice. The complete JSON is written to a newly created owner-only temporary directory (`0700`) and file (`0600`), and the notice gives its exact path for range-limited `read` calls.

Provider responses are streamed through an 8 MiB byte cap, JSON structural complexity is bounded, and result counts above the requested maximum are rejected. Full-result spill files are capped and live below one owner-only dedicated temporary root. At most four are retained per session; they are deleted on `session_shutdown`, while abnormal-termination cleanup incrementally visits at most 1,024 entries and removes at most 256 spills older than 24 hours per session start.

### web_fetch

**Description**: Fetch a single web page by URL. Returns the page title, extracted text content, and links.

**Parameters**:
| Name | Type | Required | Description |
|------|------|----------|-------------|
| url | string | Yes | http(s) URL of the page to fetch |

**Returns**: `{ success, url, title, content, truncated, links }` as JSON text. Content is truncated at 80,000 characters (`truncated: true` when clipped).

When Ollama Web Fetch returns provider HTTP 404 for a requested URL, the tool applies a bounded fallback sequence:

1. Common public `github.com` repository, issue, pull request, commit, and release routes are translated to a deterministic `api.github.com` URL and retried once. Blob, tree, and `raw.githubusercontent.com` routes are translated only when they contain an unambiguous full commit SHA; branch and tag routes can contain slashes and therefore fall through to browser guidance. GitHub Contents API file responses are returned only after strict bounded base64 and UTF-8 validation; directory responses are schema-checked.
2. If no safe GitHub translation exists, or the GitHub API retry also fails, the result normally includes a structured `retry_with` action for `playwright_navigate`. The extension cannot invoke a sibling Pi tool from inside its own tool execution, so the calling agent performs that browser retry when Playwright is active. Caller cancellations and HTTP 451 responses intentionally produce no automatic fallback guidance.

## Error Handling

Errors are categorized and logged with structured error codes:

- `SEARCH_API_KEY_MISSING` — no API key configured
- `SEARCH_CLIENT_ERROR` — 4xx responses (includes auth guidance for 401/403)
- `SEARCH_SERVER_ERROR` — 5xx responses or invalid JSON
- `SEARCH_NETWORK_ERROR` — connection failures
- `SEARCH_ABORTED` — timeout or caller cancellation

`web_fetch` errors say that Ollama Web Fetch could not return content for the **requested URL**. They call the HTTP code a **provider status** and explicitly avoid claiming that the destination itself returned that code. Failed fetch payloads include the requested `url`, a reason-specific `failure_scope`, optional `provider_status`, a diagnostic, any failed `github_api_fallback`, and—when appropriate—a structured `retry_with: { tool, arguments, available, reason }` Playwright action. Successful GitHub retries include `fallback: { strategy, kind, fetched_url, reason }`. Input validation failures and caller cancellations do not recommend another fetch automatically. Other tool errors retain the compact `{ success: false, error: "..." }` form.

## Events

| Event            | When           | Handler                                                        |
| ---------------- | -------------- | -------------------------------------------------------------- |
| session_start    | Session begins | Sets the logging session ID and performs bounded stale cleanup |
| session_shutdown | Session ends   | Deletes this session's full-result spill directories           |

## Configuration

| Variable                         | Default            | Description                                         |
| -------------------------------- | ------------------ | --------------------------------------------------- |
| OLLAMA_API_KEY                   | (none — required)  | API key from https://ollama.com/settings/keys       |
| OLLAMA_WEB_SEARCH_BASE_URL       | https://ollama.com | Override the API base URL (e.g. for a proxy)        |
| OLLAMA_WEB_SEARCH_TIMEOUT_MS     | 30000              | Per-request timeout in milliseconds                 |
| PENNY_TOOL_RESULT_MAX_BYTES      | 32768              | Optional lower shared complete-result byte cap      |
| PENNY_TOOL_RESULT_MAX_CHARACTERS | 32768              | Optional lower shared complete-result character cap |
| PENNY_TOOL_RESULT_MAX_TOKENS     | 8192               | Optional lower shared estimated-token cap           |

Environment variables are read at tool-call time, so the `environment` extension's `.env` loading always wins.

## Agent Access

Tool names are allowlisted per agent in `.pi/agents/*.md` frontmatter. `web_search` and `web_fetch` are granted to: annie, echo, piper, skribble, vera.

## Installation

This extension is bundled with Penny. No installation required.

## Testing

```bash
# Unit tests (mocked fetch, no network)
bun run test:unit

# Integration tests (mocked Pi API + stubbed global fetch, no network)
bun run test:integration
```

## Version History

- **Unreleased** — Target-focused fetch diagnostics, bounded GitHub API retries, structured Playwright fallback guidance, and shared-budget `web_search` output with bounded session-lifetime owner-only spills.
- **1.0.0** — Initial release: web_search and web_fetch via Ollama cloud API
