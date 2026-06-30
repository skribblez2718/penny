# jsa — JavaScript Security Analysis

## What It Does

Production-grade JavaScript security analysis for bug bounty hunting. Downloads JS from a target URL, runs SAST (semgrep + jsluice), splits code into uniform chunks, dispatches 22 specialized per-vulnerability-class analysis agents in parallel, deduplicates findings, verifies with browser-based PoC testing, and produces structured vulnerability reports.

Covers **22 vulnerability classes** with expert-level analysis guides and reference catalogs.

## Quick Start

```bash
# Full analysis — all 22 vuln classes
skill({ skill_name: "jsa", goal: "https://example.com" })

# Single vuln class
skill({ skill_name: "xss", goal: "https://example.com" })

# Custom output directory
skill({ skill_name: "jsa", goal: "https://example.com", output_dir: "~/bug_bounty/custom-target/" })
```

## Pipeline

```
INTAKE → ACQUIRE → CVE_RESEARCH → SAST_SCAN → SAST_VALIDATE
→ CHUNK → DISPATCH → COLLECT → MERGE → VERIFY → REPORT → REFLECT → COMPLETED
```

| Phase | What Happens | Time |
|-------|-------------|------|
| **ACQUIRE** | echo agent downloads JS files, extracts inline scripts, crawls linked pages | ~30s |
| **CVE_RESEARCH** | annie-cve agent detects tech stack, searches for current CVEs | ~60s |
| **SAST_SCAN** | semgrep (24 rulesets, 369 rules) + jsluice scan all files | ~10s |
| **SAST_VALIDATE** | annie agent triages SAST findings: confirmed / false positive / needs deeper | ~30s |
| **CHUNK** | Concatenate + split into ~12K token uniform chunks with overlap | ~5s |
| **DISPATCH** | `n_chunks × n_analyzers` annie agents in parallel waves with SAST + CVE context | ~2-10min |
| **COLLECT** | Gather all agent findings from MemPalace | ~5s |
| **MERGE** | Algorithmic dedup + synthia agent resolves cross-chunk findings | ~30s |
| **VERIFY** | vera agent navigates pages, injects payloads, captures screenshots | ~2-5min |
| **REPORT** | skribble agent writes findings to individual `findings/F-NNN/` directories | ~30s |
| **REFLECT** | carren agent identifies FP/FN patterns → `jsa-learnings` for self-improvement | ~30s |

## Vulnerability Classes

| Class | Skill Wrapper | Type |
|-------|--------------|------|
| DOM XSS | `xss` | File-level |
| Reflected XSS | `xss` | File-level |
| Stored XSS | `xss` | File-level |
| Prototype Pollution | `prototype-pollution` | File-level |
| SQL/NoSQL Injection | `sqli` | File-level |
| SSRF | `ssrf` | File-level |
| Secret Disclosure | `secrets` | File-level |
| Open Redirect | `open-redirect` | File-level |
| CSRF | `csrf` | Page-level |
| CORS | `cors` | Page-level |
| Clickjacking | `clickjacking` | Page-level |
| IDOR | `idor` | Page-level |
| HTTP Smuggling | `http-smuggling` | Page-level |
| Cache Poisoning | `cache-poisoning` | Page-level |
| Insecure Deserialization | `insecure-deserialization` | File-level |
| postMessage | `postmessage` | File-level |
| DOM Clobbering | `dom-clobbering` | File-level |
| CSTI | `csti` | File-level |
| Request Override | `request-override` | File-level |
| Link Manipulation | `link-manipulation` | File-level |
| DOM Data Manipulation | `dom-data-manipulation` | File-level |
| HTTP Header Injection | `http-header-injection` | File-level |

## Output Structure

```
/tmp/jsa-example-com/
├── session.json                     # Full pipeline state + metadata
├── report.md                        # Consolidated summary (all findings)
├── assets/
│   ├── js/{slug}.js                 # Downloaded JavaScript files
│   └── html/{slug}.html             # Crawled HTML pages
├── sast/
│   ├── semgrep-results.json         # Raw semgrep output
│   └── jsluice-results.json         # Raw jsluice output
├── findings/
│   ├── F-001_dom-xss-profile/       # Individual finding directory
│   │   ├── report.md                # Writeup (title, STR, CVSS, remediation)
│   │   ├── screenshots/poc.png
│   │   └── poc/exploit.html
│   └── F-002_prototype-pollution-config/
└── evidence/
    └── crawl/{page}.png
```

Default output is `/tmp/jsa-{hostname}/`. Configurable via `output_dir`.

## Two-Pass Architecture

**Pass 1 — SAST (seconds):** semgrep + jsluice scan all files for low-hanging fruit. A validator agent triages findings as confirmed, false positive, or needs deeper analysis.

**Pass 2 — Deep Analysis (minutes):** Code is chunked into ~12K token segments. Vuln-class agents analyze each chunk with SAST context injected — they skip confirmed findings, ignore false positives, verify "needs deeper" items, and find multi-step chains and framework bypasses that SAST misses.

This mirrors human bug bounty workflow: run automated scanners first, triage noise, then focus deep analysis on what matters.

## Reference Catalogs

22 lean reference catalogs in `assets/references/` — one per vuln class. Agents use `grep` and `read` with `offset` to find specific patterns without reading entire files. Each catalog contains source/sink tables, payloads, bypass techniques, detection heuristics, and false positive patterns.

## Concurrency

Up to 25 parallel agents per wave. The splitter produces uniform chunks guaranteeing consistent performance. The orchestrator (`orchestrate.py`) emits JSON directives that Penny routes to appropriate agents and tools.

## Stats

| Metric | Value |
|--------|-------|
| Analyzer implementations | 22 |
| Agent prompts | 31 |
| Reference catalogs | 23 (INDEX + 22 vuln class) |
| Convenience wrappers | 20 |
| Python source files | 27 |
| Tests | 120 |
| Lint errors | 0 |
| Pipeline phases | 13 |
