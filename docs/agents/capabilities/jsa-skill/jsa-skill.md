# JSA Skill — JavaScript Security Analysis

## What

A production-grade, multi-agent pipeline that downloads and analyzes JavaScript from a target URL or local source, runs SAST, correlates evidence, structures and slices the code, dispatches per-vulnerability-class agents, and verifies findings with browser-based proof-of-concept testing.

## Why

Manual bug-bounty analysis of large JS bundles is slow and error-prone. JSA automates the noisy SAST pass, focuses deep analysis on high-value candidates, and produces independently verified, structured findings.

## Rules

1. **Use only for JavaScript targets.** Do not use for network scanning, subdomain discovery, binary analysis, or server-side codebases.
2. **Scope is enforced.** `out_of_scope` URL substrings are respected by ACQUIRE, INVESTIGATE, and VERIFY.
3. **Penny routes; agents execute.** The heavy phases (ACQUIRE, SAST, STRUCTURE, SLICE) run locally; `annie`, `synthia`, `vera`, `skribble`, and `carren` agents communicate via mempalace.
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

### State machine phases

```
INTAKE → ACQUIRE → CVE_RESEARCH → SAST_SCAN → NORMALIZE → DEDUP_WITHIN_SOURCE
→ CORRELATE_EVIDENCE → AGENT_REVIEW → SAST_VALIDATE → STRUCTURE → SLICE
→ INVESTIGATE → COLLECT → MERGE → VERIFY → REPORT → REFLECT → COMPLETED
```

| Phase | Type | What happens |
|-------|------|--------------|
| `INTAKE` | config | Validate required fields; escalate via questionnaire if missing |
| `ACQUIRE` | local | Download JS, extract inline scripts, crawl pages |
| `CVE_RESEARCH` | local | Wappalyzer fingerprinting, source maps, version extraction, OSV.dev lookup |
| `SAST_SCAN` | local | semgrep (jsa preset, 369 rules) + jsluice secrets/URLs |
| `NORMALIZE` | local | Deduplicate components by purl, vulns by CVE aliases, assign VEX status |
| `DEDUP_WITHIN_SOURCE` | local | Merge SAST findings by SARIF fingerprints |
| `CORRELATE_EVIDENCE` | local | Typed edges linking components, CVEs, and SAST findings |
| `AGENT_REVIEW` | `annie` | Review ambiguous correlation edges (score 0.45–0.85) via bounded evidence packets |
| `SAST_VALIDATE` | local heuristic | Triage SAST findings: `confirmed`, `false_positive`, `needs_deeper` |
| `STRUCTURE` | local | Build typed store: `PageCard`, `ModuleCard`, AST indexes |
| `SLICE` | local | Per-class candidate generation, emit `FlowCard` records |
| `INVESTIGATE` | `annie` × N | Per-lane agent dispatch consuming `FlowCard` / `PageCard` packets |
| `COLLECT` | local | Gather per-agent findings from mempalace |
| `MERGE` | `synthia` | Algorithmic dedup + cross-card stitching |
| `VERIFY` | `vera` | Browser PoC testing: navigate, inject payloads, capture screenshots |
| `REPORT` | `skribble` | Write structured finding reports (title, STR, CVSS 4.0, remediation) |
| `REFLECT` | `carren` | Identify FP/FN patterns and write to `jsa-learnings` |
| `COMPLETED` | — | Pipeline done |

### Three-lane dispatch

After SLICE, each `FlowCard` is routed to one of three lanes:

| Lane | Analyzers | Packet type |
|------|-----------|-------------|
| `code_static` | `dom_xss`, `prototype_pollution`, `sqli`, `ssrf`, `postmessage`, `csti`, `open_redirect`, `secret_disclosure`, `request_override`, `link_manipulation`, `dom_data_manipulation`, `insecure_deserialization`, `http_header_injection` | `FlowCard` (~50–200 lines, source/sink/sanitizer) |
| `page_dom` | `dom_clobbering`, `reflected_xss`, `stored_xss`, `csrf_dom` | `PageCard` + relevant `FlowCards` |
| `network_behavior` | `cors`, `clickjacking`, `idor`, `cache_poisoning`, `http_smuggling`, `csrf_network` | `PageCard` + Caido HTTP history |

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
├── session.json
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
2. Description
3. Steps to Reproduce
4. Code Analysis
5. Remediation
6. CVSS 4.0 vector

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
- [ ] `REFLECT` wrote learnings to `jsa-learnings`.

## Files

| File | Purpose |
|------|---------|
| `.pi/skills/jsa/SKILL.md` | Skill definition and full invocation spec |
| `.pi/skills/jsa/README.md` | Architecture overview |
| `.pi/skills/jsa/scripts/fsm.py` | `JSAPhaseMachine` and phase handlers |
| `.pi/skills/jsa/scripts/orchestrate.py` | Orchestrator entry point |
| `.pi/skills/jsa/scripts/structure_analysis.py` | STRUCTURE phase implementation |
| `.pi/skills/jsa/scripts/analyzers/*.py` | Per-vuln-class analyzer implementations |
| `.pi/skills/jsa/assets/prompts/annie-*.md` | Per-class worker prompts |
| `.pi/skills/jsa/assets/references/*.md` | Reference catalogs for each vuln class |
| `.pi/skills/jsa/tests/test_*.py` | Unit, integration, and phase tests |
| `docs/humans/capabilities/jsa-skill/jsa-skill.md` | Human-facing overview |
