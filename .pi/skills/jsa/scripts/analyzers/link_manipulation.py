"""Link Manipulation Analyzer."""
from .base import VulnerabilityAnalyzer, SourceSink, PayloadTemplate
class LinkManipulationAnalyzer(VulnerabilityAnalyzer):
    @property
    def vuln_class(self) -> str:
        return "link_manipulation"
    @property
    def display_name(self) -> str:
        return "Link Manipulation"
    @property
    def default_severity(self) -> str:
        return "medium"
    def get_source_sink_pairs(self) -> list[SourceSink]: return [SourceSink("User input->URL attribute",["location.search","URLSearchParams","event.data"],["anchor.href","link.href","script.src","iframe.src","img.src","form.action"],"medium","CWE-79")]
    def get_semgrep_rulesets(self) -> list[str]: return ["p/javascript"]
    def get_custom_scanners(self) -> list[str]: return ["link_manipulation_scanner"]
    def get_analysis_guide(self) -> str: return self._load_prompt("annie-link_manipulation.md")
    def get_payload_templates(self) -> list[PayloadTemplate]: return [PayloadTemplate("lm","javascript: link","javascript:alert(1)",target_context="url")]
    def get_verification_procedure(self,f:dict) -> str: return "Set link attribute to javascript: payload -> click -> check execution"
    def assess_exploitability(self,f:dict) -> dict: return {"exploitable":True,"difficulty":"low","preconditions":["User input controls href/src without validation"]}
    def get_cvss_base(self,f:dict) -> dict: return {"AV":"N","AC":"L","AT":"N","PR":"N","UI":"R","VC":"H","VI":"H","VA":"N","SC":"H","SI":"H","SA":"N"}
