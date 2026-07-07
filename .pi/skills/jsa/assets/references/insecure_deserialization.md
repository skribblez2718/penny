# Insecure Deserialization Reference Catalog

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
| `JSON.parse(userInput)` | User-controllable input |
| `localStorage.getItem` | User-controllable input |

## Sinks

| Sink | Risk |
|------|------|
| `eval('('+data+')')` | High |
| `js-yaml.load()` | High |
| `node-serialize.unserialize()` | High |
| `serialize-javascript.deserialize()` | High |

## Detection Heuristics

### Grep Patterns
```bash

```

## False Positives

| Pattern | Why FP | Verification |
|---------|--------|-------------|
| TBD | Add insecure_deserialization-specific FP patterns | TBD |

