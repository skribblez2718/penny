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
    max_fan_width: 5,     // tunable Budget: how many per-class annie agents run in PARALLEL
    //   per INVESTIGATE batch (jsa default 5). INVESTIGATE fans one agent per candidate
    //   vuln class (fresh context), in batches of this width, iterating until ALL classes
    //   are covered, then a trailing generalist sweep. Also the engine's fan ceiling.
    wave_size: 10,        // informational per-class candidate-batch hint (default 10)
    // max_iterations also honored per the engine defaults.
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

`resources/flow.mmd` is the **canonical** pipeline diagram — an edge-for-edge mirror of `JSAMachine` (guarded against drift by `apps/orchestration/tests/test_jsa_flow_diagram.py`). Read it for the exact states, events, and guards. In summary:

- **`intake`** is the only human gate (schema questionnaire). Seeded valid from `constraints`, it is skipped and the run auto-advances.
- A **deterministic pass** then runs inline with no agent: `acquire → cve_research → sast_scan → normalize → dedup_within_source → correlate_evidence → agent_review → sast_validate → structure → slice`. `agent_review` and `sast_validate` are LOCAL heuristics despite the name.
- **`investigate`** (annie) is a bounded **per-class parallel batch fan** — one annie agent per candidate vuln class (a fresh context focused on that class + its `references/<class>.md` catalog), run in batches of up to `max_fan_width` (default 5) concurrently, iterating until all classes are covered, then a trailing generalist sweep batch (novel patterns, logic/auth, cross-class chains); when the batches finish it flows straight into `collect → merge → verify` with no gate.
- The **verify tail is evidence-gated**: `verify` (vera) → optional `reverify` (a second, independent vera — only when `constraints.dual_verify` is set and `verify` PASSed) → **`poc_capture`** (an engine-owned TOOL state that re-checks `{output_dir}/poc/<finding_id>.png` and demotes any claimed-verified finding lacking a decodable browser screenshot) → `report` (skribble) → `reflect` (carren) → `complete`.
- Agent states escalate on `needs_clarification` / UNCERTAIN via the engine HITL seam (`unknown → awaiting_clarification`, resumed at `investigate`); any non-final state can `abort` to `error`.

