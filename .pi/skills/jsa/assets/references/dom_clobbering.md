# DOM Clobbering Reference Catalog

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
| `HTML elements with id/name` | User-controllable input |

## Sinks

| Sink | Risk |
|------|------|
| `globalvariablechecks` | High |
| `if(!var)checks` | High |
| `typeofchecks` | High |

## Detection Heuristics

### Grep Patterns
```bash

```

## False Positives

| Pattern | Why FP | Verification |
|---------|--------|-------------|
| TBD | Add dom_clobbering-specific FP patterns | TBD |

