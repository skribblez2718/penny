# CORS Misconfiguration Reference Catalog

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
| `Origin header` | User-controllable input |

## Sinks

| Sink | Risk |
|------|------|
| `Access-Control-Allow-Origin:*` | High |
| `Access-Control-Allow-Origin:null` | High |
| `Allow-Credentials:true+wildcard` | High |
| `ReflectedOrigin` | High |

## Detection Heuristics

### Grep Patterns
```bash
grep -nE "Access-Control|cors|CORS|cross.origin|crossOrigin" {file}
```

- Check the **pre-flight** (OPTIONS) response too: `Access-Control-Allow-Methods: *`, `Access-Control-Allow-Headers: *` or including `Authorization`, and an excessively long `Access-Control-Max-Age`.
- `Access-Control-Allow-Credentials: true` with a **reflected** origin lets that origin read authenticated responses (high severity). With a literal `*` wildcard it is invalid per spec and browsers reject the combination — still flag it, some non-browser clients mishandle it.

## Payloads

**Reflected origin** — send an off-origin `Origin`, check it is echoed back:
```
Request:  Origin: https://evil.com
Response: Access-Control-Allow-Origin: https://evil.com
→ any origin can read the response (critical if Allow-Credentials: true)
```

**Null origin** — `Access-Control-Allow-Origin: null` is exploitable: a sandboxed iframe
(`<iframe sandbox="allow-scripts">`, origin = `null`) can read the response.

**Wildcard + credentials** — `Access-Control-Allow-Origin: *` with
`Access-Control-Allow-Credentials: true` is invalid per spec (browsers reject), but some
non-browser clients mishandle it — worth flagging.

## False Positives

| Pattern | Why FP | Verification |
|---------|--------|-------------|
| `Access-Control-Allow-Origin: *` on a public API with no credentials | Wildcard without credentials can't read authenticated data | Confirm no `Allow-Credentials: true` and no session cookies in scope |
| CORS restricted to specific trusted origins | Allowlist, not reflection | Verify the origin is not reflected verbatim from the request |
| `Vary: Origin` present | Response varies per origin (cache-safe) | Still confirm ACAO isn't blindly reflected |

