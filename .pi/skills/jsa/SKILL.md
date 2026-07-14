---
name: jsa
description: Analyze JavaScript pulled from live URLs for client-side vulnerabilities — bug-bounty-grade review with browser-verified proof-of-concept. Use when the task requires downloading and reviewing a site's JavaScript for security bugs. Do not use when reviewing a local source tree (the sca skill), network-level or subdomain scanning, or non-JavaScript targets.
license: MIT
metadata:
  version: "3.0.0"
  penny:
    engine: orchestration
    mempalace: true
    subagents:
      - annie
      - synthia
      - vera
      - skribble
      - carren
---

# jsa — JavaScript Security Analysis

Production-grade multi-agent JavaScript security analysis. Downloads, structures, slices, dispatches per-lane agents, and reports vulnerabilities across 22 classes with expert-level depth. Uses a typed analysis store (PageCard/ModuleCard/FlowCard) for bounded context and lane-based packetization for efficient agent dispatch.

## When to Use

- Bug bounty JavaScript analysis — find vulnerabilities in target web applications
- Source code security review — analyze local JS/TS codebases
- Post-discovery analysis — feed target URLs for deep JS vulnerability discovery
- You need production-safe, independently verified findings with CVSS 4.0 scoring

## When NOT to Use

- Simple grep or linting (this is deep multi-step analysis)
- Non-JavaScript targets (binary, server-side Java/Python, etc.)

## Invocation

Invoke via the `skill` tool. The skill extension handles orchestration — agents communicate via mempalace, Penny receives structured summaries.

The `skill` extension handles the entire orchestration loop. Penny's context stays clean — agents communicate via mempalace, and Penny only sees structured summaries.

```
skill({{
  skill_name: "jsa",
  goal: "Your target URL or scope",
  project_root: "/path/to/project"
}})
```



---

## Usage

The jsa skill accepts all target configuration inline via `goal` and `constraints`. Required fields:

- `target_url` — the URL to analyze (also auto-extracted from the `goal` text)
- `authenticated_testing` — `anonymous_only` / `both` / `authenticated_only`
- `session_management` — `cookie` / `jwt_header` / `oauth2` / `custom_header` / `mixed`
- `auth_instructions` — required when `authenticated_testing` is not `anonymous_only`

### Happy path (all required fields inline)

```
skill({
  skill_name: "jsa",
  goal: "Analyze JavaScript on https://ginandjuice.shop",
  constraints: {
    // Pipeline-level config (top-level of constraints, NOT inside intake):
    output_dir: "/tmp/gin-and-juice-test",
    out_of_scope: ["https://ginandjuice.shop/vulnerabilities"],
    wave_size: 10,        // tunable Budget: findings per annie investigate wave (default 10)
    // max_fan_width, max_iterations also honored per the engine defaults.
    // Browser-PoC VERIFY is evidence-gated (Rec 4): a verified finding must carry
    // the executed-PoC transcript or the engine rejects the verdict.
    dual_verify: false,   // Rec 5 (opt-in): a PASS runs a SECOND independent vera;
    reverify_model: "",   //   only findings BOTH passes confirm are reported verified.
    //   Set reverify_model to a DIFFERENT model id for an independent judge.

    // Intake answers (passed when INTAKE escalation should be skipped):
    intake: {
      target_url: "https://ginandjuice.shop",
      authenticated_testing: "both",
      auth_instructions: "login at /login as carlos/hunter2",
      session_management: "cookie",
    },
  },
})
```

INTAKE validates the configuration, all required fields are present, and the pipeline auto-advances through ACQUIRE → CVE_RESEARCH → ... → REFLECT → COMPLETED in the same call.

### Missing fields path (INTAKE gate)

If required fields are missing, the run pauses on the `intake` engine gate. The
gate surfaces a `questions` array (only the still-missing schema fields). Penny:

1. Invokes the `questionnaire` tool with those questions
2. Collects the user's answers (including free-text via the "Type something" option)
3. Resumes the same run (same `run_id`) with the answers as the `user_response`.
   The engine merges them into the intake record and re-validates: valid →
   advance to ACQUIRE; still-invalid → re-enter the gate and re-ask only the
   remaining fields. (Equivalently, re-invoke the skill with `constraints.intake`
   populated.)

