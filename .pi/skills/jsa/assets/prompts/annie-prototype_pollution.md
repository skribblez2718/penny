# Prototype Pollution — Analysis Reference

> **Reference Catalog:** `assets/references/prototype_pollution.md` — use `grep`/`read` to search, not full-file reads.



## Lane

**Lane:** `code_static`
**Packet type:** flow_card (with source/sink/sanitizer, ~50-200 lines of code)
**Tools to use:**
- **Joern queries** (when available): scripts/joern_queries/{vuln_class}.sc
- **tree-sitter queries** for source/sink matching
- **semgrep** for pattern validation

This declaration tells INVESTIGATE phase how to route and packetize work items
for this analyzer. See `resources/reference.md` for lane semantics.

## Reference Catalog Usage
Before and during analysis, consult the reference catalog for patterns:
- `grep("^## Sources", "assets/references/prototype_pollution.md")` — input patterns
- `grep("^## Sinks", "assets/references/prototype_pollution.md")` — execution sinks
- `grep("^## Payloads", "assets/references/prototype_pollution.md")` — test payloads
- `grep("^## Detection", "assets/references/prototype_pollution.md")` — grep patterns for triage
- `grep("^## False Positives", "assets/references/prototype_pollution.md")` — common FP patterns
- `read("assets/references/prototype_pollution.md", limit=30)` then `read(..., offset=N)` for specific sections

> Full reference catalog: `research/jsa/analyze-prototype_pollution.md`

## Mission

Analyze the code for Prototype Pollution vulnerabilities. Trace user-controlled input into object merge/extend operations that can pollute `Object.prototype`.

## Analysis Workflow

### Step 1: Find Merge Operations (Fast)
These functions are the attack surface — they copy properties from user input to objects:
```bash
grep -nE "Object\.assign|\.extend\(|\.merge\(|\.defaults\(|\.defaultsDeep\(|\{\s*\.\.\.|__proto__|constructor\.prototype" {file}
```

**Framework-specific:**
- jQuery: `$.extend(true, ...)`, `$.fn.extend`
- lodash: `_.merge`, `_.defaultsDeep`, `_.set`, `_.setWith`
- Underscore: `_.extend`
- AngularJS: `angular.merge`
- Express: `req.query`, `req.body` merged into options
- GraphQL: field resolvers merged with user input

### Step 2: Trace User Input to Merge
For each merge operation, check if ANY of the source objects contain user input:
```
location.search, location.hash, location.href, 
document.cookie, localStorage.getItem,
req.query, req.body, req.params (Node.js/Express),
event.data (postMessage), URLSearchParams
```

### Step 3: Check for Pollution Gadgets
If the prototype CAN be polluted, look for gadgets that read from it. A gadget makes the pollution exploitable:

**jQuery HTML gadget (CRITICAL — all versions):**
```javascript
// If Object.prototype.div is polluted to ['1', '<img src onerror=alert(1)>']
// Then $('<div/>') triggers the gadget
```

**lodash template gadget:**
```javascript
// Polluted Object.prototype.sourceURL triggers code execution in _.template()
```

**Express middleware gadget:**
```javascript
// Polluted Object.prototype.env triggers NODE_ENV change
```

**General gadget pattern — any property access on {}:**
```javascript
// for (key in obj) iterates polluted properties
// obj.hasOwnProperty(key) bypass if hasOwnProperty is polluted
// Object.keys() is SAFE (only own enumerable)
```

### Step 4: Determine Severity
| Vector | Severity |
|--------|----------|
| Prototype pollution → DOM XSS (jQuery gadget) | CRITICAL |
| Prototype pollution → RCE (Node.js, lodash template) | CRITICAL |
| Prototype pollution → auth bypass (Express middleware) | HIGH |
| Prototype pollution → DoS (infinite loops, exceptions) | MEDIUM |
| Prototype pollution with no gadget found | POSSIBLE (gadget may exist in other code) |

### Step 5: Run Scanners
```bash
semgrep --config p/javascript --config p/owasp-top-ten --json {file}
```
Custom scanner: `prototype_pollution_scanner.py` (AST-level `__proto__` / `constructor.prototype` assignment detection)

## Quick False Positive Checks
- [ ] Merge source is server-controlled, not user input
- [ ] Merge target has `Object.create(null)` — no prototype chain
- [ ] Code uses `Object.freeze(Object.prototype)` before merge
- [ ] Merge is inside a test file or build script
- [ ] `hasOwnProperty` check is used on every key access — still flag (can be clobbered!)

## Key Detection Signatures
```
AST patterns to flag:
- AssignmentExpression with left side = MemberExpression[property="__proto__"]
- AssignmentExpression with left side = MemberExpression[property="constructor"][property="prototype"]
- CallExpression[function="extend" or "merge" or "assign"] with user-controlled argument
- SpreadElement inside ObjectExpression where spread source is user-controlled
```
