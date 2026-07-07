"""CORS Analyzer — Page-Level."""
from .base import VulnerabilityAnalyzer, SourceSink, PayloadTemplate
class CORSAnalyzer(VulnerabilityAnalyzer):
    @property
    def vuln_class(self) -> str:
        return "cors"
    @property
    def display_name(self) -> str:
        return "CORS Misconfiguration"
    @property
    def is_page_level(self) -> bool:
        return True
    @property
    def default_severity(self) -> str:
        return "medium"
    def get_source_sink_pairs(self) -> list[SourceSink]: return [SourceSink("Overly permissive CORS",["Origin header"],["Access-Control-Allow-Origin: *","Access-Control-Allow-Origin: null","Reflected Origin","Allow-Credentials: true + wildcard"],"medium","CWE-942")]
    def get_semgrep_rulesets(self) -> list[str]: return ["p/javascript","p/security-audit"]
    def get_custom_scanners(self) -> list[str]: return []
    def get_analysis_guide(self) -> str: return self._load_prompt("annie-cors.md")
    def get_payload_templates(self) -> list[PayloadTemplate]: return []
    def get_verification_procedure(self,f:dict) -> str: return "Send cross-origin request -> check CORS response headers -> test with credentials"
    def assess_exploitability(self,f:dict) -> dict: return {"exploitable":True,"difficulty":"low","preconditions":["CORS allows arbitrary origins with credentials"]}
    def get_cvss_base(self,f:dict) -> dict: return {"AV":"N","AC":"L","AT":"N","PR":"N","UI":"R","VC":"H","VI":"N","VA":"N","SC":"H","SI":"N","SA":"N"}
