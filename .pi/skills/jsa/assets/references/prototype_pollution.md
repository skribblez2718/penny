# Prototype Pollution Reference Catalog

> **Search shortcuts:** `grep "^## Sources"` | `grep "^## Sinks"` | `grep "^## Detection"`

---

## Table of Contents
- [Sources](#sources) — User-controllable input patterns
- [Sinks](#sinks) — Execution/exploitation points
- [Detection Heuristics](#detection-heuristics) — Pattern matching, grep patterns, AST signatures
- [Gadgets](#gadgets) — Sinks that make pollution exploitable (jQuery, lodash, Express)
- [Multi-Step Chains](#multi-step-chains) — PP → DOM XSS / RCE / auth bypass / DoS
- [Scanners & Commands](#scanners--commands) — semgrep + AST scanner invocations
- [False Positives](#false-positives) — Common misidentified patterns

---

## Sources

| Source | Pattern |
|--------|--------|
| `JSON.parse(userInput)` | User-controllable input |
| `localStorage.getItem` | User-controllable input |
| `location.search` | User-controllable input |
| `location.hash` / `location.href` | User-controllable input |
| `document.cookie` | User-controllable input |
| `req.body` | User-controllable input |
| `req.query` / `req.params` (Express) | User-controllable input |
| `event.data` (postMessage) | User-controllable input |
| `URLSearchParams` | User-controllable input |

## Sinks

| Sink | Risk |
|------|------|
| `$.extend` | High |
| `$.extend(true, ...)` / `$.fn.extend` (jQuery deep merge) | High |
| `_.defaultsDeep` | High |
| `_.defaults` | High |
| `_.set` / `_.setWith` (lodash path assignment) | High |
| `for...inwithouthasOwnProperty` | High |
| `_.merge` | High |
| `Object.assign` | High |
| `angular.merge` | High |
| `__proto__` assignment | High |
| `constructor.prototype` assignment | High |
| `{ ...userInput }` spread into object | Medium |

## Detection Heuristics

### Grep Patterns
```bash
# Merge / assignment sinks (attack surface)
grep -nE "Object\.assign|\.extend\(|\.merge\(|\.defaults\(|\.defaultsDeep\(|_\.set(With)?\(|\{\s*\.\.\.|__proto__|constructor\.prototype" {file}

# User-controlled sources feeding a merge
grep -nE "location\.(search|hash|href)|document\.cookie|localStorage\.getItem|req\.(query|body|params)|event\.data|URLSearchParams" {file}
```

### AST Signatures
```
- AssignmentExpression, left = MemberExpression[property="__proto__"]
- AssignmentExpression, left = MemberExpression[property="constructor"][property="prototype"]
- CallExpression[callee="extend"|"merge"|"assign"] with a user-controlled argument
- SpreadElement inside ObjectExpression where the spread source is user-controlled
```

---

## Gadgets

Pollution is only exploitable if some code later READS the polluted property. A gadget makes it land:

| Gadget | Trigger |
|--------|---------|
| jQuery HTML gadget (all versions) | Polluted `Object.prototype.div` (e.g. `['1','<img src onerror=alert(1)>']`) → `$('<div/>')` executes it |
| lodash `_.template` gadget | Polluted `Object.prototype.sourceURL` → code execution inside `_.template()` |
| Express middleware gadget | Polluted `Object.prototype.env` → flips `NODE_ENV` / config behavior |
| Generic property-read gadget | `for (key in obj)` iterates polluted props; `obj.hasOwnProperty(key)` bypassable if `hasOwnProperty` is polluted. `Object.keys()` is SAFE (own enumerable only) |

---

## Multi-Step Chains

| Chain | Severity |
|-------|----------|
| Prototype pollution → DOM XSS (jQuery gadget) | CRITICAL |
| Prototype pollution → RCE (Node.js, lodash `_.template`) | CRITICAL |
| Prototype pollution → auth bypass (Express middleware) | HIGH |
| Prototype pollution → DoS (infinite loops, exceptions) | MEDIUM |
| Prototype pollution with no gadget found | POSSIBLE (gadget may live in other code) |

---

## Scanners & Commands

```bash
# semgrep
semgrep --config p/javascript --config p/owasp-top-ten --json {file}

# AST-level __proto__ / constructor.prototype assignment detection
python3 scripts/analyzers/prototype_pollution.py --file {file}
```

---

## False Positives

| Pattern | Why FP | Verification |
|---------|--------|-------------|
| Merge source is server-controlled, not user input | No attacker data flow | Trace every source object of the merge |
| Merge target created via `Object.create(null)` | No prototype chain to pollute | Confirm target has null prototype |
| `Object.freeze(Object.prototype)` before the merge | Prototype not writable | Check for freeze earlier in load order |
| Merge inside a test file or build script | Not attacker-reachable | Check file path / runtime context |
| `hasOwnProperty` check on every key access | Partial mitigation — STILL FLAG: `hasOwnProperty` itself can be clobbered | Verify guard cannot be polluted |

