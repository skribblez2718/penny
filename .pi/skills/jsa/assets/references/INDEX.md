# jsa Reference Catalog Index

> **For agents:** Each catalog below is lean — `read limit=30` for table of contents, `grep` for sections, `read offset=N` for detail.

## Vulnerability Class Catalogs

| File | Class | Key Patterns |
|------|-------|-------------|
| [dom_xss.md](dom_xss.md) | DOM XSS | `innerHTML`, `eval()`, `document.write`, `setTimeout(string)`, `location` sinks |
| [reflected_xss.md](reflected_xss.md) | Reflected XSS | Server reflection, `res.send()`, template engines, URL parameter sinks |
| [stored_xss.md](stored_xss.md) | Stored XSS | Database→render pipelines, rich text editors, markdown renderers |
| [prototype_pollution.md](prototype_pollution.md) | Prototype Pollution | `__proto__`, recursive merge, lodash, jQuery, AngularJS gadgets |
| [sqli.md](sqli.md) | SQL/NoSQL Injection | Raw query concatenation, ORM injection, MongoDB `$where`/`$ne` |
| [ssrf.md](ssrf.md) | SSRF | `fetch()`, `axios()`, `request()`, URL parsing bypasses, DNS rebinding |
| [csrf.md](csrf.md) | CSRF | Missing tokens, token validation bypass, SameSite cookie analysis |
| [cors.md](cors.md) | CORS | `Access-Control-Allow-Origin: *`, null origin, regex bypass |
| [postmessage.md](postmessage.md) | postMessage | Missing origin check, `event.data` sinks, `window.postMessage` |
| [open_redirect.md](open_redirect.md) | Open Redirect | `location.href`, `window.open`, URL parameter redirects |
| [secrets.md](secrets.md) | Secret Disclosure | AWS keys, GCP keys, Stripe, GitHub tokens, JWT secrets, entropy |
| [csti.md](csti.md) | Client-Side Template Injection | AngularJS `{{}}`, Vue `v-html`, template literal injection |
| [clickjacking.md](clickjacking.md) | Clickjacking | `X-Frame-Options`, CSP `frame-ancestors`, framebusting |
| [idor.md](idor.md) | IDOR | Sequential IDs, UUID prediction, missing ownership checks |
| [http_smuggling.md](http_smuggling.md) | HTTP Request Smuggling | TE/CL, CL/TE, `Transfer-Encoding` manipulation |
| [cache_poisoning.md](cache_poisoning.md) | Web Cache Poisoning | Unkeyed headers, `X-Forwarded-Host`, cache key manipulation |
| [insecure_deserialization.md](insecure_deserialization.md) | Insecure Deserialization | `eval()`, `new Function()`, `JSON.parse` with revivers, node-serialize |
| [dom_clobbering.md](dom_clobbering.md) | DOM Clobbering | Named element → variable collision, `form[name]`, `iframe[name]` |
| [request_override.md](request_override.md) | Request Override | `X-HTTP-Method-Override`, `X-HTTP-Method`, method tunneling |
| [link_manipulation.md](link_manipulation.md) | Link Manipulation | `javascript:` URIs, `data:` URIs, `<a>` href injection |
| [dom_data_manipulation.md](dom_data_manipulation.md) | DOM Data Manipulation | `localStorage`, `sessionStorage`, `document.cookie` injection |
| [http_header_injection.md](http_header_injection.md) | HTTP Header Injection | CRLF injection, `\r\n` in user input → response headers |

## Usage Pattern

```
1. read("assets/references/INDEX.md", limit=30)     → find catalog
2. read("assets/references/dom_xss.md", limit=30)   → table of contents
3. grep("Sinks", "assets/references/dom_xss.md")    → sink patterns (line numbers)
4. read("assets/references/dom_xss.md", offset=42)  → read specific section
```
