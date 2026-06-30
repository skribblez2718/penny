# DOM Clobbering — Worker Analysis Prompt

> **Reference Catalog:** `assets/references/dom_clobbering.md` — use `grep`/`read` to search, not full-file reads.



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
- `grep("^## Sources", "assets/references/dom_clobbering.md")` — input patterns
- `grep("^## Sinks", "assets/references/dom_clobbering.md")` — execution sinks
- `grep("^## Payloads", "assets/references/dom_clobbering.md")` — test payloads
- `grep("^## Detection", "assets/references/dom_clobbering.md")` — grep patterns for triage
- `grep("^## False Positives", "assets/references/dom_clobbering.md")` — common FP patterns
- `read("assets/references/dom_clobbering.md", limit=30)` then `read(..., offset=N)` for specific sections


## Mission

Find DOM Clobbering: HTML elements with `id`/`name` attributes that collide with JavaScript global variables, bypassing security checks.

## Workflow

### 1. Find Clobberable Variable Usage
```bash
grep -nE "window\.\w+|var \w+ = document\.|if \(!\w+\)|if \(typeof \w+ ===|if \(\w+ === undefined\)" {file}
```
Any global variable reference that could be shadowed by a named HTML element.

### 2. Check for Clobberable HTML Elements
Forms, embeds, iframes, images, objects with `name` or `id` attributes:
```html
<form name="config">      <!-- window.config = <form> element -->
<embed name="plugins">    <!-- window.plugins = <embed> element -->
<img name="cookie">       <!-- window.cookie = <img> element -->
```

### 3. Identify Clobbering → Security Bypass Chains
```javascript
// Vulnerable: typeof check bypassed
if (typeof config === 'undefined') { config = loadSecureConfig(); }
// Attacker injects: <form name="config"> → typeof config === 'object' → check bypassed

// Vulnerable: falsey check bypassed  
if (!plugins) { plugins = []; }
// Attacker injects: <embed name="plugins"> → plugins is truthy → check bypassed

// Vulnerable: config.apiKey is attacker-controlled text content
// <form name="config"><input name="apiKey" value="attacker-controlled"></form>
// → config.apiKey.value = "attacker-controlled"
```

### 4. Multi-Step: DOM Clobbering → DOM XSS
```
1. Attacker injects HTML (stored/reflected) with named elements
2. Named element clobbers global variable
3. Clobbered variable bypasses security check
4. Code reaches XSS sink with attacker-controlled value from clobbered element
```

### Key Detection
```bash
grep -nE "typeof \w+ === 'undefined'|if \(!\w+\)|if \(\w+ === undefined\)|if \(\w+ === null\)" {file}
```
These checks are clobberable. If the variable could be an HTML element name, flag it.

### False Positives
- [ ] Variable is declared with `const` or `let` (block-scoped, not clobberable via window)
- [ ] Check is `if (window.x === undefined)` — explicit window scope (still clobberable but intentional)
- [ ] Code is in a module (`type="module"` or webpack bundle — no global scope)
