# jsa Skill Reference

Quick reference for the JavaScript Security Analysis skill.

## Pipeline Phases (18 permanent + 1 temporary checkpoint)

| Phase | Type | Actor | Description |
|-------|------|-------|-------------|
| 1. INTAKE | escalate | Penny | Parse goal, extract target URL, scope, auth mode, session management |
| 2. ACQUIRE | local | Playwright + jsluice | Download JS files: external scripts, inline blocks, jsluice-discovered URLs (feedback loop). Runtime probes for version detection. |
| 3. CVE_RESEARCH | local + agent | Wappalyzer + OSV.dev + VL + echo agents | **Independent stream.** Fingerprint tech stack (Wappalyzer + source maps + content regex), generate purl IDs, lookup CVEs (no date filter), assign VEX status, dispatch PoC research agents in parallel, write artifacts |
| 4. SAST_SCAN | local | semgrep + jsluice | **Independent stream.** Run semgrep (24 rulesets) + jsluice secrets/urls. Output SARIF-style findings |
| 5. NORMALIZE | local | dedup_components + dedup_vulnerabilities | Normalize components (purl canonical ID) and vulnerabilities (CVE alias canonicalization). Assign VEX status per CVE |
| 6. DEDUP_WITHIN_SOURCE | local | scanner_dedup | SAST fingerprint dedup via `merge_scanner_findings()` (SARIF fingerprints + similarity) |
| 7. CORRELATE_EVIDENCE | local | correlate_evidence | Cross-stream correlation via typed edges. Hard gates + positive/negative signals + `select_agent_candidates()` (score 0.45-0.85) |
| 8. AGENT_REVIEW | agent | annie | Reviews ambiguous correlation edges via **bounded evidence packets** (edge + component + vuln + SAST context, no raw code). Produces verdicts + confidence_override + recommended_action |
| 9. SAST_VALIDATE | local | heuristic | Classify findings: confirmed / false_positive / needs_deeper, informed by correlation evidence (first-party vs third-party awareness) |
| 10. STRUCTURE | local | structure_handler | **Phase B+** — Build typed analysis store. Parse HTML for page context, query Caido (graceful if unavailable), build PageCard/ModuleCard. Replaces old CHUNK phase. |
| 11. SLICE | local | slice_handler | **Phase B+** — Per-class candidate generation + vulnerability-specific slice extraction (Joern CPG with graceful degradation). Build FlowCard. Replaces CHUNK+DISPATCH anti-pattern. |
| 12. INVESTIGATE | hybrid | Python + LLM | **Phase D/F3** — Per-lane work item generation + Python verification + LLM packet building. Consumes FlowCards, produces Findings. Three lanes: code_static, page_dom, network_behavior. |
| 13. COLLECT | local | Python | Gather findings from MemPalace + state.raw_findings |
| 14. MERGE | local | dedup.py | Dedup + cluster + confidence promotion |
| 15. VERIFY | agent | vera | Browser-based PoC verification |
| 16. REPORT | agent | skribble | Write structured bug bounty reports |
| 17. REFLECT | agent | carren | Cross-session FP/FN pattern corrections |
| 18. COMPLETED | — | — | Pipeline finished |

## Independent Streams (run after ACQUIRE)

CVE_RESEARCH (phase 3) and SAST_SCAN (phase 4) are **independent**. Both depend on
ACQUIRE output but not on each other. They run sequentially in `run_pipeline()`,
but the PoC agent dispatch (echo) within CVE_RESEARCH runs in parallel with
SAST scan execution. Both streams converge at NORMALIZE (phase 5).

```
ACQUIRE ──→ ┌ CVE_RESEARCH (fingerprint + CVE + PoC) ─┐
            └ SAST_SCAN (semgrep + jsluice)            ─┴─→ NORMALIZE
                                                          → DEDUP_WITHIN_SOURCE
                                                          → CORRELATE_EVIDENCE
                                                          → AGENT_REVIEW
                                                          → SAST_VALIDATE
                                                          → STRUCTURE
                                                          → SLICE
                                                          → INVESTIGATE (Python + LLM)
                                                          → COLLECT
```

