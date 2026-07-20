# Web Cache Poisoning Reference Catalog

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
| `User-Agent` | User-controllable input |
| `X-Forwarded-Host` | User-controllable input |
| `X-Forwarded-Scheme` | User-controllable input |
| `X-Forwarded-Port` | User-controllable input |
| `X-Original-URL` | User-controllable input |
| `Cookie (unkeyed)` | User-controllable input |
| `Query params not in cache key` | User-controllable input |

## Sinks

| Sink | Risk |
|------|------|
| `ReflectedincacheableresponsewithoutVaryheader` | High |

## Detection Heuristics

### Grep Patterns
```bash
# Cacheable-response markers
grep -nE "Cache-Control|X-Cache|Vary|ETag|Last-Modified|max-age|s-maxage" {file}
# Unkeyed header inputs + cache markers
grep -nE "X-Forwarded-Host|X-Forwarded-Scheme|X-Forwarded-Port|Vary:|Cache-Control|X-Cache" {file}
```

- **Unkeyed inputs:** the cache key is usually URL path + Host + method; everything else
  (`X-Forwarded-*`, `User-Agent`, some cookies, off-key query params) is unkeyed. If reflected
  into a cacheable response it poisons the entry for every user.

## Payloads

- **Fat GET poisoning** — send a GET with a body carrying a second query string; some caches
  key on the URL query while the origin uses the body's:
  ```
  GET /page?param=innocent HTTP/1.1
  Host: victim.com
  Content-Length: 50

  GET /page?param=evil HTTP/1.1
  ```
- **Cache key injection** — `X-Original-URL: /path` may be stored under `/path` but served as
  the response for `/`.

## False Positives

| Pattern | Why FP | Verification |
|---------|--------|-------------|
| `Vary` includes all user-controlled inputs | Cache keyed on those inputs — no cross-user poisoning | Confirm every reflected header is listed in `Vary` |
| No cache proxy in front of the app | Nothing to poison | Check for `X-Cache`/`Age`/CDN response headers |
| Response is not cacheable (`no-store`, `private`) | Not stored | Confirm `Cache-Control` on the poisonable response |