```
skill({
  skill_name: "jsa",
  goal: "Analyze JavaScript on https://ginandjuice.shop",
  constraints: {
    intake: {
      target_url: "https://ginandjuice.shop",
      authenticated_testing: "both",
      auth_instructions: "login at /login as carlos/hunter2",
      session_management: "cookie",
    },
  },
})
```

### With Specific Analyzers

```
skill({
  skill_name: "jsa",
  goal: "Analyze JS on https://example.com",
  analyzers: ["dom_xss", "prototype_pollution", "postmessage"]
})
```

### With Source Code

```
skill({
  skill_name: "jsa",
  goal: "Analyze JavaScript in ./src/app/"
})
```

### All Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `skill_name` | Yes | Must be `"jsa"` |
| `goal` | Yes | Target URL, source code path, or both |
| `analyzers` | No | List of vuln classes to analyze (default: all 22) |
| `constraints.output_dir` | No | **Top-level** key inside `constraints`. Report output directory. Defaults to `/tmp/jsa-{hostname}`. If the resolved path would land inside the project tree (contains `AGENTS.md`/`.pi`/`.git`), it is auto-redirected to `/tmp/jsa-{hostname}` for safety. |
| `constraints.intake` | No | Pre-collected intake answers. If supplied, INTAKE skips escalation and runs the pipeline. Valid keys: `target_url`, `out_of_scope`, `authenticated_testing`, `auth_instructions`, `session_management`, `roles`, `session_details`. |
| `constraints.out_of_scope` | No | **Top-level** key. List of URL substrings (or a newline-separated string) that must NEVER be fetched, crawled, or PoC'd. Enforced in ACQUIRE (crawler), INVESTIGATE (worker prompts), and VERIFY (browser PoC). Substring match. |

> **Common mistake:** putting `output_dir` or `out_of_scope` *inside* `constraints.intake`. These are **top-level** constraint keys, not intake fields. The intake schema is for questionnaire responses; output path and scope are pipeline-level configuration.

---

## Pipeline

```mermaid
graph TD
    A[intake: GATE — validate goal/constraints; questionnaire for missing fields] --> B[acquire: TOOL local — katana crawl (auth, depth-bounded) + curl + recursive jsluice JS discovery]
    B --> C[cve_research: TOOL local — Wappalyzer + source maps + OSV.dev + asset_classify + purl]
    C --> D[sast_scan: TOOL local — semgrep + jsluice secrets/urls]
    D --> E[normalize: TOOL local — dedup_components + dedup_vulns via purl + VEX]
    E --> F[dedup_within_source: TOOL local — scanner fingerprint dedup]
    F --> G[correlate_evidence: TOOL local — typed edges + agent candidates]
    G --> H[agent_review: TOOL local heuristic — bounded evidence packets, score 0.45-0.85]
    H --> I[sast_validate: TOOL local heuristic — confirmed/fp/needs_deeper]
    I --> J[structure: TOOL local — build typed store + PageCard/ModuleCard]
    J --> K[slice: TOOL local — Joern data flow + per-class candidates; seed wave plan]
    K --> L[investigate: AGENT annie — bounded wave loop, per-lane FlowCards]
    L -->|investigate_wave: wave &lt; total_waves| L
    L -->|investigate_done| M[collect: TOOL local — gather from MemPalace]
    M --> N[merge: AGENT synthia — dedup + merge]
    N --> O[verify: AGENT vera — browser PoC, evidence oracle]
    O --> P[report: AGENT skribble — bug bounty reports]
    P --> Q[reflect: AGENT carren — self-improving SAST rules + jsa-learnings]
    Q --> R[complete]
```

```
intake ─(gate)→ acquire → cve_research → sast_scan → normalize → dedup_within_source
→ correlate_evidence → agent_review → sast_validate → structure → slice
→ investigate ⟲(wave loop) → collect → merge → verify → report → reflect → complete
```

> **Note:** all TOOL states (`acquire` … `slice`, plus `collect`) run inline in
> the engine with no agent. `agent_review` and `sast_validate` are LOCAL
> deterministic heuristics despite the name — no agent runs. `intake` is the
> only human gate; after the INVESTIGATE wave loop the pipeline flows straight
> into `collect` with no pause. See `resources/flow.mmd` for the exact FSM.

