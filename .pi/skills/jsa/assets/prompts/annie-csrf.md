# CSRF — Worker Analysis Prompt

> **Reference Catalog:** `assets/references/csrf.md` — use `grep`/`read` to search, not full-file reads.



## Lane (Phase D)

**Lane:** `page_dom`
**Packet type:** page_card + relevant flow_cards (HTML structure + JS correlation)
**Tools to use:**
- **Caido tools** (caido_search, caido_request) for HTTP history
- **html_parser** (scripts/html_parser.py) for DOM structure
- **Playwright** (playwright_navigate) for live page inspection

This declaration tells INVESTIGATE phase how to route and packetize work items
for this analyzer. See `resources/reference.md` for lane semantics.

## Reference Catalog Usage
Before and during analysis, consult the reference catalog for patterns:
- `grep("^## Sources", "assets/references/csrf.md")` — input patterns
- `grep("^## Sinks", "assets/references/csrf.md")` — execution sinks
- `grep("^## Payloads", "assets/references/csrf.md")` — test payloads
- `grep("^## Detection", "assets/references/csrf.md")` — grep patterns for triage
- `grep("^## False Positives", "assets/references/csrf.md")` — common FP patterns
- `read("assets/references/csrf.md", limit=30)` then `read(..., offset=N)` for specific sections


## Mission

Find Cross-Site Request Forgery: state-changing requests without anti-CSRF protection.

## Workflow

### 1. Find State-Changing Operations
```bash
grep -nE "\.post\(|fetch\(.*POST|fetch\(.*PUT|fetch\(.*DELETE|\.submit\(|form\.action|axios\.post|axios\.put|axios\.delete" {file}
```

### 2. Check for CSRF Tokens
For each form/AJAX request:
- Does the request include a CSRF token? (header `X-CSRF-Token`, `_csrf` param, `csrfmiddlewaretoken`)
- Is the token validated server-side? (can't determine from client code alone — flag as "needs verification")
- Is the token predictable? (timestamp-based, sequential, derived from session cookie)

### 3. SameSite Cookie Analysis
Check if session cookies have `SameSite`:
- `SameSite=Strict` → full CSRF protection
- `SameSite=Lax` → protected except for top-level GET navigations
- `SameSite=None` → no CSRF protection (requires `Secure`)
- Missing → browser-dependent (Chrome defaults to Lax, older browsers no protection)

### 4. CSRF via GET
If state-changing operations use GET:
```html
<img src="https://victim.com/delete-account">  ← CSRF via image tag
```

### 5. JSON CSRF Bypass
If the endpoint accepts both `application/json` AND `text/plain` or `application/x-www-form-urlencoded`:
```html
<form method="POST" action="https://victim.com/api/transfer" enctype="text/plain">
  <input name='{"amount":1000,"to":"attacker","ignore":"' value='"}'>
</form>
```

### Key Detection
```bash
grep -nE "csrf|_token|authenticity_token|csrfmiddlewaretoken|X-CSRF|SameSite" {file}
```

### False Positives
- [ ] Request includes validated CSRF token
- [ ] Cookie has `SameSite=Strict` with no GET state-changing operations
- [ ] Request is idempotent (GET, no side effects)
- [ ] Custom header required (`X-Requested-With: XMLHttpRequest`) — partial protection
