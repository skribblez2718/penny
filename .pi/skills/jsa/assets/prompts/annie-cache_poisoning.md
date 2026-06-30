# Cache Poisoning — Worker Analysis Prompt

> **Reference Catalog:** `assets/references/cache_poisoning.md` — use `grep`/`read` to search, not full-file reads.



## Lane (Phase D)

**Lane:** `network_behavior`
**Packet type:** page_card with Caido HTTP history (request/response, headers)
**Tools to use:**
- **Caido tools** (caido_search, caido_request) for HTTP request/response capture
- **playwright_route** for request interception/modification
- **html_parser** (scripts/html_parser.py) for header inspection

This declaration tells INVESTIGATE phase how to route and packetize work items
for this analyzer. See `resources/reference.md` for lane semantics.

## Reference Catalog Usage
Before and during analysis, consult the reference catalog for patterns:
- `grep("^## Sources", "assets/references/cache_poisoning.md")` — input patterns
- `grep("^## Sinks", "assets/references/cache_poisoning.md")` — execution sinks
- `grep("^## Payloads", "assets/references/cache_poisoning.md")` — test payloads
- `grep("^## Detection", "assets/references/cache_poisoning.md")` — grep patterns for triage
- `grep("^## False Positives", "assets/references/cache_poisoning.md")` — common FP patterns
- `read("assets/references/cache_poisoning.md", limit=30)` then `read(..., offset=N)` for specific sections


## Mission

Find Web Cache Poisoning: unkeyed inputs reflected in cacheable responses.

## Workflow

### 1. Find Cacheable Responses
```bash
grep -nE "Cache-Control|X-Cache|Vary|ETag|Last-Modified|max-age|s-maxage" {file}
```

### 2. Identify Unkeyed Inputs
Cache keys typically include: URL path, Host header, method. Everything else is UNKEYED and can poison:
```
X-Forwarded-Host → reflected in response → cached for all users
X-Forwarded-Scheme → reflected in redirect → cached
X-Forwarded-Port → reflected in absolute URL → cached
User-Agent → reflected in page content → cached
Cookie (specific ones) → reflected in response → cached
Query string params not in cache key → reflected → cached
```

### 3. Fat GET Poisoning
```
GET /page?param=innocent HTTP/1.1
Host: victim.com
Content-Length: 50

GET /page?param=evil HTTP/1.1
```
Some caches accept a body on GET and use the BODY's query string as the cache key.

### 4. Cache Key Injection
If the cache key includes a header the attacker controls:
```
X-Original-URL: /path
```
The cache may store `/path` but serve it as the response for `/`.

### 5. Key Detection
```bash
grep -nE "X-Forwarded-Host|X-Forwarded-Scheme|X-Forwarded-Port|Vary:|Cache-Control|X-Cache" {file}
```

### False Positives
- [ ] `Vary` header includes all user-controlled inputs
- [ ] No cache proxy in front of application
- [ ] Response is not cacheable (Cache-Control: no-store, private)
