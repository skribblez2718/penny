# HTTP Smuggling — Worker Analysis Prompt

> **Reference Catalog:** `assets/references/http_smuggling.md` — use `grep`/`read` to search, not full-file reads.



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
- `grep("^## Sources", "assets/references/http_smuggling.md")` — input patterns
- `grep("^## Sinks", "assets/references/http_smuggling.md")` — execution sinks
- `grep("^## Payloads", "assets/references/http_smuggling.md")` — test payloads
- `grep("^## Detection", "assets/references/http_smuggling.md")` — grep patterns for triage
- `grep("^## False Positives", "assets/references/http_smuggling.md")` — common FP patterns
- `read("assets/references/http_smuggling.md", limit=30)` then `read(..., offset=N)` for specific sections


## Mission

Find HTTP Request Smuggling: discrepancies between frontend and backend HTTP parsing.

## Workflow

### 1. Identify Multi-Layer Architecture
Check for proxy/load balancer configurations in code:
```bash
grep -nE "proxy|nginx|haproxy|cloudfront|cloudflare|fastly|akamai|transfer.encoding|content.length|keep.alive" {file}
```

### 2. Key Smuggling Vectors
**CL.TE (Content-Length vs Transfer-Encoding):**
Frontend uses Content-Length, backend uses Transfer-Encoding → smuggled request prefix.

**TE.CL:**
Frontend uses Transfer-Encoding, backend uses Content-Length → different body interpretation.

**TE.TE:**
Both use Transfer-Encoding with obfuscation:
```
Transfer-Encoding: chunked
Transfer-Encoding: xchunked  ← obfuscated, one parser ignores
Transfer-Encoding : chunked  ← space variation
Transfer-Encoding: chunked\r\n  ← trailing whitespace
```

### 3. Client-Side Desync
Browser-level request smuggling via `fetch()` with specific headers:
```javascript
fetch('/api', {
  method: 'POST',
  headers: { 'Content-Length': '0', 'Transfer-Encoding': 'chunked' },
  body: '0\r\n\r\nSMUGGLED'
});
```

### 4. HTTP/2 Downgrade
HTTP/2 → HTTP/1.1 downgrade at proxy can introduce smuggling when headers don't map cleanly.

### Key Detection
Look for code that manually sets Content-Length or Transfer-Encoding headers alongside user-controlled body content.

### False Positives
- [ ] Single-layer architecture (no proxy/load balancer)
- [ ] HTTP/2 end-to-end (no downgrade)
- [ ] Content-Length set by framework, not manually
