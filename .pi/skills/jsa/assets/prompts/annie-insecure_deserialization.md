# Insecure Deserialization — Analysis Reference

> **Reference Catalog:** `assets/references/insecure_deserialization.md` — use `grep`/`read` to search, not full-file reads.



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
- `grep("^## Sources", "assets/references/insecure_deserialization.md")` — input patterns
- `grep("^## Sinks", "assets/references/insecure_deserialization.md")` — execution sinks
- `grep("^## Payloads", "assets/references/insecure_deserialization.md")` — test payloads
- `grep("^## Detection", "assets/references/insecure_deserialization.md")` — grep patterns for triage
- `grep("^## False Positives", "assets/references/insecure_deserialization.md")` — common FP patterns
- `read("assets/references/insecure_deserialization.md", limit=30)` then `read(..., offset=N)` for specific sections


## Mission

Find insecure deserialization: user-controlled data deserialized into executable objects.

## Workflow

### 1. Find Deserialization Calls
```bash
grep -nE "JSON\.parse\(.*user|eval\(.*JSON|new Function\(.*JSON|serialize|unserialize|deserialize|fromJSON|\.parse\(|yaml\.load\(|js-yaml" {file}
```

### 2. Key Vectors
**eval-based deserialization:**
```javascript
const obj = eval('(' + userInput + ')');  // Code execution
```

**node-serialize:**
```javascript
const serialize = require('node-serialize');
const obj = serialize.unserialize(userInput);  // RCE via IIFE
```

**js-yaml unsafe load:**
```javascript
const yaml = require('js-yaml');
const obj = yaml.load(userInput);  // RCE via !!js/function tag
```

**JSON.parse with reviver:**
```javascript
JSON.parse(userInput, (key, value) => {
  if (key === '__proto__') ...  // Prototype pollution via reviver
});
```

**serialize-javascript:**
```javascript
const serialize = require('serialize-javascript');
eval('(' + serialize.deserialize(userInput) + ')');  // RCE if user controls the serialized string
```

### 3. Check for Gadgets
Even if the deserializer doesn't directly execute code, the deserialized object may trigger gadgets:
- Prototype pollution via `__proto__` key in JSON
- Property access on deserialized object reaching vulnerable getters
- `toString()` / `valueOf()` called on deserialized object in template rendering

### Key Detection
```bash
semgrep --config p/javascript --json {file}
grep -nE "unserialize|deserialize|yaml\.load|eval\(.*JSON|new Function|serialize-javascript|node-serialize" {file}
```

### False Positives
- [ ] Deserialization uses safe parser (`JSON.parse` without reviver, `yaml.safeLoad`)
- [ ] Input is validated against a strict schema before deserialization
- [ ] Deserialized data is from trusted source (internal service, not user input)
