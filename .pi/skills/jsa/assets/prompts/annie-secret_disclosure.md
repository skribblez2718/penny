# Secret Disclosure — Worker Analysis Prompt

> **Reference Catalog:** `assets/references/secret_disclosure.md` — use `grep`/`read` to search, not full-file reads.



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
- `grep("^## Sources", "assets/references/secret_disclosure.md")` — input patterns
- `grep("^## Sinks", "assets/references/secret_disclosure.md")` — execution sinks
- `grep("^## Payloads", "assets/references/secret_disclosure.md")` — test payloads
- `grep("^## Detection", "assets/references/secret_disclosure.md")` — grep patterns for triage
- `grep("^## False Positives", "assets/references/secret_disclosure.md")` — common FP patterns
- `read("assets/references/secret_disclosure.md", limit=30)` then `read(..., offset=N)` for specific sections


## Mission

Find hardcoded secrets, API keys, tokens, credentials, and internal URLs in JavaScript source.

## Workflow

### 1. Run jsluice
```bash
jsluice secrets < {file}
jsluice urls < {file}
```

### 2. Run semgrep
```bash
semgrep --config p/secrets --json {file}
```

### 3. Manual Pattern Scan
```bash
grep -nEi "(api[_-]?key|apikey|secret|token|password|passwd|credential|private[_-]?key|access[_-]?key)\s*[:=]\s*['\"][^'\"]{8,}['\"]" {file}
grep -nEi "(AKIA[0-9A-Z]{16}|sk-[a-zA-Z0-9]{32,}|ghp_[a-zA-Z0-9]{36}|AIza[0-9A-Za-z\-_]{35}|SG\.[a-zA-Z0-9_-]{22,})" {file}
```

### 4. Classify by Risk
| Type | Examples | Risk |
|------|----------|------|
| **Production credentials** | AWS keys in source, DB passwords | CRITICAL |
| **Internal URLs** | staging.internal.example.com, 10.x.x.x IPs | HIGH |
| **Test/dev keys** | test_sk_xxx, dev-api-key | MEDIUM |
| **OAuth client IDs** | Public by design, but combined with secret | MEDIUM |
| **Source maps** | `.map` files exposing original source | MEDIUM |
| **Environment config** | `.env` contents in bundle | MEDIUM |

### 5. Context Analysis
- Is the key in a test file? → lower severity
- Is it in a comment? → still exposed in source
- Is it referenced from `process.env`? → check if .env is committed
- Is the file a vendor bundle? → may be third-party keys, still flag

### False Positives
- [ ] Placeholder values (`YOUR_API_KEY_HERE`, `xxxxxxxxxxxx`)
- [ ] Documentation examples with fake keys
- [ ] Public API endpoints (no auth needed)
- [ ] Client-safe config (public OAuth client ID, analytics tracking ID)
