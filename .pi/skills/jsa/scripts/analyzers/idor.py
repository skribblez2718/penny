"""IDOR Analyzer — Page-Level."""
from .base import VulnerabilityAnalyzer, SourceSink, PayloadTemplate
class IDORAnalyzer(VulnerabilityAnalyzer):
    @property
    def vuln_class(self) -> str:
        return "idor"
    @property
    def display_name(self) -> str:
        return "Insecure Direct Object Reference"
    @property
    def is_page_level(self) -> bool:
        return True
    @property
    def default_severity(self) -> str:
        return "high"
    def get_source_sink_pairs(self) -> list[SourceSink]: return [SourceSink("Predictable object reference",["/api/users/{id}","/orders/{id}","req.params.id"],["No ownership check in query","Missing WHERE user_id = ?"],"high","CWE-639")]
    def get_semgrep_rulesets(self) -> list[str]: return ["p/javascript","p/owasp-top-ten"]
    def get_custom_scanners(self) -> list[str]: return []
    def get_payload_templates(self) -> list[PayloadTemplate]: return []
    def get_verification_procedure(self,f:dict) -> str: return "Change object ID in request -> check if unauthorized data returned -> test sequential/predictable IDs"
    def assess_exploitability(self,f:dict) -> dict: return {"exploitable":True,"difficulty":"low","preconditions":["Sequential or predictable object IDs without ownership check"]}
    def get_cvss_base(self,f:dict) -> dict: return {"AV":"N","AC":"L","AT":"N","PR":"L","UI":"N","VC":"H","VI":"N","VA":"N","SC":"N","SI":"N","SA":"N"}
