"""HTTP Request Smuggling Analyzer — Page-Level."""
from .base import VulnerabilityAnalyzer, SourceSink, PayloadTemplate
class HTTPSmugglingAnalyzer(VulnerabilityAnalyzer):
    @property
    def vuln_class(self) -> str:
        return "http_smuggling"
    @property
    def display_name(self) -> str:
        return "HTTP Request Smuggling"
    @property
    def is_page_level(self) -> bool:
        return True
    @property
    def default_severity(self) -> str:
        return "high"
    def get_source_sink_pairs(self) -> list[SourceSink]: return [SourceSink("TE/CL discrepancy",["Transfer-Encoding","Content-Length headers"],["Proxy vs backend parsing mismatch","CL.TE","TE.CL","TE.TE"],"high","CWE-444")]
    def get_semgrep_rulesets(self) -> list[str]: return ["p/javascript"]
    def get_custom_scanners(self) -> list[str]: return []
    def get_analysis_guide(self) -> str: return self._load_prompt("annie-http_smuggling.md")
    def get_payload_templates(self) -> list[PayloadTemplate]: return []
    def get_verification_procedure(self,f:dict) -> str: return "Send request with conflicting TE/CL headers -> check for smuggling indicators -> test timing"
    def assess_exploitability(self,f:dict) -> dict: return {"exploitable":True,"difficulty":"high","preconditions":["Frontend/backend HTTP parsing mismatch"]}
    def get_cvss_base(self,f:dict) -> dict: return {"AV":"N","AC":"H","AT":"N","PR":"N","UI":"N","VC":"H","VI":"H","VA":"N","SC":"H","SI":"H","SA":"N"}
