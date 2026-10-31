# Playwright Extension for Penny

Browser automation tools for the Pi/Penny agent runtime. Provides ~50 tools
across 10+ capability domains, all using the `playwright` npm package and
typebox schemas.

## Configuration

All config is read from environment variables (with `.env` fallback). See
`config.ts` for the full list. Most relevant:

| Env Var                        | Default                     | Description                                          |
| ------------------------------ | --------------------------- | ---------------------------------------------------- |
| `PLAYWRIGHT_HEADLESS`          | `false`                     | Run browser in headless mode                         |
| `PLAYWRIGHT_TIMEOUT`           | `30000`                     | Default timeout in ms                                |
| `PLAYWRIGHT_BROWSER_PATH`      | (none)                      | Path to Chromium binary                              |
| `PLAYWRIGHT_NETWORK_ALLOWLIST` | (none)                      | Immutable process destination ceiling (syntax below) |
| `PLAYWRIGHT_DOWNLOAD_DIR`      | `/tmp/playwright-downloads` | Download location                                    |
| `PLAYWRIGHT_OUTPUT_DIR`        | `/tmp/playwright-output`    | Screenshot/video output                              |
| `PLAYWRIGHT_ENABLE_VISION`     | `false`                     | Pre-enable coordinate tools                          |
| `PLAYWRIGHT_ENABLE_DEVTOOLS`   | `false`                     | Pre-enable highlight/tracing                         |
| `PLAYWRIGHT_ENABLE_NETWORK`    | `false`                     | Pre-enable route/proxy tools                         |
| `PLAYWRIGHT_ENABLE_STORAGE`    | `false`                     | Pre-enable storage tools                             |

## Browser Network Policy

`PLAYWRIGHT_NETWORK_ALLOWLIST` is an immutable, process-level ceiling over
browser request destinations. It is parsed and canonicalized before any browser
context or page can be created.

- **Absent or empty:** unrestricted behavior, preserving existing installations.
- **Non-empty:** only destinations matching a listed pattern are permitted.
- **Empty effective intersection:** deny all network destinations. This is
  different from an absent/empty configured list.
- Entries are comma-separated. Limits are 64 entries, 512 characters per entry,
  and 8,192 total characters. Malformed or over-limit configuration fails
  closed during extension initialization.

### Pattern grammar and canonical matching

| Pattern                         | Meaning                                                     |
| ------------------------------- | ----------------------------------------------------------- |
| `example.com`                   | Exact host, any supported network scheme and port           |
| `*.example.com`                 | Proper subdomains only; it does **not** match `example.com` |
| `example.com:8443`              | Exact host and port, any supported network scheme           |
| `https://example.com`           | HTTPS exact host on its default port, 443                   |
| `wss://*.example.com:9443`      | Secure WebSocket subdomains on port 9443                    |
| `127.0.0.1:8080` / `[::1]:8080` | Canonical IPv4 or bracketed IPv6 literal                    |

Supported schemes are `http`, `https`, `ws`, and `wss`. Scheme matching is
case-insensitive; DNS names are lowercased and internationalized names use URL
punycode canonicalization. URL paths, queries, fragments, credentials, regexes,
and partial-string wildcards are invalid in patterns. Ports are decimal
integers from 1 through 65535. A scheme without an explicit port means that
scheme's default port. Matching is against the parsed URL authority, never a
substring, and no private-network or loopback exception is implicit.

### Registered per-invocation narrowing

Per-invocation narrowing is implemented only for catalog-agent phases executed
by Penny's TypeScript orchestration host. A phase may carry an optional
`browser_network_allowlist` in its immutable `PlaybookRegistration`. The list
must already be frozen, canonical, sorted, and duplicate-free; an explicitly
empty registered list means deny all. Ordinary shipped registrations omit the
field and retain their existing browser behavior.

The canonical registration digest includes the exact list when registered and
preserves the prior digest shape when absent. One pure versioned contract,
`apps/orchestration/src/browser-policy-contract.ts`, owns pattern parsing,
canonicalization, list bounds, carrier shape, and the 128-character identity
bound for both host and consumer. `WorkerExecutor` projects the same immutable
list into worker invocation metadata and, immediately around
`ModelClient.runAgent`, binds a host-generated run scope and worker invocation ID
in a shared Node `AsyncLocalStorage` carrier. `PiAgentClient` requires that exact
registration/state/owner/worker/list binding before resource loading or
`createAgentSession`; a missing, foreign, widened, or forged carrier fails before
session creation. No test-only carrier is accepted by production code.

Pi's Playwright extension captures the same binding while the session is created
and uses it for every tool/page action through session shutdown. Concurrent
restricted sessions therefore receive separate browser processes, contexts,
pages, and tab lists. Each restricted session cleans only its captured scope,
and ordinary-session shutdown cannot close a concurrent restricted scope. A
browser/tool close retains the immutable binding so a live scope cannot widen;
only host-owned session retirement reclaims it. Completed sequential sessions
do not consume the manager's bounded set of 128 concurrent bindings.

Task or prompt text, tool arguments, trust profiles, page content, runtime state,
and environment mutation cannot select or alter this phase policy. Direct Pi
sessions and non-orchestration subagent paths do not gain a per-invocation policy
from this mechanism. The effective restricted policy is always `process ceiling
∩ registered invocation policy`, so registration cannot widen the process
setting and an empty intersection denies all.

### Enforcement coverage

Restricted contexts install the effective policy before external navigation.
Playwright context routing mediates direct HTTP(S) navigation, subresources,
and frames. A per-page Chromium DevTools Protocol request guard independently
checks every redirect hop; popup requests use bounded one-hop mediation until
that guard is attached. `routeWebSocket` separately mediates WebSocket
handshakes.

