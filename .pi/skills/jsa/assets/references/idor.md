# Insecure Direct Object Reference Reference Catalog

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
| `/api/users/{id}` | User-controllable input |
| `/orders/{id}` | User-controllable input |
| `req.params.id` | User-controllable input |

## Sinks

| Sink | Risk |
|------|------|
| `MissingWHEREuser_id=?` | High |
| `Noownershipcheckinquery` | High |

## Detection Heuristics

### Grep Patterns
```bash

```

## False Positives

| Pattern | Why FP | Verification |
|---------|--------|-------------|
| TBD | Add idor-specific FP patterns | TBD |