> **Note:** A temporary interactive checkpoint (STOP) is positioned
> **immediately after INVESTIGATE (Phase 12)** in the current pipeline.
> This placement was chosen (Phase E+, 2026-06) to enable full end-to-end
> testing of all phases up through the F3 hybrid (Python+LLM) verification
> layer. The STOP directive displays INVESTIGATE results (cards produced,
> work items planned, F3 hybrid confidence distribution) and asks the
> user to confirm before proceeding to COLLECT.
> STRUCTURE → SLICE → INVESTIGATE replaces the old CHUNK → DISPATCH sequence.
> STRUCTURE builds typed analysis store + PageCard/ModuleCard. SLICE
> extracts per-class candidate flows as FlowCard. INVESTIGATE dispatches
> agents per-lane consuming these cards (with F3 hybrid Python+LLM
> verification).
> CHUNK and DISPATCH are deprecated; the old `chunk_handler` is a no-op stub.

## Structure-and-Slice Architecture (Phase B, 2026-06)

The deep analysis pass uses a typed analysis store and per-class candidate generation:

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

### INVESTIGATE — Per-lane agent dispatch (consumes cards)
- **code_static lane**: receives FlowCard (source/sink/sanitizer info, ~50-200 lines of code)
- **page_dom lane**: receives PageCard + relevant FlowCards (HTML structure + JS correlation)
- **network_behavior lane**: receives PageCard with Caido HTTP history (request/response, headers)

## F3 Hybrid Python+LLM Architecture (Phase D-F3, 2026-06)

The deep analysis pass now uses a hybrid Python+LLM verification layer that respects
the constraint of running a single local model (qwen3.6:27b-coder) on 2x RTX 4090.

### Why Hybrid?

| Approach | Time | GPU Usage | Accuracy | Verdict |
|---|---|---|---|---|
| All-LLM (1 model, sequential) | 43-86 hours | 100% | ~100% | ❌ Not viable |
| Pure Python engines | 3 minutes | 0% | ~80% | ⚠️ Too lossy |
| **F3 Hybrid (Python + LLM)** | **~8-10 hours** | **30-50%** | **~95%+** | ✅ **Recommended** |

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
4. Build LLM packet for findings needing verification

### LLM Verifier (F2/F3)

For findings needing LLM verification:
- Build compact packet (4-15K tokens)
- Call Ollama (qwen3.6:27b-coder, `think=false` to save tokens)
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

### KV Cache Considerations (qwen3.6:27b-coder)

- Model: Q4_K_M, 17GB on disk
- Context: 262K tokens (Q8_0 KV cache)
- Per-GPU VRAM: 24GB; model uses 8.5GB; KV cache has 15.5GB
- Our packets (5-15K tokens) are way under the 262K context limit
- **Recommendation**: Stay with Q8_0 KV cache. Going to FP16 would cut context to ~108K for <1% quality gain. Going to Q4_0 would lose 3-5% quality for no real benefit.

## Analyzers (22 vulnerability classes)

### File-Level (code_static lane)
- `dom_xss` (complete, 248 lines) — DOM-based XSS
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
- `insecure_deserialization` — JSON.parse, eval on untrusted
- `http_header_injection` — Header injection via user input

### Page-Level (page_dom lane)
- `dom_clobbering` — HTML form clobbering
- `reflected_xss` — URL parameter reflection
- `stored_xss` — Persistent XSS
- `csrf_dom` — DOM-based CSRF

### Network-Level (network_behavior lane)
- `cors` — CORS misconfigurations
- `clickjacking` — Missing X-Frame-Options
- `idor` — Insecure direct object references
- `cache_poisoning` — Cache poisoning via headers
- `http_smuggling` — HTTP request smuggling
- `csrf_network` — Network-based CSRF

## Action Types

| Action | Meaning |
|--------|---------|
| `agent` | Delegate to a subagent (annie, vera, skribble, carren, echo) |
| `tool` | Invoke a Pi tool (semgrep, jsluice, playwright) |
| `local` | Execute locally in Python |
| `escalate` | Pause for user input (INTAKE questionnaire) |
| `complete` | Pipeline finished |
| `error` | Something went wrong |

## MemPalace Rooms

