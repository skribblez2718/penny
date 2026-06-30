# DOM XSS — Analysis Prompt

> **Reference Catalog:** `assets/references/dom_xss.md` — use `grep`/`read` to search, not full-file reads.



## Lane (Phase D)

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
- `grep("^## Sources", "assets/references/dom_xss.md")` — 12 input patterns
- `grep("^## Sinks", "assets/references/dom_xss.md")` — execution sinks by severity
- `grep("^## Payloads", "assets/references/dom_xss.md")` — test payloads per sink type
- `grep("^## Bypass", "assets/references/dom_xss.md")` — sanitizer/CSP bypass techniques
- `grep("^## Detection", "assets/references/dom_xss.md")` — grep patterns for manual triage
- `grep("^## False Positives", "assets/references/dom_xss.md")` — common FP patterns
- `grep -i "<framework>" assets/references/dom_xss.md` — React/Angular/Vue/jQuery specifics
- `read("assets/references/dom_xss.md", limit=30)` then `read(..., offset=N)` for specific sections

## Mission

Analyze the assigned code chunk for DOM-Based Cross-Site Scripting. Trace attacker-controllable sources into JavaScript/HTML execution sinks without sanitization.

## Analysis Workflow (Execute in Order)

### Step 1: Scan for Sinks (Fast)
These sinks in the chunk mean DOM XSS is POSSIBLE. Find them FIRST:

**CRITICAL — code execution:**
```
innerHTML, outerHTML, document.write, document.writeln, eval(), 
new Function(), setTimeout/setInterval (string arg), 
script.text, script.textContent, insertAdjacentHTML
```
```bash
grep -nE "innerHTML|outerHTML|document\.write|eval\(|new Function|setTimeout\(|setInterval\(|\.text\s*=|\.textContent\s*=|insertAdjacentHTML" {file}
```

**HIGH — injection / navigation:**
```
DOMParser.parseFromString, Range.createContextualFragment, 
location.href=, location.assign, location.replace, window.open,
anchor.href, iframe.src, form.action
```
```bash
grep -nE "parseFromString|createContextualFragment|location\.(href|assign|replace)\s*=|window\.open\(|\.href\s*=|\.src\s*=|\.action\s*=" {file}
```

**FRAMEWORK-SPECIFIC (check only if framework detected):**
- React: `dangerouslySetInnerHTML`, `ref.current.innerHTML`, `createPortal`
- Vue: `v-html`, `this.$refs.*.innerHTML`, `this.$el.innerHTML`
- Angular: `[innerHTML]`, `bypassSecurityTrustHtml`, `bypassSecurityTrustScript`, `nativeElement.innerHTML`
- jQuery: `$.html()`, `$()`, `$.append`, `$.prepend`, `$.after`, `$.replaceWith`

### Step 2: Trace Sources Backward
For each sink found, trace backward to see if the input comes from an attacker-controllable source:

**URL-based (most common):**
```
location.hash, location.search, location.href, location.pathname, 
document.URL, document.documentURI, document.baseURI, 
URLSearchParams, new URL(userInput)
```
```bash
grep -nE "location\.(hash|search|href|pathname)|document\.(URL|documentURI|baseURI)|URLSearchParams|new URL\(" {file}
```

**CRITICAL — `window.name`:** Persists across cross-domain navigations. Extremely overlooked.
```bash
grep -nE "window\.name\b" {file}
```

**Other sources:**
```
document.referrer, event.data (postMessage), 
localStorage.getItem, sessionStorage.getItem, 
document.cookie, history.pushState, history.replaceState
```

### Step 3: Check for Sanitization
Between source and sink, look for protection:

**Sanitizers present → may be bypassed (check references for version-specific bypasses):**
```
DOMPurify.sanitize, sanitize-html, escapeHtml, encodeURIComponent,
xss-filters, js-xss, safe-html
```

**CSP detected → XSS may still be exploitable via gadgets:**
```
Content-Security-Policy header, Trusted Types, 
trustedTypes.createPolicy
```

**NO sanitization between source and sink → report immediately.**

### Step 4: Run Automated Scanners
```bash
# semgrep with DOM XSS rulesets
semgrep --config p/xss --config p/javascript --config p/owasp-top-ten --json {file}

# jsluice URL extraction (finds dynamic endpoints)
jsluice urls < {file}

# AST-level source→sink trace (if Python scanner available)
python3 scripts/analyzers/dom_xss.py --file {file}
```

### Step 5: Classify Finding
| Confidence | Criteria |
|-----------|----------|
| **confirmed** | Source → sink with zero sanitization; payload would execute |
| **probable** | Source → sink with partial sanitization or context-dependent |
| **possible** | Source → sink with sanitizer present (may have bypass) or CSP protected |
| **false_positive** | Sink is dead code, test file, or source is server-controlled (not attacker) |

## Quick False Positive Checks

Before reporting, rule out:
- [ ] Sink is in a test file (`*.test.js`, `*.spec.js`, `__tests__/`)
- [ ] Source is a server-controlled variable (not `location.*` or `document.*`)
- [ ] Code is inside `if (false)` or is unreachable
- [ ] Sink receives a hardcoded string literal (not a variable from source)
- [ ] CSP with `script-src 'none'` or Trusted Types enforced (still flag as `possible` with CSP bypass note)

## Overlap Awareness

If your chunk contains overlap with adjacent chunks, tag findings in the overlap region with `is_boundary: true`. Check the mesh feed for cross-chunk hints from neighboring workers. If a tainted variable flows from a previous chunk into yours, trace it to see if it reaches a sink.

## Cross-File Awareness

Your chunk may contain `// === file: <path> ===` delimiters. When a source in one file flows to a function in another file, trace the flow across the delimiter. Flag the finding with both files.

## Key Multi-Step Chains to Watch For

- **Prototype pollution → DOM XSS**: Check if `Object.prototype` or `__proto__` is polluted before the sink
- **DOM clobbering → DOM XSS**: Check if global variable checks can be bypassed via named HTML elements
- **postMessage → DOM XSS**: Check `event.data` flows without origin validation

## After Analysis

Store all findings to `{session_id}-findings` in MemPalace. Post cross-chunk hints to `{session_id}-feed`. If you found CVE-relevant library versions, alert the CVE research agent via the feed.
