# Clickjacking — Analysis Reference

> **Reference Catalog:** `assets/references/clickjacking.md` — use `grep`/`read` to search, not full-file reads.



## Lane

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
- `grep("^## Sources", "assets/references/clickjacking.md")` — input patterns
- `grep("^## Sinks", "assets/references/clickjacking.md")` — execution sinks
- `grep("^## Payloads", "assets/references/clickjacking.md")` — test payloads
- `grep("^## Detection", "assets/references/clickjacking.md")` — grep patterns for triage
- `grep("^## False Positives", "assets/references/clickjacking.md")` — common FP patterns
- `read("assets/references/clickjacking.md", limit=30)` then `read(..., offset=N)` for specific sections


## Mission

Find clickjacking: pages that can be framed by attacker-controlled sites.

## Workflow

### 1. Check Frame Protection Headers
From page response headers:
```
X-Frame-Options: DENY → protected
X-Frame-Options: SAMEORIGIN → protected (can frame self)
X-Frame-Options: ALLOW-FROM uri → protected for specific origin
MISSING → vulnerable
```

### 2. Check CSP frame-ancestors
```
Content-Security-Policy: frame-ancestors 'none' → protected
Content-Security-Policy: frame-ancestors 'self' → protected
Content-Security-Policy: frame-ancestors example.com → protected for specific origin
MISSING (and no X-Frame-Options) → vulnerable
```

### 3. Check Frame-Busting Scripts
```bash
grep -nE "top\.location|top\.self|self\.location|window\.top|framebuster|frame.buster|if \(top !== self\)|if \(window !== top\)" {file}
```
Frame-busting scripts are unreliable — many bypasses exist:
- `sandbox="allow-forms"` on attacker's iframe disables scripts
- `X-Frame-Options: ALLOW-FROM` on attacker's page
- `onbeforeunload` event handler to counter redirects

### 4. Double-Clickjacking
Attacker overlays two transparent iframes — user thinks they're clicking one thing but clicks another.

### Key Detection
```bash
grep -nE "X-Frame-Options|frame-ancestors|frame.bust|framebuster|top\.location" {file}
```

### False Positives
- [ ] X-Frame-Options: DENY or SAMEORIGIN present
- [ ] CSP frame-ancestors 'none' or 'self' present  
- [ ] Page has no sensitive actions (static content, informational only)
