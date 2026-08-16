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

Route all browser traffic through an HTTP or SOCKS proxy for controlled test environments, traffic inspection, or corporate-network access.

| Env Var                     | Default | Description                                                              |
| --------------------------- | ------- | ------------------------------------------------------------------------ |
| `PLAYWRIGHT_PROXY_SERVER`   | (none)  | Proxy server URL. e.g., `http://127.0.0.1:8080` or `socks5://proxy:1080` |
| `PLAYWRIGHT_PROXY_USERNAME` | (none)  | Username for HTTP proxy auth                                             |
| `PLAYWRIGHT_PROXY_PASSWORD` | (none)  | Password for HTTP proxy auth                                             |
| `PLAYWRIGHT_PROXY_BYPASS`   | (none)  | Comma-separated domains to bypass proxy. e.g., `localhost,127.0.0.1`     |

## HTTPS Certificate Handling

By default, Playwright rejects invalid HTTPS certificates (self-signed,
expired, etc.). For security testing this is often too strict.

### Option 1: Install the proxy CA certificate (recommended)

Install the inspection proxy's CA certificate into the NSSDB used by Playwright Chromium, then verify the certificate is listed:

```bash
certutil -d sql:$HOME/.pki/nssdb -A -t "CT,C,C" -n "Local Proxy" -i "$PROXY_CA_CERT"
certutil -d sql:$HOME/.pki/nssdb -L
```

This preserves TLS verification while trusting the configured local proxy.

### Option 2: Disable TLS verification (fallback for security testing)

If you need to navigate to test environments with self-signed certs
that you don't want to install, set:

```bash
PLAYWRIGHT_IGNORE_HTTPS_ERRORS=1
```

**Security warning:** this is a security risk in production. Enable it only for explicitly authorized test environments.

### Example: Route through a local inspection proxy

```bash
PLAYWRIGHT_PROXY_SERVER=http://127.0.0.1:8080
```

Set it in `.env` at the project root, or export it before running Penny.

### Example: Route through an authenticated corporate proxy

```bash
PLAYWRIGHT_PROXY_SERVER=http://proxy.corp.example.com:3128
PLAYWRIGHT_PROXY_USERNAME=alice
PLAYWRIGHT_PROXY_PASSWORD=hunter2
PLAYWRIGHT_PROXY_BYPASS=localhost,127.0.0.1,*.internal.corp
```

### Proxy Tools

Three tools manage and inspect the proxy configuration:

- **`playwright_get_proxy_info`** — Returns the current proxy config (server, username, bypass). Does not include the password.
- **`playwright_check_proxy_reachable`** — TCP-probes the configured proxy and returns reachability plus latency.
- **`playwright_set_proxy`** — Switches between direct browsing (`action="off"`) and an explicit proxy (`action="custom"`). Changing the proxy closes the current browser so the next navigation relaunches with the new setting.

These tools are always available regardless of `PLAYWRIGHT_ENABLE_NETWORK`.

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

The configured environment proxy is the default. A runtime override set through
`playwright_set_proxy` takes precedence and applies after the browser relaunches.

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
            └─ proxy.ts  (proxy configuration + reachability)
```

## Security Notes

- **Proxy password** is read from env and used in launch but **never returned** by `playwright_get_proxy_info`.
- Proxy bypass list is optional; use it for internal hosts that should connect directly.
- If using a corporate proxy with NTLM/Kerberos auth, prefer the username/password fields over embedding in the URL.
