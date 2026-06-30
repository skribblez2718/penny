# HTTP Header Injection — Worker Analysis Prompt

> **Reference Catalog:** `assets/references/http_header_injection.md` — use `grep`/`read` to search, not full-file reads.



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
- `grep("^## Sources", "assets/references/http_header_injection.md")` — input patterns
- `grep("^## Sinks", "assets/references/http_header_injection.md")` — execution sinks
- `grep("^## Payloads", "assets/references/http_header_injection.md")` — test payloads
- `grep("^## Detection", "assets/references/http_header_injection.md")` — grep patterns for triage
- `grep("^## False Positives", "assets/references/http_header_injection.md")` — common FP patterns
- `read("assets/references/http_header_injection.md", limit=30)` then `read(..., offset=N)` for specific sections


## Mission

Find HTTP header injection: user input passed to `setRequestHeader`, cookie setting, or response header construction.

## Workflow

### 1. Find Header Operations
```bash
grep -nE "setRequestHeader\(|headers\[|headers\.set\(|document\.cookie\s*=|new Headers\(|res\.setHeader\(|res\.header\(" {file}
```

### 2. Key Vectors
**CRLF Injection:**
```javascript
xhr.setRequestHeader('X-Custom', userInput);
// userInput = "value\r\nX-Injected: malicious"
// → Injects a second header
```

**Cookie Injection:**
```javascript
document.cookie = 'session=' + userInput;
// userInput = "value; domain=.evil.com; path=/"
// → Cookie scoped to attacker's domain
```

**Response Header Injection (server-side JS):**
```javascript
res.setHeader('X-Custom', userInput);
// userInput = "value\r\nContent-Type: text/html\r\n\r\n<script>alert(1)</script>"
// → HTTP response splitting
```

### 3. Check for Validation
- Is `\r` or `\n` stripped from header values?
- Are cookies scoped with `; Secure; HttpOnly; SameSite`?
- Are custom headers validated against allowlists?

### Key Detection
```bash
grep -nE "setRequestHeader|headers\.set|document\.cookie|res\.setHeader|res\.header|res\.writeHead" {file}
```

### False Positives
- [ ] Header values are hardcoded or from server config (not user input)
- [ ] Newline characters are stripped before setting
- [ ] Cookie has Secure; HttpOnly; SameSite=Strict flags
