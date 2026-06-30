# Reflected XSS — Worker Analysis Prompt

> **Reference Catalog:** `assets/references/reflected_xss.md` — use `grep`/`read` to search, not full-file reads.



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
- `grep("^## Sources", "assets/references/reflected_xss.md")` — input patterns
- `grep("^## Sinks", "assets/references/reflected_xss.md")` — execution sinks
- `grep("^## Payloads", "assets/references/reflected_xss.md")` — test payloads
- `grep("^## Detection", "assets/references/reflected_xss.md")` — grep patterns for triage
- `grep("^## False Positives", "assets/references/reflected_xss.md")` — common FP patterns
- `read("assets/references/reflected_xss.md", limit=30)` then `read(..., offset=N)` for specific sections


## Mission

Find Reflected Cross-Site Scripting: server-reflected user input rendered without sanitization. Look for parameter→response reflection patterns in the code.

## Workflow

### 1. Find Response Rendering
```bash
grep -nE "res\.send\(|res\.render\(|res\.write\(|res\.end\(|\.innerHTML\s*=|document\.write\(|\.html\(|\.append\(|v-html|dangerouslySetInnerHTML" {file}
```

### 2. Trace Input Source
The rendered content comes from:
```
location.search, URLSearchParams,
req.query, req.params, req.body (Express),
$_GET, $_POST, $_REQUEST (PHP patterns in JS),
window.name, document.referrer
```

### 3. Check Encoding
**VULNERABLE — no encoding:**
```javascript
res.send('<div>' + req.query.name + '</div>');
$('#output').html(params.get('search'));
```

**SAFE — proper encoding:**
```javascript
res.send('<div>' + escapeHtml(req.query.name) + '</div>');
$('#output').text(params.get('search'));  // .text() not .html()
```

### 4. Context Analysis
Identify the reflection context to determine payload:
| Context | Example | Break-out |
|---------|---------|-----------|
| HTML body | `<div>USER_INPUT</div>` | `<img src=x onerror=alert(1)>` |
| Attribute (double) | `<input value="USER_INPUT">` | `"><img src=x onerror=alert(1)>` |
| Attribute (single) | `<input value='USER_INPUT'>` | `'><img src=x onerror=alert(1)>` |
| Attribute (unquoted) | `<input value=USER_INPUT>` | `x onmouseover=alert(1)` |
| JS string | `var x = 'USER_INPUT';` | `'; alert(1); //` |
| JS code | `var x = USER_INPUT;` | `1; alert(1); //` |
| HTML comment | `<!-- USER_INPUT -->` | `--><img src=x onerror=alert(1)>` |
| URL/href | `<a href="USER_INPUT">` | `javascript:alert(1)` |

### 5. Check for WAF/CSP
If encoding is absent but the app has WAF or CSP, flag as `possible` with bypass notes.

### False Positives
- [ ] User input is properly encoded for its context
- [ ] `textContent`/`.text()` used instead of `innerHTML`/`.html()`
- [ ] Framework auto-escaping active (React JSX, Angular default, Vue `{{ }}`)
