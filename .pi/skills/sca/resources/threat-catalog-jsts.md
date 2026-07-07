<!--
════════════════════════════════════════════════════════════════════════════
MIGRATION NOTE (sca Phase 11) — migrated from the code-analysis bundle
(reference/threat-catalog-jsts.md).

This is a REFERENCE checklist consumed by P6_THREAT_MODEL, P8_TRIAGE, and
P9_DEEP_DIVE. It carried over faithfully; its Tier-1 (tool-findable) vs Tier-2
(AI/human-owned) split is exactly the division-of-labor philosophy the built
skill implements.

SCOPE CAVEAT (honesty): this catalogue is **JS / TS / React / Node specific**.
The built sca skill is deliberately **language-agnostic** ("deep security review
of a local, cloned source tree — any language", per SKILL.md). So this file is
ONE language ecosystem's threat catalogue, not the whole of what sca covers.
Treat it as the canonical checklist WHEN the target is a JS/TS codebase; for
other languages the same Tier-1/Tier-2 reasoning applies but the specific
patterns differ. The reference to authoring custom Semgrep rules in `configs/`
maps to the built skill's real P7 re-entrant custom-rules hook (the on-disk
`configs/` path is a bundle detail, not the built layout).
════════════════════════════════════════════════════════════════════════════
-->

# JS/TS/React/Node Threat Catalog

A checklist of what to look for, split by **who should find it**. Used by Phase 6
(threat model), Phase 8 (triage), and Phase 9 (deep dive). Each item notes the
CWE / API-Top-10 / OWASP mapping.

## Tier 1 — tools find most of these (still validate in triage)

- **XSS** (CWE-79): `dangerouslySetInnerHTML`, `href="javascript:"`,
  `eval`/`Function`/`setTimeout("string")`, unsanitized `innerHTML`, SSR injection.
  React auto-escapes JSX text — focus on the escape hatches.
- **Injection** (CWE-89/943 NoSQL, CWE-78 command, CWE-22 path): SQL/NoSQL operator
  injection (`$where`, `$ne`, query objects from `req.body`), `child_process.exec`
  with interpolation, `fs` paths from user input.
- **Weak crypto** (CWE-327/330/338): `Math.random()` for tokens/secrets, md5/sha1
  for passwords, hardcoded keys/IVs, `rejectUnauthorized:false` / TLS disabled.
- **Known-vulnerable dependencies** (OWASP A03 Supply Chain) — SCA.
- **Committed secrets** (CWE-798) — gitleaks/trufflehog. Note: anything in a React
  bundle (`REACT_APP_*`/`VITE_*`/`NEXT_PUBLIC_*`) is **public by design**.
- **Missing security headers / cookie flags** (A02/A05): no `helmet`, weak CSP,
  cookies without `httpOnly`/`secure`/`sameSite`.
- **ReDoS** (CWE-1333): user input into catastrophic-backtracking regex.

## Tier 2 — tools are largely blind; AI + human own these

- **Broken Object Level Authorization / IDOR / BOLA** (API1:2023, CWE-639/862):
  object refs not scoped to the caller — `findById(req.params.id)` without an owner
  check. **The single highest-impact category.** Check *every* `:id`-style route.
- **Broken Function Level Authorization** (API5:2023, CWE-862): admin/privileged
  routes missing role checks, or checks bypassable via path/param manipulation.
- **Broken Object Property Level Authorization / mass assignment** (API3:2023,
  CWE-915): `Object.assign(model, req.body)`, `{...req.body}` into a model, ORM
  `create/update` with raw body → caller sets `isAdmin`/`role`/`ownerId`/`balance`.
- **Prototype pollution** (CWE-1321, very JS-specific): user-controlled keys
  (`__proto__`/`constructor`/`prototype`) into `lodash.merge`/`set`, `Object.assign`,
  recursive merges, query parsers (`qs`); then find a *gadget* (template options,
  `child_process` options) that turns pollution into auth bypass or RCE.
- **SSRF** (API7:2023, CWE-918): server-side `fetch`/`axios`/`got`/`http.request`
  to user-controlled URLs (webhooks, image/PDF/link-preview fetchers); no allow-list.
- **Business-logic flaws** (API6:2023, OWASP A06): negative/fractional
  quantities/amounts, client-set prices/totals trusted, coupon/refund/credit abuse,
  workflow-step skipping or replay, idempotency gaps.
- **Race conditions / TOCTOU** (CWE-367): check-then-act on balances, stock,
  one-time tokens → double-spend.
- **Cross-repo trust failures**: backend assumes the frontend already validated;
  an internal service trusts a header (`X-User-Id`, `X-Role`) an attacker can set if
  reached directly; shared lib trusts its callers' inputs; webhook signature not
  verified; duplicated DTOs that validate inconsistently.
- **AuthN weaknesses** (API2:2023, CWE-287/384): JWT `alg:none`/unverified
  signature/no expiry/no aud-iss check, weak password reset tokens, missing rate
  limiting/lockout, session fixation.
- **CORS/CSRF** (CWE-352): reflected `Origin` with `credentials:true`;
  state-changing endpoints under cookie auth without CSRF tokens / `SameSite`.
- **Unrestricted resource consumption** (API4:2023, CWE-770): no pagination caps,
  unbounded queries/uploads, no rate limits → DoS / cost.
- **Insecure deserialization** (CWE-502): `node-serialize`, `eval(JSON-ish)`,
  unsafe YAML loaders.
- **Secrets shipped to the browser** (CWE-798): confirm whether bundled keys are
  truly sensitive (publishable keys can be fine; signing/secret keys are not).
- **Privacy** (LINDDUN): excessive PII collection/retention, PII in logs, linkable
  identifiers, missing data-subject controls.

## React/frontend-specific

- `dangerouslySetInnerHTML` without `DOMPurify`; `href`/`src` from untrusted data.
- `postMessage` handlers without origin checks; `window.opener` / `target=_blank`
  without `rel="noopener"`.
- Client-side authorization (hiding UI ≠ enforcing access) — always assume the
  backend must re-check.
- Secrets / internal endpoints / feature flags leaked in the bundle or source maps.

## Express/Node-specific

- Missing input validation (no `zod`/`joi`/`express-validator`) at trust boundaries.
- Error handlers leaking stack traces / internal details.
- `trust proxy` misconfig (client can spoof `X-Forwarded-For`).
- Body-parser without size limits; file uploads (`multer`) without type/size checks
  or storing in webroot; zip-slip on archive extraction.
- Disabled or missing `helmet`; permissive CORS.

## How to use this catalog

- **Phase 6**: walk each component against Tier 1 + Tier 2; mark each threat
  `tool-checkable` or `manual-only`. Manual-only items are your priority signal.
- **Phase 9**: for each Tier-2 item you investigate and confirm, write a custom
  Semgrep rule (the built skill's real P7 re-entrant custom-rules hook re-runs
  authored rules) so the tools gain recall on variants.
