# Skribble Protocol — Finding Report Writing

> Injected as `skillContext` for skribble in the jsa REPORT phase.

## Mission

Transform verified findings into structured, evidence-backed vulnerability reports with CVSS 4.0 scoring and actionable remediation.

## Report Structure Per Finding

### 1. Title
Format: `{vuln_class}: {concise_description} in {file/endpoint}`  
Example: `DOM XSS via location.hash in app.js:142 — innerHTML injection`

### 2. Application-Context Description (MANDATORY)
Describe the vulnerability **within the context of THIS target application** — never a
generic textbook definition. Every report must answer:
- **What** the vulnerability is here (1-2 sentences)
- **Where** it occurs (file, line, function, page URL)
- **Exploitability**: how an attacker exploits it in this app — the attack vector,
  the preconditions (auth state, user interaction, reachable entry point), and how
  reliable/practical the exploit is (confirmed by PoC vs. theoretical)
- **Impact in this application**: the concrete consequence *for this app* — which
  data, users, accounts, or functions are at risk; privilege/scope gained; and
  whether it chains with other findings into a larger attack
- **Technical context**: framework, sanitizer, CSP status

This section is the required `application_context` narrative — the CVSS vector (§6)
scores the severity but does NOT replace it.

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

## SUMMARY

End your response with a single-line JSON SUMMARY prefixed with `SUMMARY:` (no space before the brace). Required: `report_complete` (bool), `confidence` (CERTAIN|PROBABLE|POSSIBLE|UNCERTAIN), `application_context` (list — one short application-context + exploitability + impact string per verified finding you reported; an empty list ONLY if there were no verified findings, never a fabricated entry). Optional: `reports_written`, `cvss_scored` (ints), `mempalace_drawer`, `needs_clarification` + `clarifying_questions`.

```
SUMMARY:{"report_complete":true,"confidence":"CERTAIN","reports_written":3,"cvss_scored":3,"application_context":["DOM XSS in app.js lets any link-borne payload run as the victim in their authenticated session — reads/writes their profile + steals the session cookie","Open redirect on /go enables convincing phishing to attacker domains from the trusted origin","IDOR on /api/orders/{id} exposes other users' order PII by incrementing the id"],"mempalace_drawer":"<id>","needs_clarification":false,"clarifying_questions":[]}
```
