# postMessage — Worker Analysis Prompt

> **Reference Catalog:** `assets/references/postmessage.md` — use `grep`/`read` to search, not full-file reads.



## Lane (Phase D)

**Lane:** `code_static`
**Packet type:** flow_card (with source/sink/sanitizer, ~50-200 lines of code)
**Tools to use:**
- **Joern queries** (when available): scripts/joern_queries/{vuln_class}.sc
- **tree-sitter queries** for source/sink matching
- **semgrep** for pattern validation

This declaration tells INVESTIGATE phase how to route and packetize work items
for this analyzer. See `resources/reference.md` for lane semantics.

## Reference Catalog Usage
Before and during analysis, consult the reference catalog for patterns:
- `grep("^## Sources", "assets/references/postmessage.md")` — input patterns
- `grep("^## Sinks", "assets/references/postmessage.md")` — execution sinks
- `grep("^## Payloads", "assets/references/postmessage.md")` — test payloads
- `grep("^## Detection", "assets/references/postmessage.md")` — grep patterns for triage
- `grep("^## False Positives", "assets/references/postmessage.md")` — common FP patterns
- `read("assets/references/postmessage.md", limit=30)` then `read(..., offset=N)` for specific sections

> Full reference catalog: `research/jsa/analyze-postmessage.md`

## Mission

Analyze the assigned code chunk for postMessage / cross-origin messaging vulnerabilities. Check for missing origin validation, wildcard targetOrigin, and dangerous event.data handling.

## Analysis Workflow

### Step 1: Find postMessage Listeners
```bash
grep -nE "addEventListener\(\s*['\"]message['\"]|onmessage\s*=|\.postMessage\(|BroadcastChannel|MessageChannel" {file}
```

### Step 2: Check Origin Validation
For each `message` event listener, check if `event.origin` is validated:

**VULNERABLE — no origin check:**
```javascript
window.addEventListener('message', (event) => {
  eval(event.data);  // ANY origin can send!
});
```

**SAFE — strict origin check:**
```javascript
window.addEventListener('message', (event) => {
  if (event.origin !== 'https://trusted.com') return;
  // process event.data
});
```

**WEAK — pattern-based check (bypassable):**
```javascript
if (event.origin.endsWith('trusted.com'))  // attacker registers 'trusted.com.evil.com'
if (event.origin.includes('trusted'))       // attacker uses 'trusted.evil.com'
if (event.origin === window.location.origin) // safe IF no open redirect on same origin
if (event.origin !== 'https://evil.com')    // blocks ONE origin, allows all others
```

### Step 3: Check targetOrigin
For each `postMessage()` call, check the second argument:

**VULNERABLE:**
```javascript
window.postMessage(data, '*');  // ANY origin can receive
targetWindow.postMessage(data);  // No targetOrigin specified = '*'
```

**SAFE:**
```javascript
window.postMessage(data, 'https://specific-origin.com');
```

### Step 4: Check event.data Sinks
Where does `event.data` go?
```
innerHTML, outerHTML, document.write, eval, new Function,
location.href=, window.open, script.src, iframe.src,
JSON.parse → then to any sink above
```

### Step 5: Check for Framework Patterns
- React Native WebView: `onMessage` without origin check
- Electron: `ipcRenderer.on` / `webContents.send`
- Chrome extensions: `chrome.runtime.onMessage`

## Key Multi-Step Chain
**postMessage → DOM XSS:**
```
Attacker page (evil.com) → frames victim.com → sends postMessage with XSS payload
→ victim.com message listener has no origin check → event.data → innerHTML = XSS
```

## Quick False Positive Checks
- [ ] Listener has strict `event.origin ===` check against specific origin
- [ ] `event.data` goes to `JSON.parse` then to safe DOM API (textContent, not innerHTML)
- [ ] Listener only handles known message types, ignores unrecognized data
- [ ] Code is browser extension with `externally_connectable` restriction
