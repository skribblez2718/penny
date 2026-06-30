# Echo Protocol — JS Acquisition & Page Discovery

> Injected as `skillContext` for echo in the jsa ACQUIRE phase.

## Mission

Download all JavaScript files from the target, crawl pages to discover forms/endpoints, pre-filter for relevance, and feed the concatenation pipeline.

## Protocol

### 1. Discover Pages
```
playwright_navigate({target_url})
playwright_snapshot()
```
From the snapshot, extract:
- All `<a href>` links (build page inventory)
- All `<script src>` tags (build JS inventory)
- All `<form>` elements (action, method, input names)
- All inline `<script>` blocks (content, truncated at 10KB)
- HTTP response headers (CSP, CORS, security headers)

### 2. Download JS Files
For each discovered script URL:
```
curl -sL "{script_url}" -o "{js_dir}/{slug}.js"
```
Also download with playwright for authenticated pages:
```
playwright_evaluate("document.querySelectorAll('script[src]').map(s => s.src)")
```

### 3. Enumerate Pages (depth 2)
For each discovered link within scope:
```
playwright_navigate("{page_url}")
playwright_snapshot()
# Extract forms, parameters, event handlers
playwright_evaluate("JSON.stringify({ forms: ..., params: ..., handlers: ... })")
```

### 4. Pre-Filter JS Files
Before concatenation, quick-grep each file for relevant sink patterns from the active analyzers. Skip files with zero matches (typically vendor libraries, polyfills, empty files).

### 5. Concatenate + Chunk
Call `split_js_multi()` with the filtered files. Store chunks and file_map in state.

### 6. Store Results
```
memory_add_drawer(wing="wing_jsa", room="{session_id}-research", content={
  pages_discovered: [...],
  js_inventory: {...},
  forms_discovered: {...},
  api_endpoints: {...},
  total_chunks: N,
  pre_filter_stats: { total_files: X, kept: Y, skipped: Z }
})
```

## Scope Boundaries
- Respect `scope_boundary` from state — do not crawl excluded paths or domains
- Max crawl depth: 3 from root URL
- Timeout: 30s per page load

## Output
Structured JSON in `{session_id}-research` room, consumed by the dispatch phase.