Service workers are blocked, and dedicated/shared workers are refused in
restricted contexts. This is deliberate fail-closed behavior: Playwright can
route ordinary worker fetches but cannot reliably disable worker-realm
WebTransport before worker code runs, so the extension does not claim a worker
egress boundary it cannot enforce. Persistent downloads are disabled, and
page-level WebRTC and WebTransport constructors are disabled and verified on
the bootstrap page before external navigation. Restricted policy installation
and per-page CDP attachment each have a five-second admission bound.

Each scope retains Chromium's real `ChildProcess` handle through one validated
Playwright implementation boundary and observes browser disconnect and process
exit. A per-scope single-flight launch and lifecycle mutex serialize bootstrap,
page/context mutation, restart, and cleanup without serializing different
scopes. Concurrent first use therefore shares one launch. Cleanup closes
admission before waiting for an in-flight launch or page operation, then checks
every process owned by that scope before retiring it. Launch fails closed before
context creation if process ownership cannot be established. A setup failure
retires only that launch's owned resources. If graceful cleanup exceeds five
seconds, cleanup sends `SIGKILL` through every live owned process handle and
waits for exit. A scope is not removed and cleanup is not reported complete when
termination cannot be confirmed; the retained state can be retried and blocks
further scope use.

Operations that can bypass or supersede these controls are refused while the
current invocation is restricted:

- page request route/unroute tools (page routes outrank context routes);
- proxy mutation and raw proxy reachability probes;
- arbitrary unsafe Playwright/Node.js execution and raw-browser access;
- restricted browser launch when any process/runtime proxy is configured.

Staged tool loading remains additive. Loading a network or unsafe tool does not
authorize it: the policy is checked again at execution time.

### Residual boundary

This is an enforceable **browser request URL-authority** boundary, not an
operating-system network sandbox. In particular, it does not pin DNS answers or
claim to mediate Chromium's own launch/background traffic, speculative DNS or
socket setup that carries no HTTP request, external protocol handlers, proxy
transport, browser vulnerabilities, or other processes. A permitted DNS name is
therefore authorized regardless of the IP address to which it resolves. Use an
OS/container egress firewall and controlled DNS in addition to this policy when
the physical remote IP or all process traffic must be constrained.

Denials use bounded structured reason codes and log only canonical
scheme/host/port destinations plus a hashed scope tag—never URL credentials,
paths, queries, fragments, request bodies, or response payloads. Restricted
browser errors are similarly sanitized, and network-observation tools reduce
captured URLs to canonical destinations.

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
Proxy mutation and reachability probes are nevertheless refused in restricted
network-policy scopes; proxy information remains read-only and available.

### Graceful Degradation

If `PLAYWRIGHT_PROXY_SERVER` is **not set**:

- Browser launches without a proxy (existing behavior, no breakage)
- `playwright_get_proxy_info` returns `proxy: null`
- `playwright_check_proxy_reachable` returns `reachable: false` with "No proxy configured"
- All other Playwright tools work as before

If the proxy server is **set but unreachable**:

- Browser launch may fail (Playwright's default behavior)
- `BrowserManager.cleanup()` bounds graceful close, force-kills the owned
  Chromium child process on timeout, and fails truthfully if exit is unconfirmed

### Architecture

The proxy is set when `BrowserManager` calls
`chromium.launch({ proxy: { server, username, password, bypass } })`. The launch
setting applies to all browser contexts and pages.

The configured environment proxy is the default. A runtime override set through
`playwright_set_proxy` takes precedence and applies after the browser relaunches.

## Active Tool Loading

The unmarked primary Penny runtime keeps a compact browser core active: navigation, tabs, snapshots, screenshots, resizing, closing, and waits. Use `playwright_load_tools` to add the narrowest capability group needed. Additive loading preserves Pi's native deferred-tool path when the provider supports it. Existing `PLAYWRIGHT_ENABLE_NETWORK`, `PLAYWRIGHT_ENABLE_STORAGE`, `PLAYWRIGHT_ENABLE_VISION`, and `PLAYWRIGHT_ENABLE_DEVTOOLS` settings pre-enable their corresponding groups.

Spawned workers are not subject to the primary reduction. Their explicit `--tools` allowlists remain authoritative and the loader never broadens them.

## Tool Categories

- **core, initially active** — navigation, tabs, snapshots, screenshots, resize, close, wait
- **interact** — click, hover, drag, text input, form controls, dialogs, batch form fill
- **diagnose** — page evaluation, console, request observation, assertions
- **storage** — localStorage, sessionStorage, cookies
- **network** — route interception and proxy control
- **files** — PDF export and file upload/drop
- **vision** — coordinate interaction
- **devtools** — highlights and tracing
- **unsafe** — arbitrary Playwright/Node.js execution; never load by default

## Testing

The ordinary route reports browser-backed suites as skipped unless explicitly
authorized:

```bash
cd .pi/extensions/playwright
bun run test:unit
bun run test:integration
bun run test:e2e
```

The release boundary has a separate fail-closed route:

```bash
PENNY_PLAYWRIGHT_BROWSER_TESTS=1 bun run test:browser:release
```

`test:browser:release` fails when the opt-in flag or an executable Chromium is
missing. It runs the protected loopback integration and registered-tool E2E
files with retries disabled, so a first-attempt forbidden-sink leak cannot turn
green on retry. These tests use loopback servers only; the opt-in does not
authorize external network access.

## Architecture

```
index.ts (entry)
  └─ BrowserManager (browser.ts)  — stable policy-scope router and lifecycle
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
