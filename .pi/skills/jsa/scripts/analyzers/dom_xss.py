"""
DOM-Based XSS Analyzer.

Sources: location.hash, location.search, location.href, document.referrer,
         window.name, event.data (postMessage), localStorage, sessionStorage,
         document.cookie, URLSearchParams, history.pushState

Sinks: innerHTML, outerHTML, document.write, document.writeln, eval,
       new Function, setTimeout/setInterval (string), insertAdjacentHTML,
       DOMParser.parseFromString, Range.createContextualFragment,
       jQuery $.html(), React dangerouslySetInnerHTML, Vue v-html,
       Angular [innerHTML], script.text, script.textContent

Reference: assets/prompts/annie-dom_xss.md
Research:  research/jsa/analyze-dom_xss.md
"""

from .base import VulnerabilityAnalyzer, SourceSink, PayloadTemplate


class DOMXSSAnalyzer(VulnerabilityAnalyzer):
    """DOM-Based Cross-Site Scripting analyzer."""
    
    # ── Identity ──
    
    @property
    def vuln_class(self) -> str:
        return "dom_xss"
    
    @property
    def display_name(self) -> str:
        return "DOM-Based Cross-Site Scripting"
    
    @property
    def default_severity(self) -> str:
        return "critical"
    
    # ── Patterns ──
    
    def get_source_sink_pairs(self) -> list[SourceSink]:
        return [
            SourceSink(
                name="URL → HTML injection",
                sources=[
                    "location.search", "location.hash", "location.href",
                    "location.pathname", "document.URL", "document.documentURI",
                    "document.baseURI", "window.name",
                ],
                sinks=[
                    "element.innerHTML", "element.outerHTML", "document.write",
                    "document.writeln", "element.insertAdjacentHTML",
                    "DOMParser.parseFromString",
                    "Range.createContextualFragment",
                ],
                severity="critical",
                cwe="CWE-79",
            ),
            SourceSink(
                name="URL → JavaScript execution",
                sources=[
                    "location.search", "location.hash", "location.href",
                ],
                sinks=[
                    "eval()", "new Function()", "setTimeout(string)",
                    "setInterval(string)", "script.text", "script.textContent",
                ],
                severity="critical",
                cwe="CWE-79",
            ),
            SourceSink(
                name="postMessage → injection",
                sources=["event.data", "MessageEvent.data"],
                sinks=[
                    "element.innerHTML", "document.write", "eval()",
                    "new Function()",
                ],
                severity="high",
                cwe="CWE-79",
            ),
            SourceSink(
                name="Storage → injection",
                sources=[
                    "localStorage.getItem", "sessionStorage.getItem",
                    "document.cookie",
                ],
                sinks=[
                    "element.innerHTML", "document.write", "eval()",
                ],
                severity="medium",
                cwe="CWE-79",
            ),
            SourceSink(
                name="document.referrer → injection",
                sources=["document.referrer"],
                sinks=["element.innerHTML", "document.write", "eval()"],
                severity="medium",
                cwe="CWE-79",
            ),
            SourceSink(
                name="URL → jQuery/React/Vue/Angular injection",
                sources=["location.search", "location.hash", "location.href"],
                sinks=[
                    "$.html()", "dangerouslySetInnerHTML", "v-html",
                    "[innerHTML]", "bypassSecurityTrustHtml",
                    "bypassSecurityTrustScript",
                    "ElementRef.nativeElement.innerHTML",
                    "Renderer2.setProperty('innerHTML')",
                ],
                severity="critical",
                cwe="CWE-79",
            ),
        ]
    
    def get_semgrep_rulesets(self) -> list[str]:
        return [
            "p/xss",
            "p/javascript",
            "p/typescript",
            "p/owasp-top-ten",
            "p/cwe-top-25",
            "p/security-audit",
        ]
    
    def get_custom_scanners(self) -> list[str]:
        return ["dom_manipulation", "dom_xss_scanner"]
    
    # ── Analysis Guide ──
    
    def get_analysis_guide(self) -> str:
        return self._load_prompt("annie-dom_xss.md")
    
    # ── Verification ──
    
    def get_payload_templates(self) -> list[PayloadTemplate]:
        return [
            PayloadTemplate(
                id="xss-alert-basic",
                description="Basic alert() probe for HTML context",
                template="<img src=x onerror=alert(1)>",
                encoding="none",
                target_context="html",
            ),
            PayloadTemplate(
                id="xss-svg-onload",
                description="SVG onload vector (bypasses some filters)",
                template="<svg onload=alert(1)>",
                encoding="none",
                target_context="html",
            ),
            PayloadTemplate(
                id="xss-attr-break",
                description="Attribute break-out for quoted attributes",
                template='"><img src=x onerror=alert(1)>',
                encoding="none",
                target_context="attribute",
            ),
            PayloadTemplate(
                id="xss-js-string-break",
                description="JS string context break-out",
                template="'; alert(1); //",
                encoding="none",
                target_context="js_string",
            ),
            PayloadTemplate(
                id="xss-url-javascript",
                description="javascript: protocol for href/src sinks",
                template="javascript:alert(1)",
                encoding="none",
                target_context="url",
            ),
            PayloadTemplate(
                id="xss-template-literal",
                description="Template literal injection",
                template="${alert(1)}",
                encoding="none",
                target_context="template_literal",
            ),
        ]
    
    def get_verification_procedure(self, finding: dict) -> str:
        source = finding.get("source", "location.hash")
        sink = finding.get("sink", "innerHTML")
        page_url = finding.get("file", "")
        fid = finding.get("finding_id", "unknown")[:8]
        
        return f"""## DOM XSS Verification: {source} → {sink}

### Step 1: Navigate to target
playwright_navigate("{page_url}")

### Step 2: Inject test payload via {source}
playwright_navigate("{page_url}#<img src=x onerror=console.log('XSS-TEST-{fid}')>")

### Step 3: Check for execution
playwright_console_messages(level="log")
Look for "XSS-TEST-{fid}" in console output.

### Step 4: Capture evidence
playwright_screenshot(path="evidence/{fid}-poc.png")

### Step 5: If blocked, try context-specific variants
- Attribute context: try attribute break-out payload
- JS string context: try string break-out
- CSP blocking: try DOM clobbering + script gadget
"""
    
    def assess_exploitability(self, finding: dict) -> dict:
        has_csp = finding.get("evidence", {}).get("csp_detected", False)
        has_trusted_types = finding.get("evidence", {}).get("trusted_types", False)
        
        if has_trusted_types and "innerHTML" in str(finding.get("sink", "")):
            return {
                "exploitable": False,
                "difficulty": "N/A",
                "preconditions": ["Trusted Types enforced on this sink"],
            }
        
        if has_csp:
            return {
                "exploitable": False,
                "difficulty": "N/A",
                "preconditions": ["CSP blocks inline scripts"],
                "bypass_possible": True,
                "bypass_hint": "Look for script gadgets or JSONP endpoints",
            }
        
        return {
            "exploitable": True,
            "difficulty": "low" if "hash" in str(finding.get("source", "")) else "medium",
            "preconditions": ["User must visit attacker-controlled URL"],
        }
    
    # ── CVSS ──
    
    def get_cvss_base(self, finding: dict) -> dict:
        return {
            "AV": "N",  # Network
            "AC": "L",  # Low
            "AT": "N",  # None
            "PR": "N",  # None
            "UI": "R",  # Required (user must click link)
            "VC": "H",  # High confidentiality impact
            "VI": "H",  # High integrity impact
            "VA": "N",  # No availability impact
            "SC": "H",  # High scope change
            "SI": "H",
            "SA": "N",
        }
