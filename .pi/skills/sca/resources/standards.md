<!--
════════════════════════════════════════════════════════════════════════════
MIGRATION NOTE (sca Phase 11) — migrated from the code-analysis bundle
(reference/standards.md).

This is a REFERENCE doc, not a build spec. Its concepts carried over into the
built skill's P5_REQUIREMENTS and P6_THREAT_MODEL phases (ASVS as the requirements
baseline; STRIDE + LINDDUN in the real threat-model prompt; CWE / API-Top-10
mappings on findings via normalize.py's `asvs_references` / `cwe_ids` /
`api_top10_2023_mapping` fields). No divergence in intent.

RECENCY CAVEAT (honesty): the version numbers and "latest as of …" / release-date
claims below are TIME-SENSITIVE and are reproduced from the bundle UNVERIFIED in
this session. Do NOT rely on the exact edition numbering or release dates without
re-checking the official sources — the bundle's own instruction ("Verify versions
before relying on exact numbering") stands and is reinforced here.
════════════════════════════════════════════════════════════════════════════
-->

# Standards Reference

Anchor requirements and threats to recognized standards — not just the OWASP Top
10. Use these as the baseline; the threat model adds the application-specific rest.

> **Verify versions and release dates before relying on exact numbering.** The
> edition numbers below are reproduced unverified from the original bundle; check
> the official OWASP / MITRE / NIST sources for the current state.

## OWASP ASVS — Application Security Verification Standard
Application Security Verification Standard — a testable requirements catalogue
across multiple chapters, with verification levels **L1** (foundational), **L2**
(standard — the usual target for code review), **L3** (advanced/high-assurance).
Use ASVS as the **requirements baseline** in Phase 5. Cite as e.g. `ASVS V8.2`.
*(Confirm the current version and chapter numbering against owasp.org before
citing an exact chapter.)*

## OWASP API Security Top 10 — 2023 edition
Highly relevant: a React SPA + API means most real bugs are API-layer.
- **API1:2023** Broken Object Level Authorization (BOLA / IDOR)
- **API2:2023** Broken Authentication
- **API3:2023** Broken Object Property Level Authorization (incl. mass assignment)
- **API4:2023** Unrestricted Resource Consumption
- **API5:2023** Broken Function Level Authorization
- **API6:2023** Unrestricted Access to Sensitive Business Flows
- **API7:2023** Server-Side Request Forgery (SSRF)
- **API8:2023** Security Misconfiguration
- **API9:2023** Improper Inventory Management
- **API10:2023** Unsafe Consumption of APIs

## CWE Top 25
Root-cause lens. Notable for JS/TS apps: CWE-79 (XSS), CWE-89 (SQLi),
CWE-352 (CSRF), CWE-862 (Missing Authorization), CWE-22 (Path Traversal),
CWE-78 (OS Command Injection), CWE-94 (Code Injection),
CWE-639 (Authorization Bypass Through User-Controlled Key — IDOR), and
CWE-770 (Allocation of Resources Without Limits). Cite findings with their CWE id.
*(Confirm the current Top-25 ranking/year against cwe.mitre.org.)*

## OWASP Top 10 (web)
Sanity-check lens, not the primary driver. Broad categories include Broken Access
Control (SSRF folded in), Security Misconfiguration, Software Supply Chain
Failures, Cryptographic Failures, Injection, Insecure Design, Authentication
Failures, Software/Data Integrity Failures, Security Logging & Alerting Failures,
and Mishandling of Exceptional Conditions. *(Confirm the current edition/year and
category set against owasp.org.)*

## STRIDE — system threat categories (Phase 6)
**S**poofing, **T**ampering, **R**epudiation, **I**nformation disclosure,
**D**enial of service, **E**levation of privilege. Apply per component / data flow.
*(Implemented: the built P6_THREAT_MODEL prompt is a real STRIDE + LINDDUN pass.)*

## LINDDUN — privacy threat categories (Phase 6, when personal data is processed)
**L**inking, **I**dentifying, **N**on-repudiation, **D**etecting, **D**ata
disclosure, **U**nawareness, **N**on-compliance. Run a privacy pass if the app
stores or processes PII.

## OWASP WSTG — Web Security Testing Guide
Test scenarios for verification (Phase 10). Cite as `WSTG-<CAT>-<NN>`.

## Lifecycle frameworks (context, not per-finding)
- **NIST SSDF (SP 800-218)** — outcome-focused secure-development practices
  (PO/PS/PW/RV). Useful for the "integrate into CI" recommendations in Phase 12.
- **OWASP SAMM 2.0** — software-assurance maturity model; frame process
  recommendations against it.

## How phases use these
- **Phase 5 (requirements)**: derive testable `SR-###` from ASVS chapters + API
  Top 10 + business rules; each requirement names its standard basis.
- **Phase 6 (threat model)**: STRIDE per component; LINDDUN for privacy; map
  threats to API Top 10 / CWE.
- **Triage/findings**: every finding carries `cwe`, and `owasp_web`/`owasp_api`/
  `asvs` where they apply (real fields: normalize.py `cwe_ids`,
  `api_top10_2023_mapping`, `asvs_references`).
- **Phase 12 (coverage)**: a requirement-coverage matrix over the ASVS-derived
  `SR-###` set is the strongest evidence that the review was systematic.
