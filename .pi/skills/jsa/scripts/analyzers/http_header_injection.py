"""HTTP Header Injection Analyzer."""
from .base import VulnerabilityAnalyzer, SourceSink, PayloadTemplate
class HTTPHeaderInjectionAnalyzer(VulnerabilityAnalyzer):
    @property
    def vuln_class(self) -> str:
        return "http_header_injection"
    @property
    def display_name(self) -> str:
        return "HTTP Header Injection"
    @property
    def default_severity(self) -> str:
        return "medium"
    def get_source_sink_pairs(self) -> list[SourceSink]: return [SourceSink("User input->HTTP header",["location.search","URLSearchParams","input.value"],["xhr.setRequestHeader()","headers.set()","document.cookie","res.setHeader()"],"medium","CWE-113")]
    def get_semgrep_rulesets(self) -> list[str]: return ["p/javascript","p/security-audit"]
    def get_custom_scanners(self) -> list[str]: return ["http_header_scanner"]
    def get_analysis_guide(self) -> str: return self._load_prompt("annie-http_header_injection.md")
    def get_payload_templates(self) -> list[PayloadTemplate]: return [PayloadTemplate("hi","CRLF injection","value\r\nInjected-Header: malicious",target_context="html")]
    def get_verification_procedure(self,f:dict) -> str: return "Inject CRLF in header value -> check if extra header appears"
    def assess_exploitability(self,f:dict) -> dict: return {"exploitable":True,"difficulty":"low","preconditions":["Header value not sanitized for CRLF"]}
    def get_cvss_base(self,f:dict) -> dict: return {"AV":"N","AC":"L","AT":"N","PR":"N","UI":"R","VC":"N","VI":"L","VA":"N","SC":"L","SI":"L","SA":"N"}
