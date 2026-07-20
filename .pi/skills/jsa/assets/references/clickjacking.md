# Clickjacking Reference Catalog

> **Search shortcuts:** `grep "^## Sources"` | `grep "^## Sinks"` | `grep "^## Detection"`

---

## Table of Contents
- [Sources](#sources) — User-controllable input patterns
- [Sinks](#sinks) — Execution/exploitation points
- [Detection Heuristics](#detection-heuristics) — Pattern matching and grep patterns
- [Payloads](#payloads) — Framing techniques and bypasses
- [False Positives](#false-positives) — Common misidentified patterns

---

## Sources

| Source | Pattern |
|--------|--------|
| `CSP frame-ancestors missing` | User-controllable input |
| `X-Frame-Options missing` | User-controllable input |

## Sinks

| Sink | Risk |
|------|------|
| `Framablepagewithsensitiveactions` | High |

## Detection Heuristics

### Grep Patterns
```bash
# Frame protection headers + frame-busting scripts
grep -nE "X-Frame-Options|frame-ancestors|frame.bust|framebuster|top\.location" {file}
# Frame-busting script variants
grep -nE "top\.location|top\.self|self\.location|window\.top|framebuster|frame.buster|if \(top !== self\)|if \(window !== top\)" {file}
```

- **Only CSP `frame-ancestors` reliably restricts framing.** `X-Frame-Options: DENY`/`SAMEORIGIN` are honored, but **`X-Frame-Options: ALLOW-FROM <uri>` is NOT reliable** — Chrome never honored it and Firefox dropped it. Treat a page that relies on `ALLOW-FROM` with no CSP `frame-ancestors` as framable/vulnerable.

## Payloads

- **Double-clickjacking** — overlay two transparent iframes; the victim believes they click
  one element but actually clicks another underneath.
- **Frame-busting bypasses** (when a page relies on JS instead of headers):
  - `sandbox="allow-forms"` (without `allow-scripts`) on the attacker iframe disables
    frame-busting scripts.
  - An `onbeforeunload` handler on the attacker page cancels frame-buster redirects.

## False Positives

| Pattern | Why FP | Verification |
|---------|--------|-------------|
| `X-Frame-Options: DENY` or `SAMEORIGIN` present | Framing blocked by browser | Confirm header on the sensitive page, not just the homepage |
| CSP `frame-ancestors 'none'` or `'self'` present | Reliable anti-framing | Confirm directive covers the sensitive route |
| Page has no sensitive/state-changing actions | Nothing to hijack | Confirm content is static/informational only |

