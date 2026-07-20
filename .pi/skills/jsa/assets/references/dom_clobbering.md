# DOM Clobbering Reference Catalog

> **Search shortcuts:** `grep "^## Sources"` | `grep "^## Sinks"` | `grep "^## Detection"`

---

## Table of Contents
- [Sources](#sources) — User-controllable input patterns
- [Sinks](#sinks) — Execution/exploitation points
- [Detection Heuristics](#detection-heuristics) — Pattern matching and grep patterns
- [Payloads](#payloads) — Clobberable elements and bypass chains
- [Multi-Step Chains](#multi-step-chains) — DOM clobbering → XSS
- [False Positives](#false-positives) — Common misidentified patterns

---

## Sources

| Source | Pattern |
|--------|--------|
| `HTML elements with id/name` | User-controllable input |
| `<form name=X>` | `window.X` / `document.X` → `<form>` element |
| `<img name=X>` | `window.X` → `<img>` element |
| `<embed name=X>` | `window.X` → `<embed>` element |
| `<object name=X>` | `window.X` → `<object>` element |
| `<iframe name=X>` | `window.X` → `<iframe>` element |
| `<a id=X>` | `window.X` → `<a>` element |

Named-access clobbering: elements with `id`, or `a/applet/area/embed/form/frame/frameset/iframe/img/object` with a `name` attribute, become named properties of `window`/`document`. A nested `<input name=Y>` inside a clobbered `<form name=X>` exposes `X.Y` as that input element, so `X.Y.value` is attacker-controlled text.

## Sinks

| Sink | Risk |
|------|------|
| `globalvariablechecks` | High |
| `if(!var)checks` | High |
| `typeofchecks` | High |

## Detection Heuristics

### Grep Patterns
```bash
# Clobberable global variable usage (globals an attacker can shadow)
grep -nE "window\.\w+|var \w+ = document\.|if \(!\w+\)|if \(typeof \w+ ===|if \(\w+ === undefined\)" file.js

# Clobberable existence / typeof / null checks (all bypassable by a named element)
grep -nE "typeof \w+ === 'undefined'|if \(!\w+\)|if \(\w+ === undefined\)|if \(\w+ === null\)" file.js
```
Any global-variable reference that could be shadowed by a named HTML element is a candidate. If the variable name could match an attacker-controlled element `id`/`name`, flag it.

## Payloads

### Clobberable HTML Elements
```html
<form name="config">      <!-- window.config = <form> element -->
<embed name="plugins">    <!-- window.plugins = <embed> element -->
<img name="cookie">       <!-- window.cookie = <img> element -->
<form name="config"><input name="apiKey" value="attacker"></form>
                          <!-- config.apiKey.value = "attacker" -->
```

### Bypass Chains
```javascript
// typeof check bypassed
if (typeof config === 'undefined') { config = loadSecureConfig(); }
// inject <form name="config"> → typeof config === 'object' → secure load skipped

// falsey check bypassed
if (!plugins) { plugins = []; }
// inject <embed name="plugins"> → plugins truthy → default skipped

// attacker-controlled property value
// <form name="config"><input name="apiKey" value="attacker-controlled"></form>
// → config.apiKey.value = "attacker-controlled"
```

## Multi-Step Chains

### DOM Clobbering → DOM XSS
1. Attacker injects HTML (stored/reflected) containing named elements
2. Named element clobbers a global variable
3. Clobbered variable bypasses a security check (typeof / falsey / null)
4. Code reaches an XSS sink with the attacker-controlled value from the clobbered element

Requires an HTML-injection primitive that permits `id`/`name` attributes but may strip `<script>`/event handlers — clobbering is the pivot that turns limited markup injection into script execution.

## False Positives

| Pattern | Why FP | Verification |
|---------|--------|-------------|
| `const x = ...` / `let x = ...` | Block-scoped — not clobberable via `window` named access | Confirm declaration keyword |
| `if (window.x === undefined)` | Explicit `window` scope (still clobberable, but intentional) | Check whether the global is set elsewhere |
| Code inside a module (`type="module"`, webpack/ESM bundle) | No shared global scope — top-level vars aren't `window` properties | Confirm module/bundle context |

