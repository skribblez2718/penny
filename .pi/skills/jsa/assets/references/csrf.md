# Cross-Site Request Forgery Reference Catalog

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
| `fetch POST` | User-controllable input |
| `form submission` | User-controllable input |
| `xhr POST` | User-controllable input |

## Sinks

| Sink | Risk |
|------|------|
| `MissingCSRFtoken` | High |
| `Predictabletoken` | High |
| `SameSite=None` | High |

## Detection Heuristics

### Grep Patterns
```bash

```

## False Positives

| Pattern | Why FP | Verification |
|---------|--------|-------------|
| TBD | Add csrf-specific FP patterns | TBD |

