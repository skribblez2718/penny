# Open Redirect Reference Catalog

> **Search shortcuts:** `grep "^## Sources"` | `grep "^## Sinks"` | `grep "^## Detection"`

---

## Table of Contents
- [Sources](#sources) — User-controllable input patterns
- [Sinks](#sinks) — Execution/exploitation points
- [Detection Heuristics](#detection-heuristics) — Pattern matching and grep patterns
- [Validation Patterns](#validation-patterns) — vulnerable / weak / safe redirect validation
- [Payloads](#payloads) — Redirect bypass payloads
- [Multi-Step Chains](#multi-step-chains) — OAuth redirect_uri abuse
- [False Positives](#false-positives) — Common misidentified patterns

---

## Sources

| Source | Pattern |
|--------|--------|
| `event.data` | User-controllable input |
| `location.search` | User-controllable input |
| `location.hash` | User-controllable input |
| `URLSearchParams` | User-controllable input |
| `localStorage.getItem` | User-controllable input |
| `document.referrer` | User-controllable input |
| `fetch` response body | User-controllable input |

## Sinks

| Sink | Risk |
|------|------|
| `anchor.href` | High |
| `location.assign()` | High |
| `location.href=` | High |
| `location.replace()` | High |
| `window.open()` | High |
| `element.src=` (iframe/script/img) | Medium |
| `form.action=` | Medium |

## Detection Heuristics

### Grep Patterns
```bash
grep -nE "location\.href\s*=|location\.replace\(|location\.assign\(|window\.open\(|\.href\s*=|\.src\s*=|\.action\s*=" {file}
```

---

## Validation Patterns

**VULNERABLE — no validation:**
```javascript
location.href = params.get('redirect');
```

**WEAK — bypassable:**
```javascript
url.startsWith('/')                  // //evil.com bypasses (protocol-relative)
url.startsWith('https://')           // https://evil.com is allowed
!url.includes('//')                  // java%0d%0ascript: bypasses
new URL(url).hostname === 'trusted'  // @ confusion: https://trusted@evil.com
```

**SAFE — relative-only or exact-match whitelist:**
```javascript
url.startsWith('/') && !url.includes('//')
const ALLOWED = ['/', '/dashboard', '/settings']; ALLOWED.includes(url)
```

---

## Payloads

```
//evil.com
https://evil.com
java%0d%0ascript:alert(1)
data:text/html,<script>alert(1)</script>
\/\/evil.com             (backslash bypass)
https:evil.com           (no-slash scheme)
https://trusted@evil.com (userinfo confusion)
```

---

## Multi-Step Chains

**OAuth redirect_uri abuse:** `/oauth/authorize?redirect_uri=https://evil.com` → user approves → redirected to `evil.com` carrying the auth code (→ account takeover).

---

## False Positives

| Pattern | Why FP | Verification |
|---------|--------|-------------|
| URL is hardcoded, not from user input | No user data flow | Trace the redirect argument |
| URL validated against a strict whitelist | Allowlist enforced | Confirm exact-match allowlist |
| URL built from a base path + safe slug | No protocol injection possible | Verify no user-controlled scheme/host |

