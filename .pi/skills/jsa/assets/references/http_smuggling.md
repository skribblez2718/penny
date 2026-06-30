# HTTP Request Smuggling Reference Catalog

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
| `Content-Length headers` | User-controllable input |
| `Transfer-Encoding` | User-controllable input |

## Sinks

| Sink | Risk |
|------|------|
| `CL.TE` | High |
| `Proxyvsbackendparsingmismatch` | High |
| `TE.CL` | High |
| `TE.TE` | High |

## Detection Heuristics

### Grep Patterns
```bash

```

## False Positives

| Pattern | Why FP | Verification |
|---------|--------|-------------|
| TBD | Add http_smuggling-specific FP patterns | TBD |

