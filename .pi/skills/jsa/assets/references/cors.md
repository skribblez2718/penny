# CORS Misconfiguration Reference Catalog

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
| `Origin header` | User-controllable input |

## Sinks

| Sink | Risk |
|------|------|
| `Access-Control-Allow-Origin:*` | High |
| `Access-Control-Allow-Origin:null` | High |
| `Allow-Credentials:true+wildcard` | High |
| `ReflectedOrigin` | High |

## Detection Heuristics

### Grep Patterns
```bash

```

## False Positives

| Pattern | Why FP | Verification |
|---------|--------|-------------|
| TBD | Add cors-specific FP patterns | TBD |

