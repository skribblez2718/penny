# jsa — JavaScript Security Analysis

## What It Does

Production-grade JavaScript security analysis for bug bounty hunting. Downloads JS from a target URL, runs SAST (semgrep + jsluice), correlates deterministic evidence, builds a typed analysis store, slices per-vulnerability-class candidates, runs specialized analysis agents in bounded waves, deduplicates findings, verifies with browser-based PoC testing, and produces structured vulnerability reports that describe each finding's exploitability and concrete impact within the target application, with CVSS 4.0 scoring.

Covers **22 vulnerability classes** with expert-level analysis guides and reference catalogs.

## Quick Start

```bash
# Full analysis — all 22 vuln classes
skill({ skill_name: "jsa", goal: "https://example.com" })

# Single vuln class
skill({ skill_name: "xss", goal: "https://example.com" })

# Custom output directory
skill({ skill_name: "jsa", goal: "https://example.com", constraints: { output_dir: "~/bug_bounty/custom-target/" } })
```

## How It Runs

`jsa` runs on Penny's shared orchestration engine. It is a bespoke playbook
(`JSAPlaybook`) at `apps/orchestration/src/orchestration/playbooks/jsa.py`, not a
standalone script. The engine drives a linear pipeline of custom-named states:

- the many **deterministic phases** run inline in the engine with no agent (they
  are engine *tool states*);
- five **agent phases** — `annie` (investigate), `synthia` (merge), `vera`
  (verify), `skribble` (report), `carren` (reflect) — each runs the model named
  in its own `.pi/agents/<name>.md` and communicates via mempalace;
- one **human gate** — `intake` (a schema questionnaire). It is the only place
  the pipeline pauses for a human; after the wave loop the run flows straight
  through to completion with no further gate.

Run state (pipeline position + lean domain state) lives in the engine's durable
SQLite checkpointer keyed by `run_id`. There is no on-disk session file to thread
between calls: a run interrupted mid-step resumes automatically and re-issues
that step.

## Pipeline

```
intake ─(gate)→ acquire → cve_research → sast_scan → normalize → dedup_within_source
→ correlate_evidence → agent_review → sast_validate → structure → slice
→ investigate ⟲(wave loop) → collect → merge → verify → report → reflect → complete
```

| Phase | Run by | What happens |
|-------|--------|-------------|
| `intake` | gate | Validate target config; questionnaire only for missing fields, then resume the same run |
| `acquire` | local | Download JS files, extract inline scripts, crawl linked pages |
| `cve_research` | local | Wappalyzer fingerprint engine + source maps + version extraction + OSV.dev lookup |
| `sast_scan` | local | semgrep (jsa preset) + jsluice secrets/URLs scan all files |
| `normalize` | local | Dedup components by purl, vulns by CVE alias, assign VEX status |
| `dedup_within_source` | local | Merge SAST findings by SARIF fingerprints |
| `correlate_evidence` | local | Typed edges (component→vuln, SAST→vuln); select ambiguous agent candidates |
| `agent_review` | local heuristic | Review ambiguous correlation edges via bounded evidence packets |
| `sast_validate` | local heuristic | Triage SAST findings: confirmed / false positive / needs deeper |
| `structure` | local | Build typed store: `PageCard` / `ModuleCard`, AST indexes |
| `slice` | local | Per-class candidate generation, emit `FlowCard` records; seed the wave plan |
| `investigate` | `annie` | Bounded wave loop over candidates + a general sweep for novel patterns |
| `collect` | local | Gather per-agent findings from mempalace |
| `merge` | `synthia` | Algorithmic dedup + cross-card stitching + confidence promotion |
| `verify` | `vera` | Browser PoC: navigate, inject payloads, capture screenshots; enforces scope |
| `report` | `skribble` | Structured finding reports (title, STR, code analysis, per-finding application-context impact, remediation, CVSS 4.0 vector) |
| `reflect` | `carren` | Self-improving SAST: author a new semgrep rule for each confirmed vuln the scanner missed, plus FP/FN learnings to `jsa-learnings` |
| `complete` | — | Pipeline done |

