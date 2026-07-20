"""SSRF Analyzer."""
from .base import VulnerabilityAnalyzer, SourceSink, PayloadTemplate
class SSRFAnalyzer(VulnerabilityAnalyzer):
    @property
    def vuln_class(self) -> str:
        return "ssrf"
    @property
    def display_name(self) -> str:
        return "Server-Side Request Forgery"
    @property
    def default_severity(self) -> str:
        return "high"
    def get_source_sink_pairs(self) -> list[SourceSink]: return [SourceSink("User URL->backend fetch",["location.search","URLSearchParams","input.value"],["fetch('/api/proxy')","/api/fetch","/api/thumbnail"],"high","CWE-918")]
    def get_semgrep_rulesets(self) -> list[str]: return ["p/javascript","p/owasp-top-ten"]
    def get_custom_scanners(self) -> list[str]: return []
    def get_payload_templates(self) -> list[PayloadTemplate]: return [PayloadTemplate("ssrf","AWS metadata","http://169.254.169.254/latest/meta-data/",target_context="url")]
    def get_verification_procedure(self,f:dict) -> str: return "Set URL param to internal service -> check if backend fetches it"
    def assess_exploitability(self,f:dict) -> dict: return {"exploitable":True,"difficulty":"medium","preconditions":["Backend fetches user URLs"]}
    def get_cvss_base(self,f:dict) -> dict: return {"AV":"N","AC":"L","AT":"N","PR":"N","UI":"N","VC":"H","VI":"H","VA":"N","SC":"H","SI":"H","SA":"N"}
