# Client-Side Template Injection Reference Catalog

> **Search shortcuts:** `grep "^## Sources"` | `grep "^## Sinks"` | `grep "^## Detection"`

---

## Table of Contents
- [Sources](#sources) — User-controllable input patterns
- [Sinks](#sinks) — Execution/exploitation points
- [Detection Heuristics](#detection-heuristics) — Pattern matching and grep patterns
- [Injection Points](#injection-points) — Per-framework injection where user controls the template string
- [Sandbox Status](#sandbox-status) — Engine sandbox state and impact
- [Scanners & Commands](#scanners--commands) — semgrep + first-arg heuristic
- [False Positives](#false-positives) — Common misidentified patterns

---

## Sources

| Source | Pattern |
|--------|--------|
| `localStorage.getItem` | User-controllable input |
| `location.search` | User-controllable input |
| `URLSearchParams` | User-controllable input |

## Sinks

| Sink | Risk |
|------|------|
| `ejs.render()` | High |
| `Handlebars.compile()` | High |
| `Mustache.render()` | High |
| `_.template()` | High |
| `templateliteral${}` | High |
| `eval()` with template-literal `${userInput}` break-out | High |
| `Vue.compile()` | High |
| `v-html` (Vue, user input) | High |
| AngularJS `{{ }}` expression (1.x) | High |
| `ng-app` / `ng-controller` scope | Medium |

## Detection Heuristics

### Grep Patterns
```bash
grep -nE "angular\.module|ng-app|ng-controller|\{\{.*\}\}|v-html|\$\{.*\}|Handlebars\.compile|Mustache\.render|ejs\.render|_\.template\(|Vue\.compile" {file}
```

---

## Injection Points

Injection requires the user to control the template STRING (not just the data bound into it):

- **AngularJS (1.x):** `{{constructor.constructor('alert(1)')()}}` in any interpolated expression
- **Vue.js:** `v-html` with user input; runtime-compiled `{{ }}` templates fed user input
- **Handlebars / Mustache / ejs:** `.compile(userTemplate)` / `.render(userTemplate)` where the user controls the template string
- **lodash `_.template`:** `_.template(userInput)` — template string from user
- **Template literals:** `` eval(`var x = "${userInput}"`) `` — string break-out possible

---

## Sandbox Status

| Engine | Sandbox | Impact |
|--------|---------|--------|
| AngularJS | Sandbox **removed in 1.6+** | Expression injection always exploitable |
| Vue.js | No sandbox for `v-html` | Direct HTML/JS execution |
| Handlebars | Limited expression syntax | Custom helpers may be dangerous |
| ejs | Full JS in `<% %>` tags | Template injection = RCE |

---

## Scanners & Commands

```bash
# semgrep
semgrep --config p/javascript --json {file}
```
Heuristic: flag any `.compile()`, `.render()`, or `.template()` call whose FIRST argument traces to user input (user controls the template, not just the data).

---

## False Positives

| Pattern | Why FP | Verification |
|---------|--------|-------------|
| Template is a static string literal, not from user input | Template string is constant | Trace the first arg of compile/render/template |
| Template pre-compiled at build time (webpack/rollup) | Not runtime-compiled | Check build config; no runtime `.compile()` call |
| Vue template in a `.vue` single-file component | Compile-time, not runtime | Confirm template is in the SFC, not a runtime string |