### Investigation is a bounded loop

`investigate` runs in waves: `total_waves = max(1, ceil(needs_llm / 10))`, so
`annie` always runs at least one wave (the general sweep) even with no
SAST-derived candidates. Findings still unverified after the waves are reported
honestly (`unverified_after_waves`) rather than silently dropped or fabricated as
exploitable.

### Human gate and clarification

The `intake` gate is the only place the pipeline pauses for a human: it hands a
`questions` array back to Penny, and the user's answer resumes the same `run_id`.
If an agent phase reports `UNCERTAIN` or needs clarification, the engine pauses
the run at `awaiting_clarification` and resumes the same run once the user
answers — the deterministic pipeline is not re-run.

### Reflect is a self-improving SAST loop

`reflect` (`carren`) is more than a post-mortem. For every vulnerability the run
*confirmed* that the deterministic scanner *missed*, `carren` authors a new
semgrep rule that would have caught it. Each rule is checked with
`semgrep --validate` (a malformed rule can never land) and persisted to
`.pi/extensions/semgrep/rules/learned/jsa/`, which every future run loads
automatically as part of its `--config` tree — so the scanner gets permanently
more robust after each run. `carren` still writes its FP/FN pattern learnings to
the persistent `jsa-learnings` room as well, but the rule-authoring loop is the
headline capability.

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
├── report.md                        # Consolidated summary (all findings)
├── assets/
│   ├── js/{slug}.js                 # Downloaded JavaScript files
│   └── html/{slug}.html             # Crawled HTML pages
├── sast/
│   ├── semgrep-results.json         # Raw semgrep output
│   └── jsluice-results.json         # Raw jsluice output
├── findings/
│   ├── F-001_dom-xss-profile/       # Individual finding directory
│   │   ├── report.md                # Writeup (title, STR, code analysis, app-context impact, remediation, CVSS 4.0)
│   │   ├── screenshots/poc.png
│   │   └── poc/exploit.html
│   └── F-002_prototype-pollution-config/
├── evidence/
│   └── crawl/{page}.png
└── mempalace_stubs.json             # SAST/CVE results for Penny to replay into wing_jsa
```

Default output is `/tmp/jsa-{hostname}/`. Configurable via `constraints.output_dir`.
Pipeline run state is not written here — it lives in the engine's SQLite
checkpointer keyed by `run_id`.

The jsa subprocess cannot call MCP tools, so `sast_scan` and `cve_research` write
their results to `mempalace_stubs.json`. The completion result carries a
`mempalace_stubs` list and a handoff instruction; Penny replays each stub with
`memory_add_drawer` to populate the `{session_id}-sast-findings` and
`{session_id}-cve-research` rooms in `wing_jsa`.

## Two-Pass Architecture

**Pass 1 — deterministic automation (seconds):** semgrep + jsluice scan all files,
then the correlation layer (`normalize` → `dedup_within_source` →
`correlate_evidence` → `agent_review` → `sast_validate`) canonicalizes components,
links evidence, and triages findings as confirmed, false positive, or needs
deeper analysis.

**Pass 2 — deep analysis (minutes):** `structure` and `slice` build a typed
analysis store and per-class `FlowCard`/`PageCard` candidates; `investigate`
agents analyze bounded packets — they skip confirmed findings, ignore false
positives, verify "needs deeper" items, and find multi-step chains and framework
bypasses that SAST misses.

This mirrors human bug bounty workflow: run automated scanners first, correlate
and triage noise, then focus deep analysis on what matters.

## Reference Catalogs

22 lean reference catalogs in `assets/references/` — one per vuln class. Agents use
`grep` and `read` with `offset` to find specific patterns without reading entire
files. Each catalog contains source/sink tables, payloads, bypass techniques,
detection heuristics, and false positive patterns.

## Bounded Context

Each investigation agent operates on a single bounded card (`FlowCard`/`PageCard`,
2–15K tokens) in one of three lanes — `code_static`, `page_dom`, or
`network_behavior` — never the full codebase. A large app produces many agents
run in bounded waves, keeping per-agent context small and consistent.
