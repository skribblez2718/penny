# Clickjacking Reference Catalog

> **Search shortcuts:** `grep "^## Sources"` | `grep "^## Sinks"` | `grep "^## Detection"`

---

## Table of Contents
- [Sources](#sources) — User-controllable input patterns
- [Sinks](#sinks) — Execution/exploitation points
- [Detection Heuristics](#detection-heuristics) — Pattern matching and grep patterns
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

```

## False Positives

| Pattern | Why FP | Verification |
|---------|--------|-------------|
| TBD | Add clickjacking-specific FP patterns | TBD |

