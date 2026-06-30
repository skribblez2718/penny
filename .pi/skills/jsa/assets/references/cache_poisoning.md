# Web Cache Poisoning Reference Catalog

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
| `User-Agent` | User-controllable input |
| `X-Forwarded-Host` | User-controllable input |
| `X-Forwarded-Scheme` | User-controllable input |

## Sinks

| Sink | Risk |
|------|------|
| `ReflectedincacheableresponsewithoutVaryheader` | High |

## Detection Heuristics

### Grep Patterns
```bash

```

## False Positives

| Pattern | Why FP | Verification |
|---------|--------|-------------|
| TBD | Add cache_poisoning-specific FP patterns | TBD |