| State | Type | Run By | What Happens |
|-------|------|--------|-------------|
| **intake** | GATE | — | Validate target configuration. Required: `target_url`, `authenticated_testing`, `session_management`; conditionally `auth_instructions` when authenticated testing ≠ anonymous. If anything is missing, the run pauses on the `intake` engine gate; Penny answers via the `questionnaire` tool and resumes the same `run_id`. When valid (or seeded from `constraints`), the gate is skipped and the pipeline fires into ACQUIRE. |
| **acquire** | TOOL (local) | — | Depth-bounded katana crawl (authenticated) + curl fallback + recursive jsluice JS discovery → downloads JS/HTML and builds the file manifest |
| **cve_research** | TOOL (local) | — | Wappalyzer fingerprint engine (3,911 technologies) + source-map parsing + content regex fallback + asset classification + purl canonical IDs + initial VEX status |
| **sast_scan** | TOOL (local) | — | semgrep (jsa preset) + jsluice secrets + jsluice urls on ALL files; produces SARIF-style fingerprints |
| **normalize** | TOOL (local) | — | `dedup_components` (purl canonical) + `dedup_vulnerabilities` (CVE alias canonicalization) + VEX status per CVE |
| **dedup_within_source** | TOOL (local) | — | `scanner_dedup.merge_scanner_findings()` — dedup SAST findings by SARIF fingerprints and similarity |
| **correlate_evidence** | TOOL (local) | — | Cross-stream correlation via typed edges (component→vuln, SAST→vuln). Hard gates + positive/negative signals. `select_agent_candidates()` filters to score 0.45-0.85 |
| **agent_review** | TOOL (local heuristic) | — | LOCAL despite the name. Reviews ambiguous correlation edges via **bounded evidence packets** (no raw code). Produces verdict + confidence_override + recommended_action |
| **sast_validate** | TOOL (local heuristic) | — | Triage SAST findings: confirmed / false_positive / needs_deeper (first-party vs third-party awareness from correlation) |
| **structure** | TOOL (local) | — | Build typed analysis store. Parse HTML for page context, query Caido (graceful if unavailable), build PageCard/ModuleCard |
| **slice** | TOOL (local) | — | Per-class candidate generation + Joern CPG slices (graceful degradation). Build FlowCard. Seed the INVESTIGATE wave plan |
| **investigate** | AGENT | annie | Bounded wave loop (`total_waves = max(1, ceil(needs_llm / 10))`). Per-lane work consuming FlowCards; general sweep for novel patterns. On `investigate_done` the pipeline flows straight to `collect` |
| **collect** | TOOL (local) | — | Gather findings from MemPalace `{session_id}-findings` room |
| **merge** | AGENT | synthia | Dedup + cross-card stitching + confidence promotion |
| **verify** | AGENT | vera | Browser PoC: navigate, inject payloads, capture screenshots; enforces `out_of_scope`; attaches transcripts as `evidence` |
| **report** | AGENT | skribble | Structured findings: title, application-context impact (exploitability + which data/users/functions are at risk + chainability), steps to reproduce, code analysis, remediation, CVSS 4.0 vector (score complements, does not replace, the impact narrative) |
| **reflect** | AGENT | carren | Self-improving SAST: for every confirmed vuln the deterministic scanner missed, authors a new semgrep rule, `semgrep --validate`s it, and persists it to `.pi/extensions/semgrep/rules/learned/jsa/` (future runs auto-load it); also writes FP/FN learnings to jsa-learnings |

Agent states escalate on `needs_clarification` / UNCERTAIN via the engine HITL
seam (`unknown` → `awaiting_clarification`, resumed at `investigate`). Any state
can `abort` to `error`.

### Two-Pass Architecture (with Correlation Layer)

**Pass 1 — Deterministic Automation (seconds):**
- `ACQUIRE` downloads JS files
- `CVE_RESEARCH` detects components via Wappalyzer + source maps + content regex
- `SAST_SCAN` runs semgrep + jsluice on all files

