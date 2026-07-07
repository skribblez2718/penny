# Link Manipulation — Analysis Reference

> **Reference Catalog:** `assets/references/link_manipulation.md` — use `grep`/`read` to search, not full-file reads.



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
- `grep("^## Sources", "assets/references/link_manipulation.md")` — input patterns
- `grep("^## Sinks", "assets/references/link_manipulation.md")` — execution sinks
- `grep("^## Payloads", "assets/references/link_manipulation.md")` — test payloads
- `grep("^## Detection", "assets/references/link_manipulation.md")` — grep patterns for triage
- `grep("^## False Positives", "assets/references/link_manipulation.md")` — common FP patterns
- `read("assets/references/link_manipulation.md", limit=30)` then `read(..., offset=N)` for specific sections


## Mission

Find link manipulation: user input controlling `href`, `src`, `action`, or other URL attributes of DOM elements.

## Workflow

### 1. Find Dynamic URL Attributes
```bash
grep -nE "\.href\s*=|\.src\s*=|\.action\s*=|\.data\s*=|setAttribute\(['\"]href|setAttribute\(['\"]src" {file}
```

### 2. Check URL Source
If the URL comes from user input, check for protocol injection:
```
javascript:alert(1)
data:text/html,<script>alert(1)</script>
vbscript:msgbox(1)
```

### 3. Element-Specific Threats
| Element | Attribute | Threat |
|---------|-----------|--------|
| `<a>` | `href` | `javascript:` URL executes in current origin |
| `<script>` | `src` | Loads attacker's script (full compromise) |
| `<iframe>` | `src` | Embeds attacker page, potential phishing |
| `<img>` | `src` | CSRF via GET, tracking pixel |
| `<link>` | `href` | CSS injection via external stylesheet |
| `<form>` | `action` | Exfiltrates form data to attacker |
| `<base>` | `href` | Hijacks relative URLs for all page resources |

### 4. Relative Path Overwrite
```javascript
element.href = '../../' + userInput;  // Path traversal
element.src = '/' + userInput;         // Can reach unexpected endpoints
```

### Key Payloads
```
javascript:alert(1)
data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==
//evil.com
https://evil.com
```

### False Positives
- [ ] URL is validated against a strict allowlist
- [ ] URL is a relative path constructed from safe slugs (no user-controlled protocol)
- [ ] URL is hardcoded from config (not user input)
