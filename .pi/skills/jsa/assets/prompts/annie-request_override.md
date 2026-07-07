# Request Override — Analysis Reference

> **Reference Catalog:** `assets/references/request_override.md` — use `grep`/`read` to search, not full-file reads.



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
- `grep("^## Sources", "assets/references/request_override.md")` — input patterns
- `grep("^## Sinks", "assets/references/request_override.md")` — execution sinks
- `grep("^## Payloads", "assets/references/request_override.md")` — test payloads
- `grep("^## Detection", "assets/references/request_override.md")` — grep patterns for triage
- `grep("^## False Positives", "assets/references/request_override.md")` — common FP patterns
- `read("assets/references/request_override.md", limit=30)` then `read(..., offset=N)` for specific sections


## Mission

Find request override/hijacking: HTTP method override headers, URL rewriting, and request manipulation patterns.

## Workflow

### 1. Find Request Manipulation
```bash
grep -nE "X-HTTP-Method-Override|X-Forwarded-|X-Original-URL|X-Rewrite-URL|setRequestHeader|headers\[|\.method\s*=" {file}
```

### 2. Key Vectors
**HTTP Method Override:**
```javascript
// Server reads X-HTTP-Method-Override header to override the actual method
// Attacker sends: POST /delete-account with header X-HTTP-Method-Override: GET
// → Bypasses CSRF protection on GET-only endpoints
```

**URL Rewriting Headers:**
```
X-Original-URL: /admin
X-Rewrite-URL: /admin
X-Forwarded-Path: /../admin
```
Server middleware may use these to route requests — attacker bypasses path restrictions.

**X-Forwarded-For Spoofing:**
```javascript
// App trusts X-Forwarded-For for IP-based access control
// Attacker sends: X-Forwarded-For: 127.0.0.1 → bypasses IP restriction
```

### 3. Check for Trust Without Validation
Flag any code that reads these headers without validating the source (reverse proxy, trusted network).

### Key Detection
```bash
grep -nE "X-HTTP-Method|X-Forwarded-For|X-Forwarded-Host|X-Forwarded-Proto|X-Original-URL|X-Rewrite-URL|req\.headers\[|req\.get\(.*x-" {file}
```

### False Positives
- [ ] App uses a reverse proxy that strips/validates these headers
- [ ] Header values validated against allowlists
- [ ] Headers only used for logging, not routing/auth
