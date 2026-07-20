# jsa Skill Reference

Reference for the JavaScript Security Analysis skill. jsa runs on the shared
orchestration engine as `JSAPlaybook`
(`apps/orchestration/src/orchestration/playbooks/jsa.py`). This file describes
that FSM. `resources/flow.mmd` is the matching state diagram.

## States

Verbatim FSM state names, in pipeline order. `intake` is the initial state;
`complete` and `error` are final.

| State | Type | Actor | Description |
|-------|------|-------|-------------|
| `intake` | GATE (human) | — | Schema questionnaire: target_url, auth mode, session management, auth details. Seeded from `constraints`; if valid, the gate is skipped. |
| `acquire` | TOOL (local) | — | Download JS/HTML: external scripts, inline blocks, jsluice-discovered URLs, runtime probes. |
| `cve_research` | TOOL (local) | — | Fingerprint tech stack, generate purl IDs, look up CVEs (no date filter), assign VEX status, write artifacts + mempalace stubs. |
| `sast_scan` | TOOL (local) | — | semgrep + jsluice secrets/urls on all files; SARIF-style findings. |
| `normalize` | TOOL (local) | — | `dedup_components` (purl canonical) + `dedup_vulnerabilities` (CVE alias canonicalization) + VEX status. |
| `dedup_within_source` | TOOL (local) | — | `scanner_dedup.merge_scanner_findings()` — SAST fingerprint dedup. |
| `correlate_evidence` | TOOL (local) | — | Cross-stream typed edges + `select_agent_candidates()` (score 0.45–0.85). |
| `agent_review` | TOOL (local heuristic) | — | LOCAL despite the name. Builds bounded evidence packets, produces verdicts + confidence_override. |
| `sast_validate` | TOOL (local heuristic) | — | Classify findings: confirmed / false_positive / needs_deeper, informed by correlation evidence. |
| `structure` | TOOL (local) | — | Build typed analysis store; PageCard/ModuleCard; query Caido (graceful if unavailable). |
| `slice` | TOOL (local) | — | Per-class candidate generation + Joern CPG slices; FlowCard. Seeds the INVESTIGATE wave plan. |
| `investigate` | AGENT | annie | Bounded wave loop. Per-wave findings + general sweep; verify with tools; post verdicts. Runs annie's configured agent model. |
| `collect` | TOOL (local) | — | Gather findings from MemPalace + domain state. |
| `merge` | AGENT | synthia | Deduplicate / stitch / promote raw findings into consolidated findings. |
| `verify` | AGENT | vera | Browser-based PoC verification; enforces `out_of_scope`; attaches PoC transcripts as `evidence`. |
| `report` | AGENT | skribble | Structured findings + CVSS 4.0 vectors. |
| `reflect` | AGENT | carren | Self-improving SAST: authors a validated semgrep rule for every confirmed vuln the scanner missed (persisted to `learned/jsa/`); also writes FP/FN patterns → `jsa-learnings`. |
| `unknown` | control | — | Escalation landing state for an agent that reported UNCERTAIN / `needs_clarification`. |
| `awaiting_clarification` | control (HITL) | — | Paused awaiting user clarification. |
| `complete` | final | — | Pipeline finished. |
| `error` | final | — | Aborted. |

`TOOL_STATES` run inline via `run_tool_state` (each fires exactly one event to
the next state; tests override the `_domain_run` seam so no real scanner runs).
`GATE_STATES = {intake}` — INTAKE is the only human gate. `ESCALATABLE_STATES =
{investigate, merge, verify, report, reflect}`.

## Transitions

Every transition, verbatim event name, with its guard.

| Event | From → To | Guard / notes |
|-------|-----------|---------------|
| `go_acquire` | `intake` → `acquire` | intake record valid (schema-complete) |
| `acquire_done` | `acquire` → `cve_research` | |
| `cve_done` | `cve_research` → `sast_scan` | |
| `sast_done` | `sast_scan` → `normalize` | |
| `normalize_done` | `normalize` → `dedup_within_source` | |
| `dedup_done` | `dedup_within_source` → `correlate_evidence` | |
| `correlate_done` | `correlate_evidence` → `agent_review` | |
| `review_done` | `agent_review` → `sast_validate` | |
| `validate_done` | `sast_validate` → `structure` | |
| `structure_done` | `structure` → `slice` | |
| `slice_done` | `slice` → `investigate` | batch plan seeded; first batch fanned |
| `investigate_wave` | `investigate` → `investigate` | `batch < total_batches` (fan the next batch) |
| `investigate_done` | `investigate` → `collect` | waves complete — flows straight on, no human gate |
| `collect_done` | `collect` → `merge` | |
| `merge_done` | `merge` → `verify` | |
| `verify_done` | `verify` → `report` | |
| `report_done` | `report` → `reflect` | |
| `reflect_done` | `reflect` → `complete` | |
| `to_unknown` | `{investigate, merge, verify, report, reflect}` → `unknown` | agent `needs_clarification` / UNCERTAIN |
| `escalate` | `unknown` → `awaiting_clarification` | |
| `clarify` | `awaiting_clarification` → `investigate` | fixed resume target (deterministic pipeline not re-run) |
| `abort` | every non-final state → `error` | unrecoverable failure |

