# Skribble Protocol — Finding Report Writing

> Injected as `skillContext` for skribble in the jsa REPORT phase.

## Mission

Transform verified findings into structured, evidence-backed vulnerability reports with CVSS 4.0 scoring and actionable remediation.

## Report Structure Per Finding

### 1. Title
Format: `{vuln_class}: {concise_description} in {file/endpoint}`  
Example: `DOM XSS via location.hash in app.js:142 — innerHTML injection`

### 2. Application Issue Description
- **What** the vulnerability is (1-2 sentences)
- **Where** it occurs (file, line, function, page URL)
- **How** an attacker exploits it (attack vector, prerequisites)
- **Impact** (data theft, account takeover, XSS → session hijacking)
- **Technical context**: framework, sanitizer, CSP status

### 3. Steps to Reproduce
Copy/paste executable:
```
1. Navigate to https://example.com/page
2. Append #<img src=x onerror=alert(1)> to the URL
3. Observe alert dialog
```
Include actual curl/playwright commands. Screenshots embedded.

### 4. Code Analysis
Source-to-sink walkthrough with line references:
```
Source (app.js:142):
  const user = location.hash.slice(1);
  
No sanitization between source and sink.
  
Sink (app.js:156):
  document.getElementById('profile').innerHTML = user;
```
Include the vulnerable code snippet (5-15 lines).

### 5. Remediation
**Tech-stack-specific.** Not generic. Provide the exact code fix:

For React:
```jsx
// ❌ Vulnerable
<div dangerouslySetInnerHTML={{ __html: user }} />

// ✅ Fixed — use DOMPurify
import DOMPurify from 'dompurify';
<div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(user) }} />

// ✅ Better — avoid innerHTML entirely
<div>{user}</div>  // React auto-escapes
```

Reference specific library versions and API calls. If the fix requires upgrading a library, state the minimum patched version.

### 6. CVSS 4.0 Vector
Provide the full CVSS 4.0 vector string with justification for each metric:
```
CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:R/VC:H/VI:H/VA:N/SC:H/SI:H/SA:N
```
Justify: AV:N (network), AC:L (no special conditions), PR:N (no auth), UI:R (user must click link), VC:H (read all data), VI:H (execute arbitrary JS), SC:H (affects other origins via XSS).

## Output
Write each finding as a section in `{output_dir}/report.md`. Aggregate all findings with a summary table at the top.

## Quality Checklist
- [ ] No generic remediation ("use input validation") — must be tech-stack-specific
- [ ] Steps to reproduce are copy/paste executable
- [ ] Screenshots included for confirmed findings
- [ ] CVSS vector justified per metric
- [ ] Code snippet shows both source AND sink with line numbers
- [ ] Framework/library versions mentioned when relevant
