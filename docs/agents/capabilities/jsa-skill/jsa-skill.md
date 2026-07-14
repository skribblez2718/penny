# JSA Skill — JavaScript Security Analysis

## What

A production-grade, multi-agent pipeline that downloads and analyzes JavaScript from a target URL or local source, runs SAST, correlates evidence, structures and slices the code, dispatches per-vulnerability-class agents, and verifies findings with browser-based proof-of-concept testing.

## Why

Manual bug-bounty analysis of large JS bundles is slow and error-prone. JSA automates the noisy SAST pass, focuses deep analysis on high-value candidates, and produces independently verified, structured findings.

## Rules

1. **Use only for JavaScript targets.** Do not use for network scanning, subdomain discovery, binary analysis, or server-side codebases.
2. **Scope is enforced.** `out_of_scope` URL substrings are respected by ACQUIRE, INVESTIGATE, and VERIFY.
3. **Runs on the shared orchestration engine.** `jsa` is a `BasePlaybook` subclass (`JSAPlaybook`) at `apps/orchestration/src/orchestration/playbooks/jsa.py`. The many deterministic phases are engine `TOOL_STATES` executed inline (no agent); only `investigate`/`merge`/`verify`/`report`/`reflect` are agent primitive states (`annie`, `synthia`, `vera`, `skribble`, `carren`) that communicate via mempalace. `intake` is the sole engine `GATE_STATE` — the one human gate; there is no `stop` gate. Each agent runs the model declared in its own `.pi/agents/<name>.md` card (`annie`/`vera`/`synthia`/`skribble` = `glm-5.2:cloud`, `carren` = `deepseek-v4-pro:cloud`); there is no per-state model override.
4. **Do not run destructive PoCs.** All browser verification uses `alert()`, `console.log()`, or `confirm()` only — no exfiltration, redirects, or persistent mutations.
5. **`output_dir` belongs outside the project tree.** If a path resolves inside the project tree it is auto-redirected to `/tmp/jsa-{hostname}`.
6. **`out_of_scope` and `output_dir` are top-level constraints.** Do not nest them inside `constraints.intake`.

## Procedure

### Invocation

```typescript
// Full analysis — all 22 vuln classes
skill({
  skill_name: "jsa",
  goal: "Analyze JavaScript on https://example.com",
})

// Specific vuln classes
skill({
  skill_name: "jsa",
  goal: "Analyze JavaScript on https://example.com",
  analyzers: ["dom_xss", "prototype_pollution", "postmessage"],
})

// Local source
skill({
  skill_name: "jsa",
  goal: "Analyze JavaScript in ./src/app/",
})
```

Required intake fields (pass via `constraints.intake` to skip escalation):

| Field | Required? | Description |
|-------|-----------|-------------|
| `target_url` | Yes | URL or source path |
| `authenticated_testing` | Yes | `anonymous_only`, `both`, `authenticated_only` |
| `session_management` | Yes | `cookie`, `jwt_header`, `oauth2`, `custom_header`, `mixed` |
| `auth_instructions` | If not `anonymous_only` | How to authenticate |
| `out_of_scope` | No | Top-level constraint, list of URL substrings |
| `output_dir` | No | Top-level constraint, defaults to `/tmp/jsa-{hostname}` |

```typescript
skill({
  skill_name: "jsa",
  goal: "Analyze JavaScript on https://ginandjuice.shop",
  constraints: {
    output_dir: "/tmp/gin-and-juice-test",
    out_of_scope: ["https://ginandjuice.shop/vulnerabilities"],
    intake: {
      target_url: "https://ginandjuice.shop",
      authenticated_testing: "both",
      auth_instructions: "login at /login as carlos/hunter2",
      session_management: "cookie",
    },
  },
})
```

### Engine states (`JSAMachine`)

```
intake ─(gate)→ acquire → cve_research → sast_scan → normalize → dedup_within_source
→ correlate_evidence → agent_review → sast_validate → structure → slice
→ investigate ⟲(wave loop) → collect → merge → verify → report → reflect → complete
```

State names, transitions, and per-state SUMMARY contracts are defined in
`JSAMachine` / `JSAPlaybook`. The deterministic phases are engine `TOOL_STATES`
(`TOOL_STATES = frozenset(_TOOL_EVENT)`) run inline by `run_tool_state`; agent
phases are `PRIMITIVE_BY_STATE`; `intake` is the sole `GATE_STATE` (`GATE_STATES = frozenset({"intake"})`).