## Gates (HITL)

Gates are engine `GATE_STATES` resumed via `route_user` (a `user_response` on
the same `run_id`) — there is no `escalate_to_user` action, no
`orchestrator_state`, and no argv-carried state.

- **intake**: `gate_questions` returns the missing schema fields (from
  `INTAKE_SCHEMA`). The user's answers are merged into the intake record and
  re-validated; valid → `go_acquire`, still-invalid → the gate re-enters and
  re-asks only the still-missing fields. Required fields: `target_url`,
  `authenticated_testing`, `session_management`; `auth_instructions` is required
  when `authenticated_testing` ≠ `anonymous_only`.

INTAKE is the ONLY human gate. After the INVESTIGATE wave loop the pipeline flows
straight into collect → merge → verify → report → reflect with no further pause.

## Escalation

Only the five agent states can escalate. When an agent SUMMARY carries
`needs_clarification: true`, `progress_check` returns a stall reason and the
engine drives `to_unknown → escalate → awaiting_clarification`. The user's
clarification resumes at `investigate` via `clarify`. No verifier gate is
invented; VERIFY is the sole external oracle and cannot fabricate a PoC.

## INVESTIGATE parallel batch fan (per-class)

- `investigate` is a PARALLEL fan (`dynamic_branches["investigate"]`): one annie
  branch per candidate vuln class (fresh context, focused on a single class + its
  `assets/references/<class>.md` catalog), plus a trailing generalist-sweep branch.
