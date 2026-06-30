# CSTI — Worker Analysis Prompt

> **Reference Catalog:** `assets/references/csti.md` — use `grep`/`read` to search, not full-file reads.



## Lane (Phase D)

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
- `grep("^## Sources", "assets/references/csti.md")` — input patterns
- `grep("^## Sinks", "assets/references/csti.md")` — execution sinks
- `grep("^## Payloads", "assets/references/csti.md")` — test payloads
- `grep("^## Detection", "assets/references/csti.md")` — grep patterns for triage
- `grep("^## False Positives", "assets/references/csti.md")` — common FP patterns
- `read("assets/references/csti.md", limit=30)` then `read(..., offset=N)` for specific sections


## Mission

Find client-side template injection: user input interpolated into template expressions evaluated by framework template engines.

## Workflow

### 1. Find Template Usage
```bash
grep -nE "angular\.module|ng-app|ng-controller|\{\{.*\}\}|v-html|\$\{.*\}|Handlebars\.compile|Mustache\.render|ejs\.render|_.template\(|Vue\.compile" {file}
```

### 2. Identify Injection Points
**AngularJS (1.x):** `{{constructor.constructor('alert(1)')()}}` in any expression
**Vue.js:** `v-html` with user input, `{{ }}` in templates compiled at runtime with user input
**Handlebars/Mustache/ejs:** `.compile(userTemplate)` or `.render(userTemplate)` where user controls the template STRING (not just the data)
**lodash _.template:** `_.template(userInput)` — template string from user
**Template literals:** `` eval(`var x = "${userInput}"`) `` — string break-out possible

### 3. Check Sandbox Status
- AngularJS: sandbox removed in 1.6+ — expression injection always exploitable
- Vue.js: no sandbox for v-html — direct HTML execution
- Handlebars: limited expression syntax, but custom helpers may be dangerous
- ejs: full JS execution in `<% %>` tags — template injection = RCE

### 4. Key Detection
```bash
semgrep --config p/javascript --json {file}
```
Flag: any `.compile()`, `.render()`, `.template()` call where the first argument traces to user input.

### False Positives
- [ ] Template is a static string literal, not from user input
- [ ] Template is pre-compiled at build time (webpack/rollup), not runtime
- [ ] Vue template is in `.vue` single-file component (compile-time, not runtime)
