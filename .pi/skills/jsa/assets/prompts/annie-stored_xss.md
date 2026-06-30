# Stored XSS — Worker Analysis Prompt

> **Reference Catalog:** `assets/references/stored_xss.md` — use `grep`/`read` to search, not full-file reads.



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
- `grep("^## Sources", "assets/references/stored_xss.md")` — input patterns
- `grep("^## Sinks", "assets/references/stored_xss.md")` — execution sinks
- `grep("^## Payloads", "assets/references/stored_xss.md")` — test payloads
- `grep("^## Detection", "assets/references/stored_xss.md")` — grep patterns for triage
- `grep("^## False Positives", "assets/references/stored_xss.md")` — common FP patterns
- `read("assets/references/stored_xss.md", limit=30)` then `read(..., offset=N)` for specific sections


## Mission

Find Stored/Persistent Cross-Site Scripting: user input stored (database, API, localStorage) then rendered unsanitized.

## Workflow

### 1. Find Storage → Rendering Pipelines
Trace data from storage operations to rendering sinks:
**Storage writes:** `localStorage.setItem`, `fetch POST`, `axios.post`, `$.post`, `sessionStorage.setItem`
**Rendering sinks:** `innerHTML`, `$.html()`, `v-html`, `dangerouslySetInnerHTML`, `document.write`

### 2. Check Sanitization at Each Layer
```
User Input → [SANITIZED?] → Storage → [SANITIZED?] → API Response → [SANITIZED?] → JSON.parse → [SANITIZED?] → DOM Rendering
```
Sanitization must happen at the LAST step (rendering), not at storage. Storage that "sanitizes" may be undone by JSON parse.

### 3. Rich Text Editor Bypass
If the app uses a rich text editor (TinyMCE, CKEditor, Quill, Draft.js), check allowed tags/attributes. Editors often allow dangerous combinations.

### 4. Second-Order Stored XSS
```
Inject in user profile → admin views profile in admin panel → XSS in admin context (privilege escalation)
```
Check if stored data is rendered in multiple contexts (user view, admin view, email, PDF).

### 5. Key Detection
```bash
semgrep --config p/xss --config p/javascript --json {file}
grep -nE "localStorage\.setItem|\.post\(|fetch\(.*POST|innerHTML|\.html\(|dangerouslySetInnerHTML|v-html" {file}
```

### False Positives
- [ ] Data is sanitized at rendering time (DOMPurify, sanitize-html, escapeHtml)
- [ ] Rendering uses safe API (textContent, React auto-escaping, Vue {{ }})
- [ ] Storage is write-only (never read and rendered)
