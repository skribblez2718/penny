# Secret Disclosure Reference Catalog

> **Search shortcuts:** `grep "^## Sources"` | `grep "^## Sinks"` | `grep "^## Detection"`

---

## Table of Contents
- [Sources](#sources) — User-controllable input patterns
- [Sinks](#sinks) — Execution/exploitation points
- [Detection Heuristics](#detection-heuristics) — Pattern matching and grep patterns
- [Scanners & Commands](#scanners--commands) — jsluice + semgrep invocations
- [Risk Classification](#risk-classification) — severity by secret type + context analysis
- [False Positives](#false-positives) — Common misidentified patterns

---

## Sources

_Pattern-based detection — not source→sink._

## Sinks

_See Detection Heuristics._

## Detection Heuristics

### Grep Patterns
```bash
# Generic key/secret assignments
grep -nEi "(api[_-]?key|apikey|secret|token|password|passwd|credential|private[_-]?key|access[_-]?key)\s*[:=]\s*['\"][^'\"]{8,}['\"]" {file}

# Known token formats (AWS, OpenAI, GitHub, Google, SendGrid)
grep -nEi "(AKIA[0-9A-Z]{16}|sk-[a-zA-Z0-9]{32,}|ghp_[a-zA-Z0-9]{36}|AIza[0-9A-Za-z\-_]{35}|SG\.[a-zA-Z0-9_-]{22,})" {file}
```

---

## Scanners & Commands

```bash
# jsluice — extract secrets and URLs from JS
jsluice secrets < {file}
jsluice urls < {file}

# semgrep — secrets ruleset
semgrep --config p/secrets --json {file}
```

---

## Risk Classification

| Type | Examples | Risk |
|------|----------|------|
| Production credentials | AWS keys in source, DB passwords | CRITICAL |
| Internal URLs | `staging.internal.example.com`, `10.x.x.x` IPs | HIGH |
| Test/dev keys | `test_sk_xxx`, `dev-api-key` | MEDIUM |
| OAuth client IDs | Public by design, but risky combined with a secret | MEDIUM |
| Source maps | `.map` files exposing original source | MEDIUM |
| Environment config | `.env` contents in bundle | MEDIUM |

### Context Analysis
- Key in a test file → lower severity
- Key in a comment → still exposed in source
- Referenced via `process.env` → check whether `.env` is committed
- Vendor bundle → may be third-party keys, still flag

---

## False Positives

| Pattern | Why FP | Verification |
|---------|--------|-------------|
| Placeholder values (`YOUR_API_KEY_HERE`, `xxxxxxxx`) | Not a real secret | Visual / pattern check |
| Documentation examples with fake keys | Non-functional sample | Check surrounding docs/comments |
| Public API endpoints (no auth needed) | Not sensitive | Confirm endpoint needs no credential |
| Client-safe config (public OAuth client ID, analytics tracking ID) | Designed to be public | Verify it is a public identifier |

