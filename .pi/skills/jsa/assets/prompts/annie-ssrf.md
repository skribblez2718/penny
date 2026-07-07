# SSRF — Analysis Reference

> **Reference Catalog:** `assets/references/ssrf.md` — use `grep`/`read` to search, not full-file reads.



## Lane

**Lane:** `code_static`
**Packet type:** flow_card (with source/sink/sanitizer, ~50-200 lines of code)
**Tools to use:**
- **Joern queries** (when available): scripts/joern_queries/{vuln_class}.sc
- **tree-sitter queries** for source/sink matching
- **semgrep** for pattern validation

This declaration tells INVESTIGATE phase how to route and packetize work items
for this analyzer. See `resources/reference.md` for lane semantics.

## Reference Catalog Usage
Before and during analysis, consult the reference catalog for patterns:
- `grep("^## Sources", "assets/references/ssrf.md")` — input patterns
- `grep("^## Sinks", "assets/references/ssrf.md")` — execution sinks
- `grep("^## Payloads", "assets/references/ssrf.md")` — test payloads
- `grep("^## Detection", "assets/references/ssrf.md")` — grep patterns for triage
- `grep("^## False Positives", "assets/references/ssrf.md")` — common FP patterns
- `read("assets/references/ssrf.md", limit=30)` then `read(..., offset=N)` for specific sections


## Mission

Find Server-Side Request Forgery patterns in client-side JS: user-controlled URLs passed to backend API endpoints that the server fetches.

## Workflow

### 1. Find URL Fetching Patterns
```bash
grep -nE "fetch\(|axios\.(get|post)|\.get\(|\.post\(|http\.request|XMLHttpRequest|WebSocket|new URL\(|\.src\s*=.*http" {file}
```

### 2. Trace URL Source
The URL parameter comes from user input:
```
location.search, URLSearchParams,
user input fields, form values,
postMessage data, localStorage
```

### 3. Check Server-Side Indicators
If the URL is sent to a backend endpoint (`/api/fetch?url=`, `/proxy?target=`), the server may fetch it:
```javascript
fetch('/api/proxy?url=' + encodeURIComponent(userUrl))
// Server does: http.get(userUrl) → SSRF
```

### 4. Target Internal Services
Common SSRF targets:
```
http://169.254.169.254/latest/meta-data/  (AWS metadata)
http://metadata.google.internal/          (GCP metadata)
http://127.0.0.1:8080/admin
http://localhost:3000/internal
file:///etc/passwd
gopher://127.0.0.1:25/
```

### Key Detection
Look for API endpoints that accept URLs as parameters:
```bash
grep -nE "/proxy|/fetch|/fetch-url|/preview|/thumbnail|/import|/webhook|url=|target=|path=" {file}
```

### False Positives
- [ ] URL is constructed server-side, not from user input
- [ ] URL is validated against allowed domains whitelist
- [ ] URL only used client-side (fetch/XHR in browser), never sent to server
