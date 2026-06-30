# XSS Skill — Cross-site scripting detection and verification

## What

A focused security skill that hunts for XSS vulnerabilities on a web application or in source code, verifies findings with production-safe browser testing, and writes a structured vulnerability report.

## Why

XSS is a common, high-impact bug class. A dedicated workflow lets an agent apply vuln-specific TTPs, verify independently from a clean browser session, and produce a report usable for bug-bounty or triage workflows.

## Rules

1. **Testing is production-safe.** Use only `alert()`, `console.log()`, or `confirm()` payloads. No exfiltration, redirects, DOM mutation, or persistent changes without explicit approval.
2. **Scope must be explicit.** Provide a target URL, a source path, or both. Ambiguous input triggers an intake questionnaire.
3. **Platform and program are required for output paths.** If not provided in the goal or constraints, the skill escalates immediately via questionnaire.
4. **Do not claim DOM-based or mutation XSS.** v1 covers stored and reflected XSS only.
5. **Single vulnerability per invocation.** Report one confirmed finding; re-invoke for additional targets or surfaces.
6. **No blind-XSS callbacks or WAF-bypass payloads.** v1 does not support callbacks, external listeners, or evasion-heavy payloads.

## Procedure

### Invocation

```typescript
skill({
  skill_name: "xss",
  goal: "Find XSS on https://example.com/search",
})

skill({
  skill_name: "xss",
  goal: "Find XSS in ./src/app/",
})

skill({
  skill_name: "xss",
  goal: "Find XSS on https://example.com with source at ./src/",
})
```

### Input flexibility

| Input type | Example goal |
|------------|--------------|
| URL only | `"Find XSS on https://example.com"` |
| Source only | `"Find XSS in ./src/app/"` |
| Both | `"Find XSS on https://example.com with source at ./src/"` |

### Questionnaire

The skill may ask:

1. **Platform and program** — needed for the output path (`~/bug_bounty/<platform>/<program>/...`).
2. **Ambiguous inputs** — when the target or scope cannot be determined.

### Detection workflow

```
intake → navigate → detect_context → identify_injection_points
→ select_payloads → test → verify → report
```

| Step | What happens |
|------|--------------|
| `intake` | Validate goal, collect platform/program if missing |
| `navigate` | Load the target URL or source tree |
| `detect_context` | Identify framework, input surfaces, and data format |
| `identify_injection_points` | Find URL parameters, form fields, headers, and other sinks |
| `select_payloads` | Choose context-appropriate payloads (HTML, attribute, JS, URL) |
| `test` | Inject production-safe payloads |
| `verify` | Vera independently reproduces the finding from a clean browser session |
| `report` | Write structured finding to the bug-bounty directory |

### Payload generation

Payloads are selected based on the rendering context:

| Context | Example payload |
|---------|-----------------|
| HTML body | `'<img src=x onerror=alert(1)>` |
| Attribute | `'" onmouseover=alert(1) '` |
| JavaScript | `'; alert(1); //` |
| URL / href | `javascript:alert(1)` |

All payloads are non-destructive and avoid data exfiltration, redirects, or persistent mutations.

### Verification

- `vera` agent opens a fresh browser context.
- Replays the exact injection and reproduction steps.
- Captures a screenshot or console evidence.
- Confirms the payload executed in the expected context.

### Report sections

Reports are written to:

```
~/bug_bounty/<platform>/<program>/reports/<vuln-title>/report.md
```

Artifacts go to:

```
~/bug_bounty/<platform>/<program>/findings/xss/<vuln-title>/
```

Each report contains:

1. **Title** — descriptive and specific (e.g., "Reflected XSS in Search Parameter")
2. **Application Issue Description** — explanation within the app context
3. **Steps to Reproduce** — numbered, copy/paste executable steps
4. **Code Analysis** — source-to-sink walkthrough (when source is available)
5. **Remediation** — tech-stack-specific guidance with code examples

## Constraints

- v1 supports stored and reflected XSS only.
- Single vulnerability per invocation.
- No blind XSS callbacks.
- No WAF bypass payloads.
- Caido history parsing is not yet implemented.

## Verification

- [ ] Target context and injection points were identified.
- [ ] Payloads are production-safe (`alert` / `console.log` / `confirm` only).
- [ ] Vera independently reproduced the finding.
- [ ] Report includes all five required sections.
- [ ] Output paths include platform and program.

## Files

| File | Purpose |
|------|---------|
| `docs/humans/capabilities/xss-skill/xss-skill.md` | Human-facing overview |
| `.pi/skills/jsa/SKILL.md` | Current implementation: XSS analyzers (`dom_xss`, `reflected_xss`, `stored_xss`) live inside the JSA skill |
| `.pi/skills/jsa/scripts/analyzers/dom_xss.py` | DOM XSS analyzer |
| `.pi/skills/jsa/scripts/analyzers/reflected_xss.py` | Reflected XSS analyzer |
| `.pi/skills/jsa/scripts/analyzers/stored_xss.py` | Stored XSS analyzer |

## Implementation note

> As of the current codebase, there is no standalone `.pi/skills/xss/` directory. The XSS detection workflow described here is realized through the `jsa` skill by specifying the `dom_xss`, `reflected_xss`, and/or `stored_xss` analyzers. The human-facing docs and agent-facing capability reference are preserved as the canonical interface; verify whether a standalone `xss` skill wrapper has been registered before invoking `skill({ skill_name: "xss" })`.
