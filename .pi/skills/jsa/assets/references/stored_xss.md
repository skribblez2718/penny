# Stored Cross-Site Scripting Reference Catalog

> **Search shortcuts:** `grep "^## Sources"` | `grep "^## Sinks"` | `grep "^## Detection"`

---

## Table of Contents
- [Sources](#sources) — User input persistence points (5 patterns)
- [Sinks](#sinks) — Rendered output sinks (5 patterns)
- [Scanners & Commands](#scanners--commands) — semgrep + grep triage
- [Detection Heuristics](#detection-heuristics) — Two-stage detection: store → render
- [Multi-Step Chains](#multi-step-chains) — Second-order / cross-context stored XSS
- [False Positives](#false-positives) — Server-side sanitization, CSP, output encoding
- [Framework Notes](#framework-notes) — Rich text editors, markdown, database rendering

---

## Sources

| Source | Pattern | Storage Target |
|--------|---------|---------------|
| Form input | `input.value`, `textarea.value` | Database, file, cache |
| API POST body | `fetch POST body`, `req.body` | Database, NoSQL, file |
| Rich text editor | `editor.getHTML()`, `editor.getContent()` | Database, CDN |
| Client storage | `localStorage.setItem`, `sessionStorage.setItem` | Browser storage (per-origin persistence) |
| HTTP client POST | `axios.post`, `$.post`, `fetch(..., {method:'POST'})` | Database, NoSQL, file |

---

## Sinks

| Sink | Pattern | Notes |
|------|---------|-------|
| `innerHTML` | `el.innerHTML = storedValue` | Most common stored XSS sink |
| `document.write()` | `document.write(storedValue)` | Synchronous; rare in modern apps |
| `$.html()` | `$el.html(storedValue)` | jQuery HTML insertion |
| `dangerouslySetInnerHTML` | `<div dangerouslySetInnerHTML={{__html: storedValue}} />` | React — explicit unsafe |
| `v-html` | `<div v-html="storedValue"></div>` | Vue — explicit unsafe |

---

## Scanners & Commands

```bash
# Semgrep XSS + JS rulesets (JSON output for parsing)
semgrep --config p/xss --config p/javascript --json file.js

# One-pass triage: storage writes + render sinks together
grep -nE "localStorage\.setItem|\.post\(|fetch\(.*POST|innerHTML|\.html\(|dangerouslySetInnerHTML|v-html" file.js
```
Run semgrep first for a rules-based pass, then use grep to correlate the storage write with the render sink — they usually live in different files/functions, so trace by shared field/variable name.

---

## Detection Heuristics

### Two-Stage Detection Pattern
1. **Find storage writes:** `fetch('POST', ...)`, `localStorage.setItem()`, `db.insert()`
2. **Find storage reads and renders:** `db.find()` → `innerHTML`, `$.html()`
3. **Trace the complete path:** input → database → template → DOM

### Grep Patterns
```bash
# Storage sinks (write)
grep -nE 'db\.(insert|create|save|update)\b|\.setItem\(|fetch.*POST|axios\.post' file.js

# Render sinks (read → display)
grep -nE '\.innerHTML\s*=|dangerouslySetInnerHTML|v-html|document\.write' file.js

# Database reads followed by DOM writes (look for same function)
# Manual trace: find `db.find()` results → how are they rendered?
```

### Key Heuristic
Stored XSS requires a **two-hop trace**: user input → storage → rendered output.  
Single-hop patterns (user input → DOM) are reflected XSS, not stored.  
If the input is sanitized at storage but the renderer removes sanitization, flag it.

### Sanitize at Render, Not at Storage
```
User Input → [?] → Storage → [?] → API Response → [?] → JSON.parse → [?] → DOM Render
```
The only reliable sanitization point is the LAST hop (render). Sanitization applied at write can be silently undone downstream — e.g. `JSON.parse` of an escaped-then-serialized string, or a re-encode that reverts entities. If sanitization happens at storage but the renderer trusts stored data, flag it.

---

## Multi-Step Chains

### Second-Order Stored XSS (privilege escalation)
```
Inject in user profile → admin opens profile in admin panel → XSS in admin context
```
The stored payload executes in a *different, higher-privilege* context than where it was submitted. Enumerate every context the stored value is rendered in — user view, admin/moderation panel, email template, exported PDF/CSV, mobile webview. A field escaped in one renderer may be unescaped in another.

---

## False Positives

| Pattern | Why FP | Verification |
|---------|--------|-------------|
| `innerHTML = "<b>" + escapeHtml(stored.title) + "</b>"` | Proper HTML escaping | Verify `escapeHtml` call |
| Database content rendered through template `{{ }}` | Template auto-escaping | Check template engine |
| `dangerouslySetInnerHTML` with DOMPurify/marked output | Sanitized before render | Verify sanitizer call chain |
| Content-Type JSON response with stored HTML | Browser doesn't render JSON as HTML | Check `Content-Type` header |
| Stored content in `<textarea>` or `textContent` | Non-execution context | Verify sink type |
| Stored value is write-only (persisted but never read back into a renderer) | No render sink → no execution | Confirm no read path renders the field |

---

## Framework Notes

### Rich Text Editors
- Quill, TinyMCE, CKEditor, ProseMirror, Draft.js — all produce HTML
- Check: is editor output sanitized before storage? Is it sanitized before render?
- Attack vectors: `<img onerror>`, `<svg onload>`, `<details open ontoggle>`
- If editor supports "View HTML" mode with unescaped output → check for injection

### Markdown Renderers
- marked, markdown-it, showdown — convert markdown to HTML
- HTML in markdown: `<img src=x onerror=alert(1)>` passes through many renderers
- Check: is `sanitize: true` option enabled? Is DOMPurify used post-render?
- `marked.parse(userInput, { sanitize: false })` is vulnerable

### Database → Template Rendering
- EJS: `<%- storedValue %>` — unsafe; `<%= storedValue %>` — safe
- Handlebars: `{{{ storedValue }}}` — unsafe; `{{ storedValue }}` — safe  
- React: `{storedValue}` in JSX — safe; `dangerouslySetInnerHTML` — unsafe
- Vue: `{{ storedValue }}` — safe; `v-html="storedValue"` — unsafe