- `{session_id}-cve-validate-CVE-XXXX-XXXX` — Per-CVE PoC research results
- `{session_id}-sast-findings` — SAST scan output
- `{session_id}-sast-validated` — Validated SAST findings
- `{session_id}-page-cards` — **Phase B+** PageCard records from STRUCTURE
- `{session_id}-module-cards` — **Phase B+** ModuleCard records from STRUCTURE
- `{session_id}-flow-cards` — **Phase B+** FlowCard records from SLICE
- `{session_id}-findings` — Raw per-agent findings
- `{session_id}-merged` — Deduplicated merged findings
- `{session_id}-verified` — Verified findings
- `{session_id}-reports` — Structured reports
- `jsa-learnings` — Cross-session pattern corrections

## Key Architectural Decisions

- **Structure-and-Slice (Phase B, 2026-06):** The pipeline now follows the
  structure-and-slice architecture recommended in
  `agent-augmented-security-annalysis.md`. STRUCTURE builds a typed analysis
  store and emits PageCard/ModuleCard. SLICE extracts per-class candidate flows
  as FlowCard. INVESTIGATE dispatches agents per-lane consuming these cards.
  The old CHUNK → DISPATCH sequence was an anti-pattern (raw chunked corpus
  → agents re-derived candidates) and has been removed.
- **F3 Hybrid Python+LLM (Phase D-F3, 2026-06):** The deep analysis pass now
  uses a hybrid Python+LLM verification layer. Python engines (VulnerabilityAnalyzer
  + PythonVerifier) handle 80% of findings deterministically. LLM (qwen3.6:27b-coder
  via Ollama) handles the 20% of nuanced cases that need contextual understanding.
  This is the only approach viable for local single-model sequential execution
  on 2x RTX 4090.
- **No date filter on CVEs.** Date is a ranking signal, not an inclusion gate.
- **purl as canonical component ID.** Reconciles Wappalyzer names, npm names,
  filenames, source-map names into one stable identifier.
- **Separate dedup for each evidence stream.** Components, vulnerabilities, and
  code findings are deduplicated independently, then linked via explicit
  correlation edges (not merged).
- **VEX-style status.** affected / not_affected / loaded / loaded_not_reachable /
  potentially_reachable / exploitable / not_exploitable / under_investigation /
  fixed — per CycloneDX VEX spec.
- **STOP is a temporary interactive checkpoint, not a permanent phase.** STOP
  is positioned immediately after INVESTIGATE (Phase 12) to enable full
  end-to-end testing of the F3 hybrid (Python+LLM) verification layer.
  The STOP directive shows INVESTIGATE results (cards produced, work items
  planned, confidence distribution) and asks the user to confirm before
  proceeding to COLLECT. STOP is in the FSM enum, transitions, and flow
  diagrams.

## Artifact Directories

```
{output_dir}/
├── cves/                          # CVE_RESEARCH artifacts
│   ├── cves.json                 # All CVEs
│   ├── cves.md                   # Human-readable report
│   └── CVE-XXXX-XXXX/            # Per-CVE directory
│       ├── cve.json
│       └── description.md        # Includes PoC & Validation section
├── assets/js/                    # ACQUIRE: downloaded JS files
├── sast/                          # SAST_SCAN output
├── typed_store/                   # STRUCTURE: typed analysis store
│   ├── manifest.json             # File metadata
│   └── ast_indexes/              # Per-file AST indexes
├── cards/                         # STRUCTURE/SLICE: card records
│   ├── module_cards.json
│   ├── page_cards.json
│   └── flow_cards.json
├── llm_packets/                   # F3: LLM packets sent to Ollama
│   └── {finding_id}.json
├── findings/                      # Per-finding reports
└── evidence/                      # PoC evidence, screenshots
```

## Test Coverage (as of 2026-06-10)

| Component | Test File | Tests |
|-----------|-----------|-------|
| Phase functionality | `test_phase_functionality.py` | 87 |
| Per-phase | various | 700+ |
| F0 Verifier | `test_f0_verifier.py` | 38 |
| F0.7 Integration | `test_f0_7_integration.py` | 10 |
| F2 LLM Client | `test_f2_llm_client.py` | 29 (3 real Ollama) |
| F3 Orchestrator | `test_f3_orchestrator.py` | 16 (1 real Ollama) |
| E2E Pipeline | `test_e2e_pipeline.py` | 18 |
| Other (dedup, merge, etc.) | various | 80+ |
| **Total** | — | **1022** |
