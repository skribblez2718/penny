# Open Redirect — Analysis Reference

> **Reference Catalog:** `assets/references/open_redirect.md` — use `grep`/`read` to search, not full-file reads.



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
- `grep("^## Sources", "assets/references/open_redirect.md")` — input patterns
- `grep("^## Sinks", "assets/references/open_redirect.md")` — execution sinks
- `grep("^## Payloads", "assets/references/open_redirect.md")` — test payloads
- `grep("^## Detection", "assets/references/open_redirect.md")` — grep patterns for triage
- `grep("^## False Positives", "assets/references/open_redirect.md")` — common FP patterns
- `read("assets/references/open_redirect.md", limit=30)` then `read(..., offset=N)` for specific sections


## Mission

Find open redirect vulnerabilities: user-controlled URLs passed to navigation sinks without validation.

## Workflow

### 1. Find Navigation Sinks
```bash
grep -nE "location\.href\s*=|location\.replace\(|location\.assign\(|window\.open\(|\.href\s*=|\.src\s*=|\.action\s*=" {file}
```

### 2. Trace URL Source
For each sink, check if the URL comes from:
```
location.search, location.hash, URLSearchParams,
event.data (postMessage), localStorage.getItem,
document.referrer, fetch response body
```

### 3. Check Validation
**VULNERABLE — no validation:**
```javascript
location.href = params.get('redirect');
```

**WEAK — bypassable validation:**
```javascript
if (url.startsWith('/')) ...          // //evil.com bypasses
if (url.startsWith('https://')) ...   // https://evil.com is allowed
if (!url.includes('//')) ...          // java%0d%0ascript: bypasses
new URL(url).hostname === 'trusted'   // @ parsing confusion: https://trusted@evil.com
```

**SAFE — whitelist or relative-only:**
```javascript
if (url.startsWith('/') && !url.includes('//')) ...
const ALLOWED = ['/', '/dashboard', '/settings'];
if (ALLOWED.includes(url)) ...
```

### 4. OAuth Redirect Chain
```
/oauth/authorize?redirect_uri=https://evil.com → user approves → redirected to evil.com with auth code
```

### Key Payloads
```
//evil.com
https://evil.com
java%0d%0ascript:alert(1)
data:text/html,<script>alert(1)</script>
\/\/evil.com  (backslash bypass)
https:evil.com
```

### False Positives
- [ ] URL is hardcoded, not from user input
- [ ] URL is validated against a strict whitelist
- [ ] URL is constructed from a base path + safe slug (no protocol injection possible)