| State | Type | Run By | What happens |
|-------|------|--------|--------------|
| `intake` | GATE | — | Validate required fields against `INTAKE_SCHEMA`. Missing/invalid → pause on the engine gate, `gate_questions` surfaces only the still-missing fields, `route_user` merges the answer and re-validates. Valid (or seeded from `constraints`) → fire into `acquire` |
| `acquire` | TOOL (local) | — | Download JS, extract inline scripts, crawl pages |
| `cve_research` | TOOL (local) | — | Wappalyzer fingerprinting, source maps, version extraction, OSV.dev lookup |
| `sast_scan` | TOOL (local) | — | semgrep (jsa preset) + jsluice secrets/URLs |
| `normalize` | TOOL (local) | — | Deduplicate components by purl, vulns by CVE aliases, assign VEX status |
| `dedup_within_source` | TOOL (local) | — | Merge SAST findings by SARIF fingerprints |
| `correlate_evidence` | TOOL (local) | — | Typed edges linking components, CVEs, and SAST findings; `select_agent_candidates()` filters to score 0.45–0.85 |
| `agent_review` | TOOL (local heuristic) | — | LOCAL despite the name — reviews ambiguous correlation edges via bounded evidence packets; produces verdict + confidence_override |
| `sast_validate` | TOOL (local heuristic) | — | Triage SAST findings: `confirmed`, `false_positive`, `needs_deeper` |
| `structure` | TOOL (local) | — | Build typed store: `PageCard`, `ModuleCard`, AST indexes |
| `slice` | TOOL (local) | — | Per-class candidate generation, emit `FlowCard` records; seed the INVESTIGATE wave plan |
| `investigate` | AGENT (loop) | `annie` | Bounded wave loop — `total_waves = max(1, ceil(needs_llm / wave_size))`, runs at least one wave (the general sweep). **`wave_size` is a tunable Budget** (`constraints["wave_size"]`, default 10; the frozen `WAVE_SIZE` constant was removed per the Bitter-Lesson gate). `route_after` self-transitions (`investigate_wave`) until waves exhaust, then `investigate_done` fires straight into `collect` (no gate). Reports `unverified_count` honestly. Recall lessons seed the first directive |
| `collect` | TOOL (local) | — | Gather per-agent findings from mempalace `{session_id}-findings` room |
| `merge` | AGENT | `synthia` | Algorithmic dedup + cross-card stitching + confidence promotion |
| `verify` | AGENT | `vera` | Browser PoC (external evidence oracle): navigate, inject payloads, capture screenshots; enforces `out_of_scope`; SUMMARY `evidence` contract requires the executed-PoC transcripts (a bare `verdict` is rejected) |
| `reverify` | AGENT | `vera` | **Optional dual-verify (Rec 5, `constraints.dual_verify`):** a PASS at `verify` routes to a SECOND independent verifier (on `constraints.reverify_model` via `model_for_state`) that reproduces the verified findings from scratch; only findings BOTH passes confirm are reported verified. Agreement is recorded (`dual_verify_agreed`). Off by default → `verify` goes straight to `report` |
| `report` | AGENT | `skribble` | Write structured finding reports. Per verified finding: title, an application-context narrative (the vulnerability's exploitability and concrete impact within THIS app — data/users/functions at risk, chainability), steps-to-reproduce, code analysis, remediation, and a CVSS 4.0 vector. The score does NOT replace the impact narrative; `application_context` is a required SUMMARY field |
| `reflect` | AGENT | `carren` | Self-improving-SAST loop: for every CONFIRMED vuln the deterministic scanner MISSED, author a new semgrep rule (`new_rules`), validated with `semgrep --validate` and persisted to `.pi/extensions/semgrep/rules/learned/jsa/` so future runs auto-load it — the scanner gets permanently more robust each run. Also writes FP/FN patterns to `jsa-learnings` |
| `complete` | final | — | Pipeline done; `result_payload` carries counts + the mempalace-stub handoff |

### Escalation, persistence, and resilience

- **Escalation (HITL):** the agent states (`ESCALATABLE_STATES = {investigate, merge, verify, report, reflect}`) escalate on `confidence: UNCERTAIN` or `progress_check` returning a `needs_clarification` reason. The engine drives `to_unknown → escalate` (`unknown → awaiting_clarification`) and pauses the run. The user's answer resumes the SAME `run_id` via a `user` step; `clarify` re-enters the agent portion at `investigate`. The deterministic pipeline is not re-run.
- **State is durable.** FSM position + lean domain state (`ctx.extras["jsa"]`) live in the engine's SQLite checkpointer keyed by `run_id` — there is no `session.json` FSM file, no `--state`/`--state-data` argv. A run interrupted mid-step re-issues that step on recover; the deterministic tool bodies are idempotent.
- **Summary validation is the engine's job** (`validate_summary_contract` against each `PrimitiveSpec`). Empty or malformed summaries are rejected; the run does not advance on fabricated defaults.
- **Honest exhaustion.** Findings still unverified after the bounded waves are reported (`unverified_after_waves`) rather than silently dropped or claimed as verified.

### Three-lane dispatch

After SLICE, each `FlowCard` is routed to one of three lanes:

| Lane | Analyzers | Packet type |
|------|-----------|-------------|
| `code_static` | `dom_xss`, `prototype_pollution`, `csti`, `postmessage`, `open_redirect`, `secret_disclosure`, `request_override`, `link_manipulation`, `dom_data_manipulation`, `ssrf`, `sqli`, `http_header_injection`, `insecure_deserialization` | `FlowCard` (~50–200 lines, source/sink/sanitizer) |
| `page_dom` | `dom_clobbering`, `reflected_xss`, `stored_xss` | `PageCard` + relevant `FlowCards` |
| `network_behavior` | `cors`, `clickjacking`, `idor`, `cache_poisoning`, `http_smuggling`, `csrf` | `PageCard` + Caido HTTP history |

### Two-pass analysis architecture

1. **Pass 1 — deterministic automation (seconds):** ACQUIRE, CVE_RESEARCH, SAST_SCAN, and correlation layers produce a filtered evidence set.
2. **Pass 2 — deep analysis (minutes):** STRUCTURE, SLICE, and INVESTIGATE focus on multi-step chains, framework bypasses, and patterns SAST misses.

Agents in pass 2:
- Skip SAST `confirmed` findings (already found)
- Ignore `false_positive` findings (validated noise)
- Verify `needs_deeper` items
- Find chains and bypasses

### Output structure

```
{output_dir}/
├── report.md
├── assets/
│   ├── js/{slug}.js
│   └── html/{slug}.html
├── sast/
│   ├── semgrep-results.json
│   └── jsluice-results.json
├── findings/
│   └── F-NNN_{vuln-title}/
│       ├── report.md
│       ├── screenshots/poc.png
│       └── poc/exploit.html
└── evidence/
    └── crawl/
```

Each finding report contains:
1. Title
2. Application-Context Description — the vulnerability's exploitability and concrete impact within THIS application (which data/users/functions are at risk, and whether it chains with other findings)
3. Steps to Reproduce
4. Code Analysis
5. Remediation
6. CVSS 4.0 vector (scores severity; does not replace the application-context impact narrative)

## Constraints

- Maximum candidates per vuln class are capped during SLICE to prevent card explosion.
- `out_of_scope` is a substring match; partial URLs that contain the substring are never fetched or tested.
- Authentication state is handled according to `session_management` and `auth_instructions`.
- Browser PoC verification is non-destructive by policy.

## Verification

- [ ] ACQUIRE produced a non-empty file map or crawled pages.
- [ ] SAST_SCAN completed and produced fingerprints.
- [ ] STRUCTURE emitted `PageCard`/`ModuleCard` records.
- [ ] SLICE emitted `FlowCard` records with lane assignments.
- [ ] INVESTIGATE agents consumed bounded packets, not full source trees.
- [ ] Each reported finding has a `screenshots/poc.png` or equivalent verifier evidence.
- [ ] `REFLECT` authored + `semgrep --validate`'d a new learned rule for every confirmed scanner miss (persisted to `.pi/extensions/semgrep/rules/learned/jsa/`) and wrote learnings to `jsa-learnings`.

## Files

| File | Purpose |
|------|---------|
| `apps/orchestration/src/orchestration/playbooks/jsa.py` | `JSAPlaybook` / `JSAMachine` — states, transitions, SUMMARY contracts, gates, wave loop, tool-state bodies, escalation |
| `apps/orchestration/tests/test_jsa_playbook.py` | Playbook tests (override the `_domain_run` seam; no real scanner runs) |
| `.pi/skills/jsa/scripts/orchestrate.py` | ~5-line delegate: `raise SystemExit(main(default_playbook="jsa"))` |
| `.pi/skills/jsa/scripts/jsa_domain.py` | Domain seam the deterministic tool bodies bridge to (legacy scan/handler modules) |
| `.pi/skills/jsa/SKILL.md` | Skill definition and full invocation spec (`metadata.penny.engine: orchestration`) |
| `.pi/skills/jsa/assets/prompts/annie-*.md` | Per-class worker prompts |
| `.pi/skills/jsa/assets/prompts/{agent}-base.md` | Per-agent protocol prompts (loaded via `skill_context` / `_PROMPT_BY_STATE`) |
| `.pi/skills/jsa/assets/references/*.md` | Reference catalogs for each vuln class |
| `docs/humans/capabilities/jsa-skill/jsa-skill.md` | Human-facing overview |
