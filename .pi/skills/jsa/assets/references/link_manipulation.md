# Link Manipulation Reference Catalog

> **Search shortcuts:** `grep "^## Sources"` | `grep "^## Sinks"` | `grep "^## Detection"`

---

## Table of Contents
- [Sources](#sources) — User-controllable input patterns
- [Sinks](#sinks) — Execution/exploitation points
- [Detection Heuristics](#detection-heuristics) — Pattern matching and grep patterns
- [Element-Specific Threats](#element-specific-threats) — Per-element sink risk
- [Payloads](#payloads) — Protocol-injection and redirect payloads
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
| `anchor.href` | High |
| `form.action` | High |
| `iframe.src` | High |
| `img.src` | High |
| `link.href` | High |
| `script.src` | High |
| `base.href` | High — hijacks all relative URLs on the page |

## Detection Heuristics

### Grep Patterns
```bash
# Dynamic URL attribute assignment
grep -nE '\.(href|src|action)\s*=|setAttribute\(' file.js

# <base> tag / base.href (hijacks all relative URLs on the page)
grep -niE 'createElement\(.{0,3}base|<base|\bbase\.href' file.js
```

## Element-Specific Threats

| Element | Attribute | Threat |
|---------|-----------|--------|
| `<a>` | `href` | `javascript:` URL executes in the current origin |
| `<script>` | `src` | Loads attacker's script — full compromise |
| `<iframe>` | `src` | Embeds attacker page — phishing / clickjacking |
| `<img>` | `src` | CSRF via GET, tracking pixel |
| `<link>` | `href` | CSS injection via external stylesheet |
| `<form>` | `action` | Exfiltrates form data to attacker |
| `<base>` | `href` | Hijacks relative URLs for all page resources |

**Relative Path Overwrite:** `element.href = '../../' + userInput` (path traversal); `element.src = '/' + userInput` (reaches unexpected endpoints).

## Payloads

```
javascript:alert(1)
data:text/html,<script>alert(1)</script>
data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==
vbscript:msgbox(1)
//evil.com
https://evil.com
```

## False Positives

| Pattern | Why FP | Verification |
|---------|--------|-------------|
| URL validated against a strict allowlist | Only approved destinations accepted | Confirm the allowlist check precedes the assignment |
| Relative path from a safe slug (no user-controlled protocol) | No `javascript:`/`data:`/`//` breakout possible | Verify input can't inject a scheme or `//` prefix |
| URL hardcoded from config | Not user-controlled | Trace source to a constant/config, not a request |