- Branches run in BATCHES of up to `max_fan_width` agents CONCURRENTLY (jsa default
  5, `constraints["max_fan_width"]`; also the engine's fan ceiling).
  `total_batches = ceil(len(candidate_classes) / max_fan_width) + 1`; with zero
  candidate classes that is a single sweep batch. annie always runs at least the
  sweep (≥ 1 batch), never silently skipped. No cap/fold — every class is covered.
- On each batch's fan-in, `route_after` accumulates `findings`/`unverified` across
  the batch's branches, increments `batch`, and — while `batch < total_batches` —
  emits the next batch (`_emit_batch`) and fires `investigate_wave`; otherwise
  `investigate_done` straight to `collect`.
- A branch reporting UNCERTAIN makes the batch's weakest confidence UNCERTAIN and
  escalates via the engine HITL seam (`to_unknown` → `awaiting_clarification`).
- Findings still unverified after all batches are surfaced honestly as
  `unverified_after_waves` in the result payload.

## Completion

`done_predicate` is met when `reflect` completed AND a `verify` verdict was
recorded.

## Per-state SUMMARY contracts

Each agent state validates its SUMMARY against a `PrimitiveSpec` contract.

| State | Agent | Required keys | Notable optional keys |
|-------|-------|---------------|-----------------------|
| `investigate` | annie | `wave_complete`, `confidence` | `findings_count`, `verified_count`, `unverified_count`, `needs_clarification`, `clarifying_questions` |
| `merge` | synthia | `merge_complete`, `confidence` | `merged_count`, `needs_clarification` |
| `verify` | vera | `verdict`, `gaps`, `confidence`, `evidence` | `verified_count`, `refuted_count`, `out_of_scope_count`, `needs_clarification` |
| `report` | skribble | `report_complete`, `confidence`, `application_context` | `reports_written`, `cvss_scored`, `needs_clarification` |
| `reflect` | carren | `reflect_complete` | `confidence`, `patterns_count`, `new_rules`, `needs_clarification` |

VERIFY's `evidence` is required as a list (Rec 4): vera must attach the executed
browser-PoC transcripts. It is NOT forced non-empty — a clean target
legitimately yields an empty transcript list; forcing non-empty would pressure
fabricating a PoC.

REPORT's `application_context` is likewise required as a list: skribble must
carry, per verified finding, a description of the vulnerability WITHIN THE
CONTEXT OF THE APPLICATION — its exploitability and concrete impact (data, users,
functions at risk, chainability) — IN ADDITION TO the CVSS 4.0 vector. The CVSS
score does NOT replace this impact narrative. Like VERIFY's `evidence`, it is
kept in `required` but not forced non-empty, so a zero-finding run honestly emits
an empty list.

REFLECT's optional `new_rules` carries carren's authored semgrep rules (see
Self-Improving SAST below).

## MemPalace rooms

Wing: `wing_jsa`. Rooms (from `_rooms(session_id)`):

- `{session_id}-mesh` — who's working on what
- `{session_id}-feed` — findings, hints, status
- `{session_id}-findings` — raw per-agent findings
- `{session_id}-merged` — deduplicated merged findings
- `{session_id}-sast-findings` — SAST scan output
- `{session_id}-cve-research` — CVE research output
- `{session_id}-verified` — verified findings
- `{session_id}-reports` — structured reports
- `jsa-learnings` — cross-session pattern corrections (persistent)

The subprocess cannot call MCP tools, so `sast_scan` / `cve_research` write
results to `{output_dir}/mempalace_stubs.json`; the completion `result` instructs
Penny to replay `memory_add_drawer` for each stub into the `sast-findings` and
`cve-research` rooms.

---

## Structure-and-Slice Architecture

The deep analysis pass uses a typed analysis store and per-class candidate
generation across the `structure` → `slice` → `investigate` states.

### STRUCTURE — Builds typed analysis store
- Parses JS files with tree-sitter for AST indexes
- Parses HTML files for DOM inventory (PageCard)
- Extracts dangerous patterns via tree-sitter queries (`innerHTML`, `eval`, `Object.assign`, `fetch`, `location.*`, `setTimeout` with strings, `postMessage` listeners)
- Builds ModuleCard (per JS/HTML file) and PageCard (per crawled page)
- Queries Caido for HTTP history (graceful degradation if not running)

### SLICE — Per-class candidate generation
- Uses vuln-class heuristics and tree-sitter pattern matching
- When available, uses Joern CPG queries for data flow analysis
- Caps at 20 candidates per vuln class to prevent card explosion
- Emits FlowCard records with proper CWE + sink mapping + lane assignment

### INVESTIGATE — Per-lane agent work (consumes cards)
- **code_static lane**: receives FlowCard (source/sink/sanitizer info, ~50-200 lines of code)
- **page_dom lane**: receives PageCard + relevant FlowCards (HTML structure + JS correlation)
- **network_behavior lane**: receives PageCard with Caido HTTP history (request/response, headers)

## F3 Hybrid Python+LLM Architecture

INVESTIGATE uses a hybrid Python+LLM verification layer. The F0 Python pre-pass
runs during `slice` (seeding the wave plan); the LLM verifier runs inside annie's
waves on annie's configured agent model.

### Why Hybrid?

| Approach | Accuracy | Verdict |
|---|---|---|
| All-LLM (every finding through the model) | ~100% | Slow / not viable at scale |
| Pure Python engines | ~80% | Too lossy |
| **F3 Hybrid (Python + LLM)** | **~95%+** | Recommended |

### Python Verifier (F0)

Each vuln class has a `VulnerabilityAnalyzer` (in `scripts/analyzers/`) that:
- Declares source/sink pairs (`SourceSink`)
- Declares PoC payload templates (`PayloadTemplate`)
- Generates verification procedures for specific findings
- Assesses exploitability with CSP/TrustedTypes awareness
- Returns CVSS 4.0 base vectors

The `PythonVerifier` (in `scripts/analyzers/verifier.py`) orchestrates:
1. `VulnerabilityAnalyzer.assess_exploitability(finding)` → `exploitable` + `difficulty`
2. Compute confidence score (0.0-1.0):
   - Baseline 0.5
   - +0.20 for exploitable + low difficulty
   - +0.15 if SAST match
   - +0.20 if Joern data flow confirms
   - +0.10 if runtime evidence
   - -0.10 per sanitizer
   - -0.05 per taint hop beyond first
3. Map to confidence level:
   - `confirmed` ≥0.85 (ship as-is)
   - `high` ≥0.65 (spot-check 20%)
   - `medium` ≥0.45 (LLM verify all)
   - `low` ≥0.25 (LLM verify all)
   - `candidate` <0.25 (LLM deep analysis)
4. Build LLM packet for findings needing verification. `needs_llm` (the count of
   findings requiring LLM verification) drives the INVESTIGATE wave plan.

### LLM Verifier (F2/F3)

For findings needing LLM verification:
- Build compact packet (4-15K tokens)
- Call annie's configured agent model
- Parse verdict: CONFIRM / REFUTE / NEEDS_DEEPER
- Apply confidence delta:
  - +0.20 if LLM agrees with Python
  - -0.30 if LLM contradicts Python
  - 0.00 if LLM uncertain
- Update finding evidence with LLM verdict + reasoning

### LLM Packet Types

| Type | Size | Use Case | LLM Output |
|------|------|----------|------------|
| `verification` | 4-6K tokens | Medium/low confidence findings | CONFIRM / REFUTE / NEEDS_DEEPER |
| `deep_analysis` | 10-15K tokens | Multi-step chains (3+ taint hops) | EXPLOITABLE / NOT_EXPLOITABLE + exploit path + PoC |
| `correlation` | 4-8K tokens | Multiple related findings | CHAIN_DETECTED + chain type + severity promotion |

## Analyzers (22 vulnerability-class analyzers)

The 22 vulnerability-class analyzers (`scripts/analyzers/*.py`), reference catalogs
(`assets/references/<class>.md`), and lane labels are **1:1:1**.
`lane_router.get_all_analyzers()` returns exactly the 22 classes across three lanes;
a drift-guard test fails if the router, the analyzer files, and the reference
catalogs ever diverge. (The former per-class worker prompts were retired; their
content was harvested into the catalogs, which annie and the deterministic verifier
now read.)

### File-Level (code_static lane) — 13 routed
- `dom_xss` — DOM-based XSS
- `prototype_pollution` — Object.assign, __proto__ manipulation
- `csti` — Client-side template injection
- `postmessage` — Cross-origin messaging
- `open_redirect` — location.href = userInput
- `secret_disclosure` — API keys, tokens in source
- `request_override` — Header manipulation
- `link_manipulation` — DOM link hijacking
- `dom_data_manipulation` — DOM data exfiltration
- `ssrf` — Server-side request forgery via fetch
- `sqli` — SQL injection (string concat)
- `http_header_injection` — Header injection via user input
- `insecure_deserialization` — JSON.parse, eval on untrusted

### Page-Level (page_dom lane) — 3 routed
- `dom_clobbering` — HTML form clobbering
- `reflected_xss` — URL parameter reflection
- `stored_xss` — Persistent XSS

### Network-Level (network_behavior lane) — 6 routed
- `cors` — CORS misconfigurations
- `clickjacking` — Missing X-Frame-Options
- `idor` — Insecure direct object references
- `cache_poisoning` — Cache poisoning via headers
- `http_smuggling` — HTTP request smuggling
- `csrf` — CSRF (verification needs HTTP history: does the request validate a token/origin?)

## Key Architectural Decisions

- **INTAKE is the only human gate.** After the INVESTIGATE wave loop the pipeline
  flows straight `investigate → collect → merge → verify → report → reflect →
  complete` with no continue/stop checkpoint.
- **Model-agnostic fleet.** Each agent runs the model declared in its own
  `.pi/agents/<name>.md` — annie, vera, synthia, skribble on `glm-5.2:cloud`;
  carren on `deepseek-v4-pro:cloud`. There is no per-state model override.
- **Structure-and-Slice.** STRUCTURE builds a typed analysis store and emits
  PageCard/ModuleCard; SLICE extracts per-class candidate flows as FlowCard;
  INVESTIGATE dispatches per-lane consuming these cards.
- **F3 Hybrid Python+LLM.** Python engines handle ~80% of findings
  deterministically; the investigate agent's model handles the ~20% of nuanced
  cases that need judgment.
- **Self-improving SAST (reflect).** For every confirmed vulnerability the
  deterministic scanner MISSED, carren authors a new semgrep rule, validates it
  with `semgrep --validate`, and persists it to
  `.pi/extensions/semgrep/rules/learned/jsa/` — which future runs load
  automatically, so the scanner gets permanently more robust every run.
- **No date filter on CVEs.** Date is a ranking signal, not an inclusion gate.
- **purl as canonical component ID.** Reconciles Wappalyzer names, npm names,
  filenames, source-map names into one stable identifier.
- **Separate dedup for each evidence stream.** Components, vulnerabilities, and
  code findings are deduplicated independently, then linked via explicit
  correlation edges (not merged).
- **VEX-style status.** affected / not_affected / loaded / loaded_not_reachable /
  potentially_reachable / exploitable / not_exploitable / under_investigation /
  fixed — per CycloneDX VEX spec.

## Artifact Directories

Heavy artifacts live on disk under `output_dir` (default `/tmp/jsa-{hostname}`);
lean run state lives in the engine checkpointer.

```
{output_dir}/
├── cves/                          # cve_research artifacts
│   ├── cves.json                 # All CVEs
│   ├── cves.md                   # Human-readable report
│   └── CVE-XXXX-XXXX/            # Per-CVE directory
│       ├── cve.json
│       └── description.md        # Includes PoC & Validation section
├── assets/js/                    # acquire: downloaded JS files
├── sast/                          # sast_scan output
├── typed_store/                   # structure: typed analysis store
│   ├── manifest.json             # File metadata
│   └── ast_indexes/              # Per-file AST indexes
├── cards/                         # structure/slice: card records
│   ├── module_cards.json
│   ├── page_cards.json
│   └── flow_cards.json
├── llm_packets/                   # F3: LLM verification packets
│   └── {finding_id}.json
├── findings/                      # Per-finding reports
├── evidence/                      # PoC evidence, screenshots
└── mempalace_stubs.json           # SAST/CVE stubs replayed into wing_jsa by Penny
```
