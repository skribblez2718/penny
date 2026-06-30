# XSS Skill

Find, verify, and report Cross-Site Scripting (XSS) vulnerabilities in web applications with production-safe testing.

## Purpose

Hunt for XSS vulnerabilities on a target web application. The skill navigates the app, identifies injection points, detects the application context (framework, input surfaces, data format), selects appropriate TTPs, applies production-safe payloads, verifies findings independently, and produces a 5-section vulnerability report.

## Usage

```
skill({ skill_name: "xss", goal: "Find XSS on https://example.com/search" })
```

### Input Flexibility

| Input Type | Example Goal |
|-----------|-------------|
| URL only | `"Find XSS on https://example.com"` |
| Source code only | `"Find XSS in ./src/app/"` |
| Both | `"Find XSS on https://example.com with source at ./src/"` |
| Caido history | Stubbed for future |

## Questionnaire

The skill may ask you:
1. **Platform and program** — needed for output directory path (e.g., `hackerone`, `shopify`). If not specified in the goal or constraints, the skill escalates immediately.
2. **Ambiguous inputs** — if the skill can't determine what you're asking it to hunt.

## Output

Reports are written to:
```
~/bug_bounty/<platform>/<program>/reports/<vuln-title>/report.md
```
Artifacts (payloads, screenshots) go to:
```
~/bug_bounty/<platform>/<program>/findings/xss/<vuln-title>/
```

### Report Sections

1. **Title** — descriptive, specific (e.g., "Reflected XSS in Search Parameter")
2. **Application Issue Description** — thorough explanation within the specific app context
3. **Steps to Reproduce** — numbered, copy/paste executable by a technically competent person
4. **Code Analysis** — source-to-sink walkthrough (only when source code is available)
5. **Remediation** — tech-stack-specific, actionable guidance with code examples. No generic "sanitize input."

## Production Safety

All testing is non-destructive:
- Payloads use `alert()`, `console.log()`, or `confirm()` only
- No data exfiltration (`document.cookie`, `fetch()`)
- No redirect (`window.location`)
- No DOM mutation
- Vera independently reproduces findings from a clean browser session

## Constraints (v1)

- Stored and reflected XSS only (no DOM-based or mutation XSS)
- Single vulnerability per invocation
- No blind XSS callbacks
- No WAF bypass payloads
- Caido history parsing not yet implemented
