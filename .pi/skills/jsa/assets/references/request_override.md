# Request Override Reference Catalog

> **Search shortcuts:** `grep "^## Sources"` | `grep "^## Sinks"` | `grep "^## Detection"`

---

## Table of Contents
- [Sources](#sources) — User-controllable input patterns
- [Sinks](#sinks) — Execution/exploitation points
- [Detection Heuristics](#detection-heuristics) — Pattern matching and grep patterns
- [Attack Vectors](#attack-vectors) — Header-spoofing exploitation techniques
- [False Positives](#false-positives) — Common misidentified patterns

---

## Sources

| Source | Pattern |
|--------|--------|
| `X-Forwarded-For` | User-controllable input |
| `X-Forwarded-Host` | User-controllable input |
| `X-HTTP-Method-Override` | User-controllable input |
| `X-Original-URL` | User-controllable input |
| `X-Rewrite-URL` | User-controllable input |
| `X-Forwarded-Proto` | User-controllable input |
| `X-Forwarded-Path` | User-controllable input |

## Sinks

| Sink | Risk |
|------|------|
| `req.headers` | High |
| `req.get('x-...')` | High — reads override/forwarded header into routing/auth |
| `.method =` | High — HTTP method reassigned from an override header |

## Detection Heuristics

### Grep Patterns
```bash
# Request override / URL-rewrite / forwarded headers
grep -nE 'X-HTTP-Method(-Override)?|X-Forwarded-(For|Host|Proto|Path)|X-Original-URL|X-Rewrite-URL' file.js

# Server-side reads of these headers feeding routing/auth
grep -nE 'req\.headers\[|req\.get\(.*x-|\.method\s*=' file.js
```

## Attack Vectors

### HTTP Method Override
Server reads `X-HTTP-Method-Override` to override the real HTTP method:
```
POST /delete-account
X-HTTP-Method-Override: GET
```
→ Bypasses CSRF protection that only guards non-GET methods.

### URL Rewriting Headers
Middleware that routes on these lets an attacker reach path-restricted routes:
```
X-Original-URL: /admin
X-Rewrite-URL: /admin
X-Forwarded-Path: /../admin
```

### X-Forwarded-For Spoofing
App trusts `X-Forwarded-For` for IP-based access control:
```
X-Forwarded-For: 127.0.0.1
```
→ Spoofs a trusted loopback/internal IP, bypassing IP allowlists.

## False Positives

| Pattern | Why FP | Verification |
|---------|--------|-------------|
| Reverse proxy strips/normalizes these headers | Trusted proxy overwrites client-supplied values before the app | Confirm proxy config strips `X-Forwarded-*` / `X-Original-URL` |
| Header value checked against an allowlist | Only known-good values accepted | Look for allowlist validation next to the read |
| Header used only for logging | Not consumed by routing/auth/access control | Trace the value — dead-ends in a logger, not a decision |

