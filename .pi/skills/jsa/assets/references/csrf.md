# Cross-Site Request Forgery Reference Catalog

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
| `fetch POST` | User-controllable input |
| `form submission` | User-controllable input |
| `xhr POST` | User-controllable input |

## Sinks

| Sink | Risk |
|------|------|
| `MissingCSRFtoken` | High |
| `Predictabletoken` | High |
| `SameSite=None` | High |

## Detection Heuristics

### Grep Patterns
```bash
# State-changing operations
grep -nE "\.post\(|fetch\(.*POST|fetch\(.*PUT|fetch\(.*DELETE|\.submit\(|form\.action|axios\.post|axios\.put|axios\.delete" {file}
# Anti-CSRF tokens + SameSite
grep -nE "csrf|_token|authenticity_token|csrfmiddlewaretoken|X-CSRF|SameSite" {file}
```

- **Token names:** header `X-CSRF-Token`; params `_csrf`, `csrfmiddlewaretoken`,
  `authenticity_token`. Server-side validation can't be confirmed from client code — flag
  "needs verification". A **predictable** token (timestamp, sequential, or derived from the
  session cookie) is weak even when present.
- **SameSite semantics:** `Strict` = full protection; `Lax` = protected except top-level GET
  navigations; `None` = no protection (requires `Secure`); missing = browser-dependent (Chrome
  defaults to Lax, older browsers unprotected).

## Payloads

- **CSRF via GET** — a state change on GET is forgeable with a tag:
  `<img src="https://victim.com/delete-account">`.
- **JSON CSRF bypass** — if the endpoint also accepts `text/plain` or `x-www-form-urlencoded`,
  forge a JSON body via a form:
  ```html
  <form method="POST" action="https://victim.com/api/transfer" enctype="text/plain">
    <input name='{"amount":1000,"to":"attacker","ignore":"' value='"}'>
  </form>
  ```

## False Positives

| Pattern | Why FP | Verification |
|---------|--------|-------------|
| Request includes a validated CSRF token | Server rejects forged requests | Confirm the token is bound to the session and validated server-side |
| `SameSite=Strict` with no state-changing GET endpoints | Cross-site cookies not sent | Verify there are no state-changing GET routes |
| Idempotent request (GET, no side effects) | Nothing to forge | Confirm the operation changes no server state |
| Custom header required (`X-Requested-With: XMLHttpRequest`) | Cross-site JS can't set custom headers (partial) | Verify the server actually enforces the header |

