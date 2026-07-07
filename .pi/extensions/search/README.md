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
| query | string | Yes | The search query |
| max_results | integer | No | Max results, 1-10 (default 5) |

**Returns**: `{ success, query, results: [{ title, url, content }] }` as JSON text.

### web_fetch

**Description**: Fetch a single web page by URL. Returns the page title, extracted text content, and links.

**Parameters**:
| Name | Type | Required | Description |
|------|------|----------|-------------|
| url | string | Yes | http(s) URL of the page to fetch |

**Returns**: `{ success, url, title, content, truncated, links }` as JSON text. Content is truncated at 80,000 characters (`truncated: true` when clipped).

## Events

| Event         | When           | Handler                                |
| ------------- | -------------- | -------------------------------------- |
| session_start | Session begins | Sets session ID for structured logging |

## Configuration

| Variable                     | Default            | Description                                   |
| ---------------------------- | ------------------ | --------------------------------------------- |
| OLLAMA_API_KEY               | (none — required)  | API key from https://ollama.com/settings/keys |
| OLLAMA_WEB_SEARCH_BASE_URL   | https://ollama.com | Override the API base URL (e.g. for a proxy)  |
| OLLAMA_WEB_SEARCH_TIMEOUT_MS | 30000              | Per-request timeout in milliseconds           |

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

- **1.0.0** - Initial release: web_search and web_fetch via Ollama cloud API
