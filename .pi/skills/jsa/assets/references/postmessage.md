# postMessage Vulnerabilities Reference Catalog

> **Search shortcuts:** `grep "^## Sources"` | `grep "^## Sinks"` | `grep "^## Detection"`

---

## Table of Contents
- [Sources](#sources) — User-controllable input patterns
- [Sinks](#sinks) — Execution/exploitation points
- [Detection Heuristics](#detection-heuristics) — Pattern matching and grep patterns
- [Origin Validation](#origin-validation) — event.origin and targetOrigin checks (safe/weak/vulnerable)
- [Framework Patterns](#framework-patterns) — WebView / Electron / extension messaging
- [Multi-Step Chains](#multi-step-chains) — postMessage → DOM XSS
- [False Positives](#false-positives) — Common misidentified patterns

---

## Sources

| Source | Pattern |
|--------|--------|
| `event.data` | User-controllable input |
| `MessageEvent.data` | User-controllable input |

## Sinks

| Sink | Risk |
|------|------|
| `document.write` | High |
| `eval()` | High |
| `innerHTML` | High |
| `outerHTML` | High |
| `newFunction()` | High |
| `location.href=` / `window.open()` | Medium |
| `script.src` / `iframe.src` | Medium |
| `JSON.parse(event.data)` → downstream sink | High |

## Detection Heuristics

### Grep Patterns
```bash
grep -nE "addEventListener\(\s*['\"]message['\"]|onmessage\s*=|\.postMessage\(|BroadcastChannel|MessageChannel" {file}
```

---

## Origin Validation

Every `message` listener must validate `event.origin`.

**VULNERABLE — no origin check:**
```javascript
window.addEventListener('message', (e) => { eval(e.data); }); // any origin can send
```

**SAFE — strict equality against a specific origin:**
```javascript
if (event.origin !== 'https://trusted.com') return;
```

**WEAK — bypassable checks:**
```javascript
event.origin.endsWith('trusted.com')      // attacker registers trusted.com.evil.com
event.origin.includes('trusted')          // attacker uses trusted.evil.com
event.origin === window.location.origin   // safe ONLY if no same-origin open redirect
event.origin !== 'https://evil.com'       // blocks ONE origin, allows all others
```

### targetOrigin (outbound postMessage)
```javascript
window.postMessage(data, '*');   // VULNERABLE: any origin can receive
targetWindow.postMessage(data);  // no targetOrigin == '*'
window.postMessage(data, 'https://specific-origin.com'); // SAFE
```

---

## Framework Patterns

- **React Native WebView:** `onMessage` handler without an origin check
- **Electron:** `ipcRenderer.on` / `webContents.send`
- **Chrome extensions:** `chrome.runtime.onMessage` (check `externally_connectable`)

---

## Multi-Step Chains

**postMessage → DOM XSS:** attacker page frames victim.com → sends `postMessage` with an XSS payload → victim listener has no origin check → `event.data` flows to `innerHTML` → XSS.

---

## False Positives

| Pattern | Why FP | Verification |
|---------|--------|-------------|
| Listener has strict `event.origin ===` check vs a specific origin | Origin enforced | Confirm equality (not endsWith/includes) |
| `event.data` → `JSON.parse` → safe DOM API (`textContent`) | No HTML/exec sink | Verify sink is not innerHTML/eval |
| Listener handles only known message types, ignores unknown data | Input constrained | Check type dispatch / schema validation |
| Browser extension with `externally_connectable` restriction | Sender restricted | Check manifest `externally_connectable` |

