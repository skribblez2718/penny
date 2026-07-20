# DOM Data Manipulation Reference Catalog

> **Search shortcuts:** `grep "^## Sources"` | `grep "^## Sinks"` | `grep "^## Detection"`

---

## Table of Contents
- [Sources](#sources) — User-controllable input patterns
- [Sinks](#sinks) — Execution/exploitation points
- [Detection Heuristics](#detection-heuristics) — Pattern matching and grep patterns
- [Multi-Step Chains](#multi-step-chains) — Cross-class exploitation chains
- [False Positives](#false-positives) — Common misidentified patterns

---

## Sources

| Source | Pattern |
|--------|--------|
| `event.data` | User-controllable input |
| `location.search` | User-controllable input |
| `URLSearchParams` | User-controllable input |

## Sinks

| Sink | Risk |
|------|------|
| `element.classList` | High |
| `element.innerHTML` | High |
| `element.setAttribute()` | High |
| `element.style` | High |
| `form.action` | High |
| `element.outerHTML` | High |
| `insertAdjacentHTML()` | High |
| `iframe.srcdoc` | High — attacker HTML rendered in the frame |
| `script.textContent` | High — inline script body |
| `style.cssText` | High — CSS injection |
| `element.removeAttribute()` | High — strips security attrs (`rel=noopener`, CSRF token) |

## Detection Heuristics

### Grep Patterns
```bash
# Security-sensitive DOM writes
grep -nE '\.(innerHTML|outerHTML|srcdoc|cssText)\s*=|insertAdjacentHTML\(|\.(setAttribute|removeAttribute)\(' file.js

# User controls WHICH element / attribute name (variable, not a quoted literal)
grep -nE 'getElementById\(|querySelector\(|setAttribute\(' file.js
```

### Key Heuristics
Flag when user input controls:
- **which element** is selected — `document.getElementById(userInput)`
- **which attribute** name is set — `element.setAttribute(userKey, userValue)`
- **the value** of a security-sensitive attribute (`action`, `src`, `href`, `srcdoc`)

## Multi-Step Chains

### DOM clobbering → security-check bypass → attribute rewrite → exfil
```
1. DOM clobbering defines a global (e.g. window.config) → guard/variable check bypassed
2. Attacker-controlled value flows into a security-sensitive attribute
3. form.action rewritten to evil.com (or the CSRF-token hidden input removed)
4. Victim submits the form → credentials/data exfiltrated to attacker
```
Overlaps `dom_clobbering` (step 1) and `link_manipulation` (steps 2–3, `form.action`/`iframe.src`).

## False Positives

| Pattern | Why FP | Verification |
|---------|--------|-------------|
| Only presentation attributes changed (color, font-size) | Not `action`/`src`/`href`/`srcdoc` | Confirm the attribute isn't security-sensitive |
| Element selected from a hardcoded allowlist | Attacker can't target an arbitrary element | Verify the selector is a literal / whitelisted key |
| Attribute NAME hardcoded, only value user-controlled | Narrower surface | Still check value validation for `src`/`href`/`action` |

