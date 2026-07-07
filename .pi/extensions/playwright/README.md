# Playwright Extension for Penny

Browser automation tools for the Pi/Penny agent runtime. Provides ~50 tools
across 10+ capability domains, all using the `playwright` npm package and
@sinclair/typebox schemas.

## Configuration

All config is read from environment variables (with `.env` fallback). See
`config.ts` for the full list. Most relevant:

| Env Var                        | Default                     | Description                   |
| ------------------------------ | --------------------------- | ----------------------------- |
| `PLAYWRIGHT_HEADLESS`          | `false`                     | Run browser in headless mode  |
| `PLAYWRIGHT_TIMEOUT`           | `30000`                     | Default timeout in ms         |
| `PLAYWRIGHT_BROWSER_PATH`      | (none)                      | Path to Chromium binary       |
| `PLAYWRIGHT_NETWORK_ALLOWLIST` | (none)                      | Comma-separated allowed hosts |
| `PLAYWRIGHT_DOWNLOAD_DIR`      | `/tmp/playwright-downloads` | Download location             |
| `PLAYWRIGHT_OUTPUT_DIR`        | `/tmp/playwright-output`    | Screenshot/video output       |
| `PLAYWRIGHT_ENABLE_VISION`     | `false`                     | Mouse/click by coordinates    |
| `PLAYWRIGHT_ENABLE_DEVTOOLS`   | `false`                     | Tracing, console logs         |
| `PLAYWRIGHT_ENABLE_NETWORK`    | `false`                     | Intercept/route tools         |
| `PLAYWRIGHT_ENABLE_STORAGE`    | `false`                     | localStorage/cookies tools    |

## Proxy Support

Route all browser traffic through an HTTP or SOCKS proxy. Primary use case:
**route through Caido for HTTP history capture** (used by the jsa skill's
STRUCTURE phase).

| Env Var                     | Default | Description                                                              |
| --------------------------- | ------- | ------------------------------------------------------------------------ |
| `PLAYWRIGHT_PROXY_SERVER`   | (none)  | Proxy server URL. e.g., `http://127.0.0.1:8080` or `socks5://proxy:1080` |
| `PLAYWRIGHT_PROXY_USERNAME` | (none)  | Username for HTTP proxy auth                                             |
| `PLAYWRIGHT_PROXY_PASSWORD` | (none)  | Password for HTTP proxy auth                                             |
| `PLAYWRIGHT_PROXY_BYPASS`   | (none)  | Comma-separated domains to bypass proxy. e.g., `localhost,127.0.0.1`     |

**Auto-derivation:** if `PLAYWRIGHT_PROXY_SERVER` is unset but `CAIDO_URL`
is set, the proxy is auto-derived from Caido's URL. This makes Caido
integration "just work" when both extensions are configured. Explicit
`PLAYWRIGHT_PROXY_*` env vars always take precedence.

## HTTPS Certificate Handling

By default, Playwright rejects invalid HTTPS certificates (self-signed,
expired, etc.). For security testing this is often too strict.

### Option 1: Install Caido's CA cert properly (recommended)

Download Caido's CA cert and install it into the NSSDB that Playwright
Chromium uses:

```bash
# 1. Download cert from running Caido instance
curl -s http://localhost:8080/ca.crt -o /tmp/caido-ca.crt

# 2. Install libnss3-tools (one-time)
sudo apt install libnss3-tools

# 3. Install cert into NSSDB (user-level, no sudo for this step)
certutil -d sql:$HOME/.pki/nssdb -A -t "CT,C,C" -n "Caido" -i /tmp/caido-ca.crt

# 4. Verify
certutil -d sql:$HOME/.pki/nssdb -L
# Should show "Caido" with trust CT,C,C
```

This is the proper way — Playwright will trust Caido's cert without
disabling TLS verification globally.

### Option 2: Disable TLS verification (fallback for security testing)