**Correlation Layer (deterministic):**
- `NORMALIZE` — `dedup_components` (purl canonical) + `dedup_vulnerabilities` (CVE alias canonicalization) + VEX status per CVE
- `DEDUP_WITHIN_SOURCE` — `scanner_dedup.merge_scanner_findings()` dedups SAST by SARIF fingerprints
- `CORRELATE_EVIDENCE` — cross-stream typed edges (component→vuln, SAST→vuln) with hard gates + positive/negative signals
- `AGENT_REVIEW` (local heuristic — no agent runs) — reviews only ambiguous correlation edges (score 0.45-0.85) via bounded evidence packets
- `SAST_VALIDATE` (local heuristic) — triage findings as confirmed/false_positive/needs_deeper, informed by correlation evidence

**Pass 2 — Deep Analysis (minutes):** Vulnerable code is identified via tree-sitter + Joern (when available), per-class candidates are sliced, and per-lane agents investigate. Agents:
- Skip confirmed SAST findings (already found)
- Ignore false positives (validated noise)
- Verify NEEDS_DEEPER items
- Find multi-step chains, framework bypasses, and patterns SAST misses

This mirrors how a human tester works: run automated scanners first, correlate deterministic signals, ask agents only for bounded judgment on ambiguous cases, then focus deep analysis where it matters.

### Three-Lane Architecture (STRUCTURE → SLICE → INVESTIGATE)

The deep analysis pass is a structure-and-slice architecture with 3 phases:

- **STRUCTURE** (local) — Build a typed analysis store and emit `PageCard` / `ModuleCard` records. Parses HTML, builds file manifest, AST index, runs tree-sitter queries for dangerous patterns.
- **SLICE** (local) — Per-class candidate generation. Uses vuln-class heuristics, dangerous patterns, and (when available) Joern data flow queries. Emits `FlowCard` records with proper CWE + lane assignment.
- **INVESTIGATE** (per-lane agent dispatch) — Three lanes with different packet types:

| Lane | Analyzers | Packet Type |
|------|-----------|-------------|
| `code_static` | `dom_xss`, `prototype_pollution`, `csti`, `postmessage`, `open_redirect`, `secret_disclosure`, `request_override`, `link_manipulation`, `dom_data_manipulation`, `ssrf`, `sqli`, `http_header_injection`, `insecure_deserialization` | `FlowCard` (with source/sink/sanitizer info, ~50-200 lines of code) |
| `page_dom` | `dom_clobbering`, `reflected_xss`, `stored_xss` | `PageCard` + relevant `FlowCards` (HTML structure + JS correlation) |
| `network_behavior` | `cors`, `clickjacking`, `idor`, `cache_poisoning`, `http_smuggling`, `csrf` | `PageCard` with Caido HTTP history (request/response, headers) |

Each agent prompt (`assets/prompts/annie-{vuln_class}.md`) declares its lane so INVESTIGATE can route work items correctly. The `scripts/lane_router.py` module is the source of truth for the lane-to-analyzer mapping. The **22** vulnerability-class analyzers, prompts, and lane labels are **1:1:1** — `lane_router.get_all_analyzers()` returns exactly the 22 classes (13 code_static + 3 page_dom + 6 network_behavior), and a drift-guard test (`test_lane_router.py`) fails if the router, the analyzer files, and the prompts ever diverge. (`csrf` is routed to `network_behavior` because a CSRF verdict hinges on whether state-changing requests validate an anti-CSRF token — which needs HTTP history.)

---

## Vulnerability Classes (22 Analyzers)

### File-Level (JS Code Analysis)

