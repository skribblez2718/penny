# Prototype Pollution Reference Catalog

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
| `JSON.parse(userInput)` | User-controllable input |
| `localStorage.getItem` | User-controllable input |
| `location.search` | User-controllable input |
| `req.body` | User-controllable input |

## Sinks

| Sink | Risk |
|------|------|
| `$.extend` | High |
| `_.defaultsDeep` | High |
| `for...inwithouthasOwnProperty` | High |
| `_.merge` | High |
| `Object.assign` | High |

## Detection Heuristics

### Grep Patterns
```bash

```

## False Positives

| Pattern | Why FP | Verification |
|---------|--------|-------------|
| TBD | Add prototype_pollution-specific FP patterns | TBD |