What each state actually *does* is described in the [Two-Pass](#two-pass-architecture-with-correlation-layer) and [Three-Lane](#three-lane-architecture-structure--slice--investigate) sections below; the deterministic-phase internals live in the skill modules under `scripts/`.

### Two-Pass Architecture (with Correlation Layer)

**Pass 1 — Deterministic Automation (seconds):**
- `ACQUIRE` downloads JS files (katana crawl + recursive jsluice discovery) **and reconstructs first-party original source from source maps** — inline base64, co-located, or external `.map` with `sourcesContent` → written to `{output_dir}/sources/` (readable pre-bundle TS/JSX; `node_modules`/bundler-internal sources skipped). Analyzers and annie review the readable source, not just minified bundles.
- `CVE_RESEARCH` detects components via Wappalyzer + source maps + content regex
- `SAST_SCAN` runs semgrep (incl. `p/secrets`) + jsluice on all files (incl. reconstructed `sources/`), **plus optional trufflehog/gitleaks** for broad named-secret coverage with live verification (graceful if absent). All secret hits are deduped and surfaced as first-class `secret_disclosure` findings.

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
- **INVESTIGATE** (per-class wave dispatch) — one wave per candidate vuln class + a generalist sweep; the class's **lane** decides which packet type its candidates carry:

| Lane | Analyzers | Packet Type |
|------|-----------|-------------|
| `code_static` | `dom_xss`, `prototype_pollution`, `csti`, `postmessage`, `open_redirect`, `secret_disclosure`, `request_override`, `link_manipulation`, `dom_data_manipulation`, `ssrf`, `sqli`, `http_header_injection`, `insecure_deserialization` | `FlowCard` (with source/sink/sanitizer info, ~50-200 lines of code) |
| `page_dom` | `dom_clobbering`, `reflected_xss`, `stored_xss` | `PageCard` + relevant `FlowCards` (HTML structure + JS correlation) |
| `network_behavior` | `cors`, `clickjacking`, `idor`, `cache_poisoning`, `http_smuggling`, `csrf` | `PageCard` with Caido HTTP history (request/response, headers) |

The `scripts/lane_router.py` module is the source of truth for the lane-to-analyzer mapping. The **22** vulnerability-class analyzers, reference catalogs, and lane labels are **1:1:1** — `lane_router.get_all_analyzers()` returns exactly the 22 classes (13 code_static + 3 page_dom + 6 network_behavior), and a drift-guard test (`test_lane_router.py`) fails if the router, the analyzer files (`scripts/analyzers/<class>.py`), and the reference catalogs (`assets/references/<class>.md`) ever diverge. (`csrf` is routed to `network_behavior` because a CSRF verdict hinges on whether state-changing requests validate an anti-CSRF token — which needs HTTP history.)

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

| Layer | Location | Injected? | Content |
|-------|----------|-----------|---------|
| **Agent protocols (Domain Guidance)** | `assets/prompts/{agent}-base.md` | **Yes** — via `skill_context` per state: `annie-base`, `synthia-base`, `vera-base`, `skribble-base`, `carren-base` | Per-agent mission, wire protocol, non-negotiables, output contract |
| **Per-class reference catalogs** | `assets/references/{vuln_class}.md` | No — read on demand; a per-class INVESTIGATE wave names its catalog path | Source/sink catalogs, payload variants, sanitizer bypasses by version, framework patterns, exploitation chains, scanner commands, multi-step chains, false-positive checks (agent-oriented: `read limit=30` for the ToC, then `grep`). Also feed the deterministic verifier's per-class guide (`scripts/analyzers/base.py`) |
| **Foundational research** | `research/jsa/analyze-*.md` | No | Comprehensive research: CVEs, historical context, academic references |

**How annie gets per-class guidance:** only the `*-base.md` agent protocols are injected as Domain Guidance (one per agent state, via `skill_context`). The per-class knowledge is **not** injected — each per-class INVESTIGATE wave names `assets/references/<class>.md` for its class, and annie reads that catalog before ruling. (The former per-class *worker prompts* `assets/prompts/annie-<class>.md` were retired: their content was harvested into the catalogs, which are now the single per-class knowledge source read by both annie and the deterministic verifier.)

**Naming convention:** injected agent protocols are `<agent>-base.md` (e.g. `vera-base.md` for the verification protocol); `annie-cve.md` is the CVE researcher; per-class knowledge lives in `assets/references/<class>.md` (e.g. `dom_xss.md`), read on demand and loaded by the deterministic verifier via `get_analysis_guide()`.

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

**INVESTIGATE** consumes the cards, one **vuln class** per wave; each candidate's lane decides its packet type:
- code_static lane: FlowCard (source/sink/sanitizer info, ~50-200 lines of code)
- page_dom lane: PageCard + relevant FlowCards (HTML structure + JS correlation)
- network_behavior lane: PageCard with Caido HTTP history (request/response, headers)

### Per-Class Agent Dispatch (parallel, batched)

INVESTIGATE is a **bounded, iterative PARALLEL batch fan dispatched by vuln class**. `slice` emits one annie branch per candidate vuln class into `dynamic_branches["investigate"]` — each a **fresh** annie context focused entirely on a single class and its `assets/references/<class>.md` catalog. The engine dispatches them in **batches of up to `max_fan_width` agents running CONCURRENTLY** (jsa default **5** — production bug-bounty targets have a lot to cover); `route_after` re-emits the next batch and self-transitions until **every** candidate class is covered, then runs **one trailing generalist sweep** batch (novel patterns, logic/auth flaws, and multi-step chains that cross vuln classes). `total_batches = ceil(len(candidate_classes) / max_fan_width) + 1`. `max_fan_width` is a tunable Budget (`constraints.max_fan_width`) and doubles as the engine's fan ceiling, so a batch never over-fans. There is **no cap/fold** — all candidate classes get a dedicated agent (the class count is inherently ≤ 22); annie always runs at least the sweep (≥ 1 batch).

Per-class isolation keeps each context focused (one class's methodology, full attention) while the sweep + synthia's cross-card merge preserve cross-class chain detection; the class's lane (`code_static` / `page_dom` / `network_behavior`) still governs packet type, so context stays bounded (a FlowCard/PageCard is 2-15K tokens, never the full codebase). Batching (rather than one giant fan) bounds peak concurrency — model-API rate limits, cost, and blast radius — while still covering wide targets quickly. Lower `max_fan_width` on a rate-limited key; raise it on a fat quota.

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

Output location: consolidated report at `{output_dir}/report.md`; per-finding reports under `{output_dir}/findings/`
Evidence: browser-PoC screenshots at `{output_dir}/poc/<finding_id>.png` (the deterministic path the `poc_capture` engine step re-checks)

---

## Production Safety

- All browser testing uses `alert()`, `console.log()`, `confirm()` only
- No data exfiltration payloads
- No destructive DOM mutations
- No persistent modifications without explicit user approval
- Scope boundary enforcement prevents out-of-scope testing

---

## Prerequisites

**Required:**
- **semgrep** CLI — pattern-based SAST scanning (includes the `p/secrets` ruleset)
- **jsluice** CLI — URL and secret extraction from JavaScript
- **Playwright** — browser automation (via our playwright extension)
- **tree-sitter** + tree-sitter-javascript — AST parsing
- **MemPalace** — inter-agent communication (already configured)
- **Node.js / npx** — js-beautify, synchrony, webcrack (deobfuscation)

**Optional (auto-detected, graceful if absent — install for deeper coverage):**
- **trufflehog** CLI — hundreds of provider-specific secret detectors, with live key **verification** against the provider (a `Verified` hit is reported HIGH). Discovered on `PATH` or `~/go/bin`; `SAST_SCAN` runs it over the acquired tree and folds its findings into the `secret_disclosure` flow. Absent → skipped, no error.
- **gitleaks** CLI — complementary named-secret detectors (no-git directory scan). Same graceful discovery + folding.

> Secret detection is layered and degrades gracefully: `semgrep p/secrets` + `jsluice secrets` are the always-on baseline; `trufflehog`/`gitleaks` add breadth (and trufflehog adds verification) wherever the binary is installed. All secret hits are deduped and surfaced as first-class SAST findings.

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
