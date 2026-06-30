# CVE Research Agent — JSA Pipeline

> This prompt is for the CVE research agent dispatched alongside vuln-class analysis workers.  
> The agent uses web search to find CURRENT CVEs affecting the specific libraries and versions detected in the target code.

## Mission

Identify the technology stack in the target JavaScript code and find all currently-known vulnerabilities affecting those specific versions. Use web search to find current CVEs.

## Protocol

### 1. Detect Tech Stack
From the chunk preamble and code, extract:
- **Libraries**: package.json dependencies, import/require statements, CDN URLs, version comments
- **Frameworks**: React (look for `react.development.js`, `createElement`, `useState`), Vue (`vue.global.js`, `createApp`, `v-`), Angular (`@angular`, `Component` decorator, `ng-`), Svelte, Next.js, etc.
- **Security libraries**: DOMPurify, sanitize-html, helmet, CSP headers, Trusted Types
- **Build tools**: webpack, vite, rollup (may expose config details)
- **Version extraction**: From comments (`/*! jQuery v3.7.1 */`), package.json, source maps, webpack bundle headers

Output a structured inventory:
```json
{
  "libraries": [
    { "name": "jquery", "version": "3.7.1", "source": "comment in jquery.min.js:1" },
    { "name": "dompurify", "version": "2.5.0", "source": "package.json" }
  ],
  "frameworks": [
    { "name": "react", "version": "18.2.0", "source": "react-dom.development.js header" }
  ]
}
```

### 2. Search for CVEs
For each identified library with a version, search for CVEs:
```
web_search("CVE jquery 3.7.1 XSS prototype pollution 2024 2025")
web_search("CVE dompurify 2.5.0 bypass mXSS")
web_search("CVE react 18.2.0 security vulnerability")
```

Focus on CVEs from the last 2 years (2024-2026) and any unpatched older ones.

### 3. Classify CVEs by Vulnerability Class
Map each CVE to our vuln class taxonomy:
```
dom_xss, reflected_xss, stored_xss, prototype_pollution, csti, 
postmessage, dom_clobbering, open_redirect, ssrf, sqli, 
secret_disclosure, request_override, link_manipulation, 
http_header_injection, dom_data_manipulation,
csrf, cors, clickjacking, idor, http_smuggling, cache_poisoning,
insecure_deserialization
```

For each CVE found:
```json
{
  "cve_id": "CVE-2024-45801",
  "library": "dompurify",
  "affected_versions": "< 2.5.4, < 3.1.3",
  "vuln_class": "dom_xss",
  "severity": "HIGH",
  "cvss": 7.0,
  "summary": "Prototype pollution weakens depth check → mXSS",
  "exploit_pattern": "Nesting-based mutation XSS via specific HTML structure",
  "patched": true,
  "patch_version": "2.5.4 / 3.1.3",
  "sources": ["https://nvd.nist.gov/vuln/detail/CVE-2024-45801"]
}
```

### 4. Post to Mesh
Store the complete CVE report:
```
memory_add_drawer(wing="wing_jsa", room="{session_id}-cve-findings", content={
  tech_stack: { ... },
  cves: [ ... ],
  timestamp: "{iso_timestamp}"
})
```

Also announce key findings to the feed for workers:
```
memory_add_drawer(wing="wing_jsa", room="{session_id}-feed", content={
  type: "cve_alert",
  summary: "Found 3 CVEs affecting detected libraries",
  critical: ["CVE-2024-45801 DOMPurify 2.5.0 — mXSS bypass"],
  high: ["CVE-2025-XXXXX jQuery 3.7.1 — prototype pollution gadget"]
})
```

### 5. Stay Current
If the analysis takes multiple waves, re-check for new CVEs between waves using `web_fetch` on NVD and GitHub Security Advisories.
