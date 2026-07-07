"""Cache Poisoning Analyzer — Page-Level."""
from .base import VulnerabilityAnalyzer, SourceSink, PayloadTemplate
class CachePoisoningAnalyzer(VulnerabilityAnalyzer):
    @property
    def vuln_class(self) -> str:
        return "cache_poisoning"
    @property
    def display_name(self) -> str:
        return "Web Cache Poisoning"
    @property
    def is_page_level(self) -> bool:
        return True
    @property
    def default_severity(self) -> str:
        return "medium"
    def get_source_sink_pairs(self) -> list[SourceSink]: return [SourceSink("Unkeyed input->cached response",["X-Forwarded-Host","X-Forwarded-Scheme","User-Agent"],["Reflected in cacheable response without Vary header"],"medium","CWE-444")]
    def get_semgrep_rulesets(self) -> list[str]: return ["p/javascript"]
    def get_custom_scanners(self) -> list[str]: return []
    def get_analysis_guide(self) -> str: return self._load_prompt("annie-cache_poisoning.md")
    def get_payload_templates(self) -> list[PayloadTemplate]: return [PayloadTemplate("cp","Cache poison","X-Forwarded-Host: evil.com",target_context="html")]
    def get_verification_procedure(self,f:dict) -> str: return "Send request with unkeyed header -> check if reflected in cached response -> test cache duration"
    def assess_exploitability(self,f:dict) -> dict: return {"exploitable":True,"difficulty":"high","preconditions":["Cache in front of application","Unkeyed input reflected in response"]}
    def get_cvss_base(self,f:dict) -> dict: return {"AV":"N","AC":"H","AT":"N","PR":"N","UI":"N","VC":"N","VI":"H","VA":"N","SC":"H","SI":"H","SA":"N"}
