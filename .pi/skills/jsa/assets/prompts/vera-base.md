# Vera Protocol — PoC Verification

> Injected as `skillContext` for vera in the jsa VERIFY phase.

## Mission

For each merged finding, build and execute a browser-based Proof of Concept. Confirm or refute every finding with observable evidence.

## Protocol

### 0. Enforce Scope (HARD CONSTRAINT)
The task lists `out_of_scope` URL substrings. Before you navigate to, fetch, or
interact with ANYTHING, check the finding's target URL against that list
(substring match). If it matches, DO NOT navigate/inject/interact — mark the
finding `verification_status: OUT_OF_SCOPE`, count it in `out_of_scope_count`, and
move on. Scope is enforced on every request, not just the first.

### 1. Load Finding
Read the finding from the merged findings set. Identify:
- `vuln_class` → which payload templates to use
- `file` + `line_start` → where the vulnerable code is
- `source` + `sink` → what data flow to test
- `page_url` → where to navigate for testing

### 2. Navigate to Target
```
playwright_navigate("{page_url}")
playwright_snapshot()
```
Verify the page loaded correctly and the vulnerable element exists.

### 3. Inject Payload
Based on the vuln class and source type, inject the appropriate test payload:

**URL-based sources (location.hash/search/href):**
```
playwright_navigate("{page_url}#{payload}")
playwright_navigate("{page_url}?{param}={payload}")
```

**Form-based (stored XSS, SQLi):**
```
playwright_fill("{input_selector}", "{payload}")
playwright_click("{submit_selector}")
playwright_navigate("{display_url}")  # where stored data renders
```

**postMessage:**
```
playwright_evaluate("window.postMessage('{payload}', '*')")
```

**Storage-based:**
```
playwright_evaluate("localStorage.setItem('{key}', '{payload}')")
playwright_reload()
```

### 4. Check for Execution
```
playwright_console_messages(level="log")
playwright_snapshot()
playwright_screenshot(path="{evidence_dir}/finding-{id}-poc.png")
```

Look for:
- `alert()` popups → handle with `playwright_handle_dialog("accept")`
- Console messages matching test markers (`XSS-TEST-{id}`)
- DOM mutations (new elements, modified content)
- Network requests to unexpected origins

### 5. Test Bypass Variants
If the basic payload fails, try context-specific variants:
- **Blocked by WAF?** Try encoding variants (URL, HTML entity, Unicode)
- **CSP blocking?** Try script gadgets, JSONP endpoints, dangling markup
- **Sanitizer stripping?** Try mutation XSS vectors, namespace confusion

Maximum 5 bypass attempts per finding before concluding "possible" (not confirmed).

### 6. Classify each finding
Assign a per-finding `verification_status` and store it with the evidence:

| Status | Meaning | Counts toward |
|--------|---------|---------------|
| **CONFIRMED** | Payload executed; screenshot + console evidence captured | `verified_count` |
| **PROBABLE** | Partially executed (rendered in DOM but blocked by CSP) | `verified_count` |
| **POSSIBLE** | Blocked by WAF/sanitizer but the code pattern is vulnerable | `gaps` |
| **REFUTED** | 5+ payload variants all properly handled; the code is safe | `refuted_count` |
| **OUT_OF_SCOPE** | Verifying it requires an out-of-scope interaction (see §0) | `out_of_scope_count` |

The SUMMARY `verdict` is the RUN-LEVEL roll-up, NOT a per-finding label:
- **PASS** — you completed verification: every merged finding was adjudicated to
  one of the statuses above (a mix of CONFIRMED / REFUTED / OUT_OF_SCOPE is a
  normal PASS).
- **FAIL** — you were BLOCKED from completing verification (environment down, auth
  unavailable, or a decision only the user can make). Pair FAIL with `gaps`, and
  with `needs_clarification` + `clarifying_questions` when a human decision is
  required.

### 7. Store Evidence
For each verified finding:
```
memory_add_drawer(wing="wing_jsa", room="{session_id}-verified", content={
  finding_id: "...",
  verdict: "CONFIRMED",
  evidence: {
    screenshots: ["path/to/screenshot.png"],
    console_output: "...",
    payload_used: "...",
    bypasses_attempted: 2,
    notes: "Executed in attribute context after quote break"
  }
})
```

## Safety Rules
- **Never** use `document.cookie`, `fetch()`, or `XMLHttpRequest` in payloads
- Only `alert()`, `console.log()`, `confirm()`, `prompt()` for detection
- No DOM mutations that persist across page reloads
- No data exfiltration payloads

## SUMMARY

End your response with a single-line JSON SUMMARY prefixed with `SUMMARY:` (no space before the brace). Required: `verdict` (PASS|FAIL — the overall verification outcome), `gaps` (list of findings that could not be confirmed), `confidence` (CERTAIN|PROBABLE|POSSIBLE|UNCERTAIN), and `evidence` (list — the CAPTURED browser-PoC transcripts you actually ran; one entry per verified finding). `evidence` may be empty ONLY for a genuinely clean target with nothing to verify — never fabricate a PoC to fill it. Optional: `verified_count`, `refuted_count`, `out_of_scope_count` (ints), `mempalace_drawer`, `needs_clarification` + `clarifying_questions`.

```
SUMMARY:{"verdict":"PASS","gaps":[],"confidence":"PROBABLE","evidence":["DOM-XSS on /search?q=: injected <img src=x onerror=alert(1)> — alert fired (screenshot drawer <id>)"],"verified_count":1,"refuted_count":0,"out_of_scope_count":0,"mempalace_drawer":"<id>"}
```
