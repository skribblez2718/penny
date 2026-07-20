"""CSRF Analyzer — Page-Level."""
from .base import VulnerabilityAnalyzer, SourceSink, PayloadTemplate
class CSRFAnalyzer(VulnerabilityAnalyzer):
    @property
    def vuln_class(self) -> str:
        return "csrf"
    @property
    def display_name(self) -> str:
        return "Cross-Site Request Forgery"
    @property
    def is_page_level(self) -> bool:
        return True
    @property
    def default_severity(self) -> str:
        return "high"
    def get_source_sink_pairs(self) -> list[SourceSink]: return [SourceSink("State-changing request without CSRF token",["form submission","fetch POST","xhr POST"],["Missing CSRF token","Predictable token","SameSite=None"],"high","CWE-352")]
    def get_semgrep_rulesets(self) -> list[str]: return ["p/javascript","p/owasp-top-ten"]
    def get_custom_scanners(self) -> list[str]: return []
    def get_payload_templates(self) -> list[PayloadTemplate]: return [PayloadTemplate("csrf","CSRF PoC form","<form method=POST action=https://victim.com/transfer><input name=amount value=1000></form>",target_context="html")]
    def get_verification_procedure(self,f:dict) -> str: return "Check if state-changing request includes CSRF token -> verify token validation -> test SameSite cookie"
    def assess_exploitability(self,f:dict) -> dict: return {"exploitable":True,"difficulty":"low","preconditions":["No CSRF token or weak token validation"]}
    def get_cvss_base(self,f:dict) -> dict: return {"AV":"N","AC":"L","AT":"N","PR":"N","UI":"R","VC":"N","VI":"H","VA":"N","SC":"N","SI":"H","SA":"N"}
