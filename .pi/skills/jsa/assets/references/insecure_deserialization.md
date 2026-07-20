# Insecure Deserialization Reference Catalog

> **Search shortcuts:** `grep "^## Sources"` | `grep "^## Sinks"` | `grep "^## Detection"`

---

## Table of Contents
- [Sources](#sources) — User-controllable input patterns
- [Sinks](#sinks) — Execution/exploitation points
- [Detection Heuristics](#detection-heuristics) — Pattern matching and grep patterns
- [Scanners & Commands](#scanners--commands) — semgrep / tool invocations
- [Attack Vectors](#attack-vectors) — RCE techniques and gadget chains
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
| `new Function(userInput)` | High — code execution |
| `JSON.parse(data, reviver)` | Medium — prototype pollution / gadget surface via the reviver |

## Detection Heuristics

### Grep Patterns
```bash
# Deserialization / dynamic-code sinks
grep -nE 'unserialize\(|deserialize\(|yaml\.load\(|eval\(.*(JSON|\+)|new Function\(|node-serialize|serialize-javascript|\.fromJSON\(' file.js

# JSON.parse with a reviver (prototype-pollution / gadget surface)
grep -nE 'JSON\.parse\([^,]+,' file.js
```

## Scanners & Commands

```bash
# Semgrep — JS ruleset, JSON output for triage
semgrep --config p/javascript --json <file>
```

## Attack Vectors

| Sink | Technique |
|------|-----------|
| `eval('(' + userInput + ')')` | Direct code execution from the serialized string |
| `node-serialize.unserialize()` | RCE via a self-invoking function (IIFE) embedded in the object |
| `serialize-javascript` round-trip through `eval` | RCE when the attacker controls the serialized string |
| `js-yaml.load()` (unsafe/full schema) | `!!js/function` tag → RCE. **Only** js-yaml < 4 `load()` or an explicit `DEFAULT_FULL_SCHEMA`; js-yaml ≥ 4 `load()` is safe-by-default |
| `JSON.parse(userInput, reviver)` | Prototype pollution via a `__proto__` key handled in the reviver |

### Gadgets (deserializer that doesn't execute directly)
- Prototype pollution via a `__proto__` key in the parsed JSON
- Property access on the deserialized object reaching a vulnerable getter
- `toString()` / `valueOf()` invoked on the object during template rendering

## False Positives

| Pattern | Why FP | Verification |
|---------|--------|-------------|
| Safe parser used | `JSON.parse` without a reviver, `yaml.safeLoad` / js-yaml ≥ 4 `load` | Confirm no reviver and no unsafe schema |
| Input validated against a strict schema before deserialization | Structure/type constrained before use | Look for schema validation preceding the sink |
| Data from a trusted source | Internal service, not user input | Trace the source — not request/`postMessage`/`localStorage` |

