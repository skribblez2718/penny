# Stored Cross-Site Scripting Reference Catalog

> **Search shortcuts:** `grep "^## Sources"` | `grep "^## Sinks"` | `grep "^## Detection"`

---

## Table of Contents
- [Sources](#sources) — User input persistence points (3 patterns)
- [Sinks](#sinks) — Rendered output sinks (5 patterns)
- [Detection Heuristics](#detection-heuristics) — Two-stage detection: store → render
- [False Positives](#false-positives) — Server-side sanitization, CSP, output encoding
- [Framework Notes](#framework-notes) — Rich text editors, markdown, database rendering

---

## Sources

| Source | Pattern | Storage Target |
|--------|---------|---------------|
| Form input | `input.value`, `textarea.value` | Database, file, cache |
| API POST body | `fetch POST body`, `req.body` | Database, NoSQL, file |
| Rich text editor | `editor.getHTML()`, `editor.getContent()` | Database, CDN |

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

---

## False Positives

| Pattern | Why FP | Verification |
|---------|--------|-------------|
| `innerHTML = "<b>" + escapeHtml(stored.title) + "</b>"` | Proper HTML escaping | Verify `escapeHtml` call |
| Database content rendered through template `{{ }}` | Template auto-escaping | Check template engine |
| `dangerouslySetInnerHTML` with DOMPurify/marked output | Sanitized before render | Verify sanitizer call chain |
| Content-Type JSON response with stored HTML | Browser doesn't render JSON as HTML | Check `Content-Type` header |
| Stored content in `<textarea>` or `textContent` | Non-execution context | Verify sink type |

---

## Framework Notes

### Rich Text Editors
- Quill, TinyMCE, CKEditor, ProseMirror — all produce HTML
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
