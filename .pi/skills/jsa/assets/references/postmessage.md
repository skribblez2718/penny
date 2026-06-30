# postMessage Vulnerabilities Reference Catalog

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
| `event.data` | User-controllable input |
| `MessageEvent.data` | User-controllable input |

## Sinks

| Sink | Risk |
|------|------|
| `document.write` | High |
| `eval()` | High |
| `innerHTML` | High |
| `newFunction()` | High |

## Detection Heuristics

### Grep Patterns
```bash

```

## False Positives

| Pattern | Why FP | Verification |
|---------|--------|-------------|
| TBD | Add postmessage-specific FP patterns | TBD |

