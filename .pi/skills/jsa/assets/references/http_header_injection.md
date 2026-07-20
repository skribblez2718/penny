# HTTP Header Injection Reference Catalog

> **Search shortcuts:** `grep "^## Sources"` | `grep "^## Sinks"` | `grep "^## Detection"`

---

## Table of Contents
- [Sources](#sources) — User-controllable input patterns
- [Sinks](#sinks) — Execution/exploitation points
- [Detection Heuristics](#detection-heuristics) — Pattern matching and grep patterns
- [Payloads](#payloads) — CRLF, response splitting, cookie-scope injection
- [False Positives](#false-positives) — Common misidentified patterns

---

## Sources

| Source | Pattern |
|--------|--------|
| `input.value` | User-controllable input |
| `location.search` | User-controllable input |
| `URLSearchParams` | User-controllable input |

## Sinks

| Sink | Risk |
|------|------|
| `document.cookie` | High |
| `headers.set()` | High |
| `res.setHeader()` | High |
| `xhr.setRequestHeader()` | High |
| `res.header()` | High |
| `res.writeHead()` | High — status + headers block |
| `new Headers()` | High |

## Detection Heuristics

### Grep Patterns
```bash
# Header-write sinks (client + server)
grep -nE 'setRequestHeader\(|headers\.(set|append)\(|new Headers\(|res\.(setHeader|header|writeHead)\(|document\.cookie\s*=' file.js
```

## Payloads

```
# CRLF header injection — inject a second header
value\r\nX-Injected: malicious

# HTTP response splitting (server-side res.setHeader / res.writeHead)
value\r\nContent-Type: text/html\r\n\r\n<script>alert(1)</script>

# Cookie scope hijack (document.cookie / Set-Cookie)
session=x; domain=.evil.com; path=/
```

## False Positives

| Pattern | Why FP | Verification |
|---------|--------|-------------|
| Header value hardcoded or from server config | Not user-controlled | Trace source to a constant/env, not a request |
| `\r`/`\n` stripped before the value is set | CRLF neutralized — no header/response splitting | Confirm the strip precedes the sink |
| Cookie set with `Secure; HttpOnly; SameSite` | Limits scope-hijack impact (does not fix CRLF) | Flags reduce impact; still check CRLF filtering |

