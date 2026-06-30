# DOM Data Manipulation — Worker Analysis Prompt

> **Reference Catalog:** `assets/references/dom_data_manipulation.md` — use `grep`/`read` to search, not full-file reads.



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
- `grep("^## Sources", "assets/references/dom_data_manipulation.md")` — input patterns
- `grep("^## Sinks", "assets/references/dom_data_manipulation.md")` — execution sinks
- `grep("^## Payloads", "assets/references/dom_data_manipulation.md")` — test payloads
- `grep("^## Detection", "assets/references/dom_data_manipulation.md")` — grep patterns for triage
- `grep("^## False Positives", "assets/references/dom_data_manipulation.md")` — common FP patterns
- `read("assets/references/dom_data_manipulation.md", limit=30)` then `read(..., offset=N)` for specific sections


## Mission

Find DOM manipulation that alters security-sensitive elements: forms, iframes, scripts, links modified via user-controlled data.

## Workflow

### 1. Find Security-Sensitive DOM Modifications
```bash
grep -nE "\.innerHTML\s*=|\.outerHTML\s*=|\.textContent\s*=|insertAdjacentHTML|appendChild|removeChild|replaceChild|\.style\.|\.classList\.|setAttribute|removeAttribute" {file}
```

### 2. Identify Sensitive Targets
When user input controls which element is modified or what it's modified to:
- **Form manipulation**: Changing `form.action`, adding hidden inputs, removing CSRF tokens
- **Iframe manipulation**: Changing `iframe.src` or `iframe.srcdoc` to attacker content
- **Script manipulation**: Creating `<script>` elements with attacker-controlled `src` or `textContent`
- **Link manipulation**: Changing redirect URLs, removing `rel="noopener"`
- **Style manipulation**: CSS injection via `style.cssText` or `setAttribute('style')`

### 3. Multi-Step Chains
```
1. DOM clobbering → variable check bypassed
2. → Element modified to attacker-controlled value
3. → Security-sensitive attribute changed (form.action to evil.com)
4. → User submits form → data exfiltrated to attacker
```

### Key Detection
Look for patterns where:
- User input controls WHICH element is selected (`document.getElementById(userInput)`)
- User input controls WHAT attribute is set (`element.setAttribute(userKey, userValue)`)
- User input controls the new value of a security-sensitive attribute

### False Positives
- [ ] Only visual/presentation attributes changed (color, font-size, not action/src/href)
- [ ] Element selection is from a hardcoded allowlist
- [ ] Attribute name is hardcoded (only value is user-controlled — check value validation)
