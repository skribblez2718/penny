"""Clickjacking Analyzer — Page-Level."""
from .base import VulnerabilityAnalyzer, SourceSink, PayloadTemplate
class ClickjackingAnalyzer(VulnerabilityAnalyzer):
    @property
    def vuln_class(self) -> str:
        return "clickjacking"
    @property
    def display_name(self) -> str:
        return "Clickjacking"
    @property
    def is_page_level(self) -> bool:
        return True
    @property
    def default_severity(self) -> str:
        return "low"
    def get_source_sink_pairs(self) -> list[SourceSink]: return [SourceSink("Missing frame protection",["X-Frame-Options missing","CSP frame-ancestors missing"],["Framable page with sensitive actions"],"low","CWE-1021")]
    def get_semgrep_rulesets(self) -> list[str]: return ["p/javascript"]
    def get_custom_scanners(self) -> list[str]: return []
    def get_payload_templates(self) -> list[PayloadTemplate]: return []
    def get_verification_procedure(self,f:dict) -> str: return "Check X-Frame-Options header -> check CSP frame-ancestors -> check for frame-busting scripts"
    def assess_exploitability(self,f:dict) -> dict: return {"exploitable":True,"difficulty":"low","preconditions":["No X-Frame-Options or CSP frame-ancestors"]}
    def get_cvss_base(self,f:dict) -> dict: return {"AV":"N","AC":"L","AT":"N","PR":"N","UI":"R","VC":"N","VI":"L","VA":"N","SC":"N","SI":"L","SA":"N"}
