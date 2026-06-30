"""DOM Data Manipulation Analyzer."""
from .base import VulnerabilityAnalyzer, SourceSink, PayloadTemplate
class DOMDataManipulationAnalyzer(VulnerabilityAnalyzer):
    @property
    def vuln_class(self) -> str:
        return "dom_data_manipulation"
    @property
    def display_name(self) -> str:
        return "DOM Data Manipulation"
    @property
    def default_severity(self) -> str:
        return "medium"
    def get_source_sink_pairs(self) -> list[SourceSink]: return [SourceSink("User input->DOM modification",["location.search","URLSearchParams","event.data"],["element.innerHTML","element.setAttribute()","element.classList","element.style","form.action"],"medium","CWE-20")]
    def get_semgrep_rulesets(self) -> list[str]: return ["p/javascript"]
    def get_custom_scanners(self) -> list[str]: return ["dom_data_manipulation_scanner"]
    def get_analysis_guide(self) -> str: return self._load_prompt("annie-dom_data_manipulation.md")
    def get_payload_templates(self) -> list[PayloadTemplate]: return [PayloadTemplate("dm","DOM manipulation","<form action=https://evil.com>",target_context="html")]
    def get_verification_procedure(self,f:dict) -> str: return "Modify DOM element via user input -> check if security-sensitive element changed"
    def assess_exploitability(self,f:dict) -> dict: return {"exploitable":True,"difficulty":"medium","preconditions":["User input controls DOM element or attribute selection"]}
    def get_cvss_base(self,f:dict) -> dict: return {"AV":"N","AC":"L","AT":"N","PR":"N","UI":"R","VC":"N","VI":"L","VA":"N","SC":"L","SI":"L","SA":"N"}