| Analyzer | Key Patterns |
|----------|-------------|
| `dom_xss` | Sources (location.*, document.referrer, postMessage, storage) → sinks (innerHTML, eval, document.write, jQuery html()) |
| `reflected_xss` | URL parameter reflection in HTTP responses, server-rendered injection |
| `stored_xss` | Persistent injection via forms, persisted in DB/API and rendered unsanitized |
| `prototype_pollution` | `__proto__`, `constructor.prototype` manipulation via merge/extend operations |
| `csti` | Client-side template injection (AngularJS `{{}}`, Vue `v-html`, template literals with user input) |
| `postmessage` | Missing origin validation, wildcard targetOrigin, dangerous event.data handling |
| `dom_clobbering` | HTML elements colliding with JS variables, form/embed/iframe name collisions |
| `open_redirect` | `location.href =`, `window.open()`, `location.replace()` with user-controlled URLs |
| `ssrf` | Server-side URL fetching with user-controlled parameters |
| `sqli` | SQL query construction in client-side JS (Node.js backends, WebSQL) |
| `insecure_deserialization` | Unsafe deserialization of user-controlled data (untrusted JSON/structured input flowing into eval-like reconstruction) |
| `secret_disclosure` | API keys, tokens, credentials, internal URLs in JS source |
| `request_override` | XMLHttpRequest/fetch URL override, request hijacking |
| `link_manipulation` | `<a href>`, `<link href>`, `<script src>` manipulation |
| `http_header_injection` | Header injection via XHR/fetch, response splitting |
| `dom_data_manipulation` | DOM manipulation that alters security-sensitive elements |

### Page-Level (Browser Behavior Analysis)

| Analyzer | Key Patterns |
|----------|-------------|
| `csrf` | Missing CSRF tokens in forms, token validation bypasses |
| `cors` | Misconfigured Access-Control headers, credentials exposure |
| `clickjacking` | Missing X-Frame-Options, framebusting bypass |
| `idor` | Object reference manipulation in API calls |
| `http_smuggling` | Request smuggling via content-length/transfer-encoding confusion |
| `cache_poisoning` | Cache key injection, unkeyed header reflection |

---

## Prompt Architecture

### Prompts vs References

| Layer | Location | Size | Content |
|-------|----------|------|---------|
| **Worker prompts** | `assets/prompts/annie-{vuln_class}.md` | 3-5 KB each | Actionable analysis workflow, top sources/sinks, detection commands, false positive checks, scanner configuration |
| **Agent protocols** | `assets/prompts/{agent_name}-base.md` | 2-3 KB each | Per-agent protocol: echo acquisition, vera verification, skribble reports, synthia merge, carren reflection |
| **Reference catalogs** | `assets/references/{vuln_class}/` | Full detail | Complete source/sink catalogs, all payload variants, sanitizer bypasses by version, framework-specific patterns, exploitation chains |
| **Foundational research** | `research/jsa/analyze-*.md` | 18-51 KB each | Comprehensive research documents with CVEs, historical context, academic references |

**Naming convention:** `<agent_name>-<role>.md` — `annie-dom_xss.md` for the DOM XSS analysis worker, `annie-cve.md` for the CVE researcher, `vera-base.md` for verification protocol.

### CVE Research — Offline Fingerprint Detection

The CVE_RESEARCH phase runs locally (no agent) using the **Wappalyzer fingerprint database** (3,911 technologies, vendored from wapalyzer-core v6.11.0, MIT licensed).

1. **Fingerprint engine** (`fingerprint_engine.py`) matches filenames against 2,146 `scriptSrc` patterns and file content against 462 `scripts` + `html` patterns
2. **Version extraction** via Wappalyzer's `\;version:\1` annotation syntax on filename patterns
3. **Content fallback**: 9 content-based version regex patterns supplement Wappalyzer for in-file version comments (e.g., `/*! jQuery v3.7.1 */`)
4. Results stored in `state.metadata["cve_research"]` with per-technology versions, confidence scores, and detection vectors
5. **CVE lookup** is deferred to vuln-class agents during INVESTIGATE deep analysis

This replaces the previous 88-pattern regex LIBRARIES list. The `annie-cve.md` prompt is retained for future INVESTIGATE-phase CVE research integration.

### Structure + Slice Architecture

The deep analysis pass uses a typed analysis store and per-class candidate generation. The flow is:

**STRUCTURE** (local) builds the typed analysis store:
- Parses JS files with tree-sitter for AST indexes
- Parses HTML files for DOM inventory (PageCard)
- Extracts dangerous patterns via tree-sitter queries (`innerHTML`, `eval`, `Object.assign`, `fetch`, `location.*`, `setTimeout` with strings, `postMessage` listeners)
- Builds ModuleCard (per JS/HTML file) and PageCard (per crawled page)
- Queries Caido for HTTP history (graceful degradation if not running)

