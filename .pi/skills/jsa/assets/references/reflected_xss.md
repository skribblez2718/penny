# Reflected Cross-Site Scripting Reference Catalog

> **Search shortcuts:** `grep "^## Sources"` | `grep "^## Sinks"` | `grep "^## Detection"`

---

## Table of Contents
- [Sources](#sources) — User-controllable input patterns (5 patterns)
- [Sinks](#sinks) — Execution sinks by context (HTML, attribute, JS, header)
- [Payloads](#payloads) — Reflection contexts and break-out payloads
- [Detection Heuristics](#detection-heuristics) — Pattern matching and grep patterns
- [False Positives](#false-positives) — Common misidentified patterns
- [Framework Notes](#framework-notes) — Server-side template engines

---

## Sources

| Source | Pattern | Context |
|--------|---------|---------|
| URL query string | `location.search`, `URLSearchParams` | Client-side reflection |
| Express request | `req.query`, `req.params` | Server-side reflection |
| Express request body | `req.body` | Server-side reflection (POST) |
| HTTP Referer | `document.referrer` | Client-side header reflection |
| `window.name` | `window.name` | Cross-domain persistent |

---

## Sinks

### HTML Body Sinks (Critical)
| Sink | Pattern |
|------|---------|
| `innerHTML` | `el.innerHTML = userInput` |
| `document.write()` | `document.write(userInput)` |
| `res.send()` | Express: `res.send(userInput)` |
| `res.render()` | Express with template: `res.render('page', { data: userInput })` |
| `res.write()` | Express: `res.write(userInput)` |
| `$.html()` | jQuery: `$el.html(userInput)` |
| `$.append()` | jQuery: `$el.append(userInput)` (parses HTML) |

### HTML Attribute Sinks (High)
| Sink | Pattern |
|------|---------|
| `setAttribute()` | `el.setAttribute('href', userInput)` |
| `element.attr()` | jQuery: `$el.attr('href', userInput)` |
| `href` / `src` | `el.href = userInput`, `el.src = userInput` |

### JavaScript Context Sinks (Critical)
| Sink | Pattern |
|------|---------|
| `eval()` | `eval(userInput)` |
| `new Function()` | `new Function(userInput)` |
| `setTimeout(string)` | `setTimeout(userInput, 100)` |

### HTTP Header → DOM (Medium)
| Sink | Pattern |
|------|---------|
| `document.referrer` → DOM | Server reflects `Referer` header into page |
| `window.name` → DOM | Cross-domain `window.name` persistence |

---

## Payloads

### Context → Break-out
Identify the reflection context to choose the payload:

| Context | Example | Break-out |
|---------|---------|-----------|
| HTML body | `<div>USER_INPUT</div>` | `<img src=x onerror=alert(1)>` |
| Attribute (double-quoted) | `<input value="USER_INPUT">` | `"><img src=x onerror=alert(1)>` |
| Attribute (single-quoted) | `<input value='USER_INPUT'>` | `'><img src=x onerror=alert(1)>` |
| Attribute (unquoted) | `<input value=USER_INPUT>` | `x onmouseover=alert(1)` |
| JS string | `var x = 'USER_INPUT';` | `'; alert(1); //` |
| JS code | `var x = USER_INPUT;` | `1; alert(1); //` |
| HTML comment | `<!-- USER_INPUT -->` | `--><img src=x onerror=alert(1)>` |
| URL / href | `<a href="USER_INPUT">` | `javascript:alert(1)` |

---

## Detection Heuristics

### Grep Patterns
```bash
# Server-side reflection sinks (Express/Node)
grep -nE 'res\.send\(|res\.render\(|res\.json\(|res\.end\(' file.js

# Client-side reflection sinks
grep -nE '\.innerHTML\s*=|document\.write|eval\(|setTimeout\s*\([^,)]+\)' file.js

# URL parameter sources
grep -nE 'location\.search|URLSearchParams|req\.query|req\.params' file.js
```

### Source→Sink Trace Pattern
1. Find user input reaching server: `req.query.x`, `req.params.id`
2. Trace through server-side logic: template engines, JSON responses, redirects
3. Check if input appears in response unescaped
4. Identify response context: HTML, attribute, JS, CSS, URL

### WAF / CSP Gating
If encoding is absent but the app enforces a WAF or CSP, downgrade the finding to `possible` and record bypass notes (e.g. CSP `unsafe-inline`, missing `object-src`/`base-uri`, JSONP or allow-listed CDN endpoints, dangling-markup for data exfil).

---

## False Positives

| Pattern | Why FP | Verification |
|---------|--------|-------------|
| `res.send(escapeHtml(userInput))` | Proper HTML escaping | Verify `escapeHtml` function call |
| `res.json({ data: userInput })` | JSON Content-Type — not rendered as HTML | Check `Content-Type: application/json` |
| `res.render('page', { x: sanitize(userInput) })` | Template auto-escaping (EJS `<%= %>`, Handlebars `{{ }}`) | Verify template engine escaping |
| `res.redirect('/app/' + encodeURIComponent(path))` | `encodeURIComponent` prevents injection | URL encoding applied |
| `location.href = '/search?q=' + encodeURIComponent(q)` | Proper URL encoding | Verify encoding function |
| `$('#out').text(userInput)` / `el.textContent = userInput` | Non-HTML sink — text not parsed as markup | Confirm `.text()`/`textContent`, not `.html()`/`innerHTML` |
| Angular interpolation `{{ userInput }}` / React JSX `{userInput}` | Framework auto-escapes by default | Confirm no `[innerHTML]`/`bypassSecurityTrust*` (Angular) or `dangerouslySetInnerHTML` (React) |

---

## Framework Notes

### Express / EJS
- `<%= userInput %>` auto-escapes HTML
- `<%- userInput %>` does NOT escape — this is the sink
- `res.render('view', { unsafe: userInput })` with `<%- unsafe %>` is vulnerable

### Handlebars
- `{{ userInput }}` auto-escapes HTML
- `{{{ userInput }}}` triple-brace does NOT escape — this is the sink

### Next.js
- Server Components: JSX `{}` auto-escapes — not vulnerable
- API routes: `res.send(userInput)` is a raw response — check Content-Type
- `getServerSideProps` returning user input → check how it's rendered
