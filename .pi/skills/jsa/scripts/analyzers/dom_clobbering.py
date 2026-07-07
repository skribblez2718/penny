"""DOM Clobbering Analyzer."""
from .base import VulnerabilityAnalyzer, SourceSink, PayloadTemplate
class DOMClobberingAnalyzer(VulnerabilityAnalyzer):
    @property
    def vuln_class(self) -> str:
        return "dom_clobbering"
    @property
    def display_name(self) -> str:
        return "DOM Clobbering"
    @property
    def default_severity(self) -> str:
        return "medium"
    def get_source_sink_pairs(self) -> list[SourceSink]: return [SourceSink("Named element->variable collision",["HTML elements with id/name"],["global variable checks","typeof checks","if(!var) checks"],"medium","CWE-79")]
    def get_semgrep_rulesets(self) -> list[str]: return ["p/javascript"]
    def get_custom_scanners(self) -> list[str]: return ["dom_clobbering_scanner"]
    def get_analysis_guide(self) -> str: return self._load_prompt("annie-dom_clobbering.md")
    def get_payload_templates(self) -> list[PayloadTemplate]: return [PayloadTemplate("dc","DOM clobber","<form name=config><input name=apiKey value=evil></form>",target_context="html")]
    def get_verification_procedure(self,f:dict) -> str: return "Inject named HTML elements -> check JS variable clobbering -> trace to sink"
    def assess_exploitability(self,f:dict) -> dict: return {"exploitable":True,"difficulty":"medium","preconditions":["HTML injection possible","Variable matches id/name"]}
    def get_cvss_base(self,f:dict) -> dict: return {"AV":"N","AC":"L","AT":"N","PR":"N","UI":"R","VC":"H","VI":"H","VA":"N","SC":"H","SI":"H","SA":"N"}
