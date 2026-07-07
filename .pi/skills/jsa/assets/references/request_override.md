# Request Override Reference Catalog

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
| `X-Forwarded-For` | User-controllable input |
| `X-Forwarded-Host` | User-controllable input |
| `X-HTTP-Method-Override` | User-controllable input |
| `X-Original-URL` | User-controllable input |
| `X-Rewrite-URL` | User-controllable input |

## Sinks

| Sink | Risk |
|------|------|
| `req.headers` | High |

## Detection Heuristics

### Grep Patterns
```bash

```

## False Positives

| Pattern | Why FP | Verification |
|---------|--------|-------------|
| TBD | Add request_override-specific FP patterns | TBD |

