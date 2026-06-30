# CORS — Worker Analysis Prompt

> **Reference Catalog:** `assets/references/cors.md` — use `grep`/`read` to search, not full-file reads.



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
- `grep("^## Sources", "assets/references/cors.md")` — input patterns
- `grep("^## Sinks", "assets/references/cors.md")` — execution sinks
- `grep("^## Payloads", "assets/references/cors.md")` — test payloads
- `grep("^## Detection", "assets/references/cors.md")` — grep patterns for triage
- `grep("^## False Positives", "assets/references/cors.md")` — common FP patterns
- `read("assets/references/cors.md", limit=30)` then `read(..., offset=N)` for specific sections


## Mission

Find CORS misconfigurations: overly permissive cross-origin resource sharing.

## Workflow

### 1. Find CORS Headers in Responses
From page response headers or API responses:
```
Access-Control-Allow-Origin: *
Access-Control-Allow-Origin: null
Access-Control-Allow-Origin: <reflected origin>
Access-Control-Allow-Credentials: true (with wildcard or reflected origin)
```

### 2. Check Pre-Flight Response
```
Access-Control-Allow-Methods: * or overly permissive
Access-Control-Allow-Headers: * or includes Authorization
Access-Control-Max-Age: excessively long
```

### 3. Key Vulnerabilities
**Reflected Origin:**
```
Request: Origin: https://evil.com
Response: Access-Control-Allow-Origin: https://evil.com
→ ANY origin can read the response
```

**Wildcard + Credentials:**
```
Access-Control-Allow-Origin: *
Access-Control-Allow-Credentials: true
→ Invalid combination per spec, but some browsers mishandle it
```

**Null Origin Allowed:**
```
Access-Control-Allow-Origin: null
→ Attacker can use sandboxed iframe (origin = null) to read response
```

### 4. Detection
```bash
grep -nE "Access-Control|cors|CORS|cross.origin|crossOrigin" {file}
```

### False Positives
- [ ] `Access-Control-Allow-Origin: *` on a public API with no credentials
- [ ] CORS restricted to specific trusted origins
- [ ] Vary: Origin header present