**SLICE** (local) generates per-class candidates:
- Uses vuln-class heuristics and tree-sitter pattern matching
- When available, uses Joern CPG queries for data flow analysis
- Caps at 20 candidates per vuln class to prevent card explosion
- Emits FlowCard records with proper CWE + sink mapping + lane assignment

**INVESTIGATE** (per-lane agent dispatch) consumes the cards:
- code_static lane: receives FlowCard (source/sink/sanitizer info, ~50-200 lines of code)
- page_dom lane: receives PageCard + relevant FlowCards (HTML structure + JS correlation)
- network_behavior lane: receives PageCard with Caido HTTP history (request/response, headers)

### Per-Lane Agent Dispatch

Each agent operates on a single card in one of three lanes. A 500-file enterprise app with 3 analyzers produces hundreds of agents running in waves — completing in minutes. Each agent has bounded context (FlowCard/PageCard is 2-15K tokens, never the full codebase).

### MemPalace-Native Communication

Agents communicate via dedicated `wing_jsa` rooms:
- `{session_id}-mesh` — who's working on what
- `{session_id}-feed` — findings, cross-card hints, status updates
- `{session_id}-findings` — raw per-agent findings
- `{session_id}-merged` — deduplicated merged findings
- `jsa-learnings` — cross-session pattern corrections (persistent)

### Pre-Filtering (Dangerous Pattern Detection)

Before per-class analysis, files are scanned for dangerous patterns. Files without any analyzer's sinks are excluded from deep analysis. This typically eliminates 60-80% of vendor/library files before per-class candidate generation.

---

## Output

Every finding includes:
1. **Title** — descriptive, specific, includes vuln class and location
2. **Application-Context Impact** — the vulnerability *within the context of this application*: its exploitability and concrete impact — which data, users, and functions are at risk, and how it chains with other findings. Required in addition to (never replaced by) the CVSS score.
3. **Steps to Reproduce** — copy/paste executable curl/playwright commands
4. **Code Analysis** — source-to-sink walkthrough with line references
5. **Remediation** — tech-stack-specific, actionable. No generic guidance.
6. **CVSS 4.0** — full vector with exploitability and impact justification. The score complements, and does not replace, the application-context impact narrative.

Output location: `{output_dir}/reports/jsa-{session_id}/report.md`
Evidence: `{output_dir}/evidence/jsa-{session_id}/`

---

## Production Safety

- All browser testing uses `alert()`, `console.log()`, `confirm()` only
- No data exfiltration payloads
- No destructive DOM mutations
- No persistent modifications without explicit user approval
- Scope boundary enforcement prevents out-of-scope testing

---

## Prerequisites

- **semgrep** CLI — pattern-based SAST scanning
- **jsluice** CLI — URL and secret extraction from JavaScript
- **Playwright** — browser automation (via our playwright extension)
- **tree-sitter** + tree-sitter-javascript — AST parsing
- **MemPalace** — inter-agent communication (already configured)
- **Node.js / npx** — js-beautify, synchrony, webcrack (deobfuscation)

---

## Learnings & MemPalace handoff

The engine records the run outcome and writes the completion `result` — there is
no manual "store session results" step for Penny to run. During REFLECT, carren
runs the self-improving-SAST loop: for every confirmed vulnerability the
deterministic scanner missed, she authors a new semgrep rule, validates it with
`semgrep --validate`, and persists it to
`.pi/extensions/semgrep/rules/learned/jsa/` — future runs load these rules
automatically, so the scanner grows permanently more robust each run. She also
writes FP/FN pattern corrections to the persistent `jsa-learnings` room for
future runs.

One handoff is required: the jsa subprocess cannot call MCP tools, so `sast_scan`
and `cve_research` write their results to `{output_dir}/mempalace_stubs.json`.
The completion `result` carries a `mempalace_stubs` list and a
`mempalace_handoff` instruction; Penny replays each stub with
`memory_add_drawer(wing=s['wing'], room=s['room'], content=s['content'])` to
populate the `{session_id}-sast-findings` and `{session_id}-cve-research` rooms in
`wing_jsa`.