If you need to navigate to test environments with self-signed certs
that you don't want to install, set:

```bash
PLAYWRIGHT_IGNORE_HTTPS_ERRORS=1
```

**Security warning:** this is a security risk in production. Only enable
for the jsa STRUCTURE phase, which intentionally navigates to test
environments and Caido's HTTPS proxy.

### Example: Route through Caido (jsa STRUCTURE)

```bash
# Caido upstream proxy default
PLAYWRIGHT_PROXY_SERVER=http://127.0.0.1:8080
```

Set in `.env` at the project root, or export before running Penny.

### Example: Route through authenticated corporate proxy

```bash
PLAYWRIGHT_PROXY_SERVER=http://proxy.corp.example.com:3128
PLAYWRIGHT_PROXY_USERNAME=alice
PLAYWRIGHT_PROXY_PASSWORD=hunter2
PLAYWRIGHT_PROXY_BYPASS=localhost,127.0.0.1,*.internal.corp
```

### Proxy Inspection Tools

Two new tools let agents verify and inspect the proxy configuration:

- **`playwright_get_proxy_info`** — Returns the current proxy config (server, username, bypass). Does NOT include the password in the response.
- **`playwright_check_proxy_reachable`** — TCP-probes the proxy server. Returns reachable boolean + latency in ms.

Both are always available regardless of `PLAYWRIGHT_ENABLE_NETWORK` setting
(they're informational, not network operations).

### Graceful Degradation

If `PLAYWRIGHT_PROXY_SERVER` is **not set**:

- Browser launches without a proxy (existing behavior, no breakage)
- `playwright_get_proxy_info` returns `proxy: null`
- `playwright_check_proxy_reachable` returns `reachable: false` with "No proxy configured"
- All other Playwright tools work as before

If the proxy server is **set but unreachable**:

- Browser launch may fail (Playwright's default behavior)
- The kill-switch in `BrowserManager.cleanup()` will force-shutdown after 5s

### Architecture

The proxy is set at `BrowserManager.launch()` via Playwright's
`chromium.launch({ proxy: { server, username, password, bypass } })` API.
Per Playwright docs, this applies to all browser contexts and pages.

The proxy is **read-only at runtime** — to change the proxy, you must
restart the session (the BrowserManager singleton only reads config at launch).

## Tool Categories

- **core** — navigate, snapshot, click, type, evaluate, screenshot
- **core-navigation** — back, forward, reload, get URL/title
- **core-tabs** — new page, close page, switch tab, list tabs
- **core-input** — press key, fill, check, uncheck, file upload
- **network** — intercept, route, proxy info, proxy reachability
- **storage** — localStorage, sessionStorage, cookies
- **pdf** — page to PDF export
- **testing** — verify element/text/value visible
- **vision** — mouse move/click/drag by coordinates
- **devtools** — console, tracing, performance, video

## Testing

```bash
cd .pi/extensions/playwright
npm test                # unit tests (no browser)
npm run test:integration  # integration tests (requires browser)
npm run test:e2e        # end-to-end tests (requires browser + network)
```

## Architecture

```
index.ts (entry)
  └─ BrowserManager (browser.ts)  — singleton browser lifecycle
       └─ tools/                   — tool modules
            ├─ navigate.ts
            ├─ core.ts
            ├─ click.ts
            ├─ tabs.ts
            ├─ evaluate.ts
            ├─ input.ts
            ├─ dialogs.ts
            ├─ storage.ts
            ├─ pdf.ts
            ├─ testing.ts
            ├─ routes.ts
            ├─ vision.ts
            └─ proxy.ts  (NEW: proxy info + reachability)
```

## Security Notes

- **Proxy password** is read from env and used in launch but **never returned** by `playwright_get_proxy_info`.
- Proxy bypass list is optional; use it for internal hosts that should connect directly.
- If using a corporate proxy with NTLM/Kerberos auth, prefer the username/password fields over embedding in the URL.
