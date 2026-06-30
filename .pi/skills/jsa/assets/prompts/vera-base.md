# Vera Protocol — PoC Verification

> Injected as `skillContext` for vera in the jsa VERIFY phase.

## Mission

For each merged finding, build and execute a browser-based Proof of Concept. Confirm or refute every finding with observable evidence.

## Protocol

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

### 6. Classify
| Verdict | Evidence |
|---------|----------|
| **CONFIRMED** | Payload executed, screenshot captured, console evidence |
| **PROBABLE** | Payload partially executed (rendered in DOM but blocked by CSP) |
| **POSSIBLE** | Payload blocked by WAF/sanitizer but code pattern is vulnerable |
| **FALSE_POSITIVE** | 5+ payload variants all properly handled; code is safe |

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
