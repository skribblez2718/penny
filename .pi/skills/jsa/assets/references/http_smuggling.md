# HTTP Request Smuggling Reference Catalog

> **Search shortcuts:** `grep "^## Sources"` | `grep "^## Sinks"` | `grep "^## Detection"`

---

## Table of Contents
- [Sources](#sources) — User-controllable input patterns
- [Sinks](#sinks) — Execution/exploitation points
- [Detection Heuristics](#detection-heuristics) — Pattern matching and grep patterns
- [Payloads](#payloads) — Test payloads and exploit conditions
- [False Positives](#false-positives) — Common misidentified patterns

---

## Sources

| Source | Pattern |
|--------|--------|
| `Content-Length headers` | User-controllable input |
| `Transfer-Encoding` | User-controllable input |

## Sinks

| Sink | Risk |
|------|------|
| `CL.TE` | High |
| `Proxyvsbackendparsingmismatch` | High |
| `TE.CL` | High |
| `TE.TE` | High |

## Detection Heuristics

### Grep Patterns
```bash
# Proxy/CDN layers + framing headers (smuggling needs a parser mismatch)
grep -nE "proxy|nginx|haproxy|cloudfront|cloudflare|fastly|akamai|transfer.encoding|content.length|keep.alive" {file}
```

- Smuggling requires **two parsers** (frontend proxy/CDN + backend) disagreeing on where a
  request ends. Look for code that manually sets `Content-Length` or `Transfer-Encoding`
  alongside a user-controlled body.

## Payloads

- **CL.TE** — frontend uses `Content-Length`, backend uses `Transfer-Encoding` → smuggled prefix.
- **TE.CL** — frontend uses `Transfer-Encoding`, backend uses `Content-Length`.
- **TE.TE** — both use `Transfer-Encoding`; obfuscate one copy so a single parser ignores it:
  ```
  Transfer-Encoding: chunked
  Transfer-Encoding: xchunked      # obfuscated value
  Transfer-Encoding : chunked      # space before the colon
  Transfer-Encoding: chunked<SP>   # trailing whitespace
  ```
- **Client-side desync** — browser `fetch()` carrying both framing headers:
  ```javascript
  fetch('/api', { method: 'POST',
    headers: { 'Content-Length': '0', 'Transfer-Encoding': 'chunked' },
    body: '0\r\n\r\nSMUGGLED' });
  ```
- **HTTP/2 downgrade** — an H2→H1.1 downgrade at the proxy can inject smuggling when headers
  don't map cleanly.

## False Positives

| Pattern | Why FP | Verification |
|---------|--------|-------------|
| Single-layer architecture (no proxy/LB) | Needs a frontend/backend parser pair | Confirm there is a CDN/proxy hop |
| HTTP/2 end-to-end (no downgrade) | H2 length-prefixed framing resists CL/TE desync | Verify there is no H2→H1 downgrade |
| `Content-Length` set by framework, not manually | Framework keeps CL/TE consistent | Check for manual header writes alongside a user body |

