"""CSTI Analyzer."""
from .base import VulnerabilityAnalyzer, SourceSink, PayloadTemplate
class CSTIAnalyzer(VulnerabilityAnalyzer):
    @property
    def vuln_class(self) -> str:
        return "csti"
    @property
    def display_name(self) -> str:
        return "Client-Side Template Injection"
    @property
    def default_severity(self) -> str:
        return "high"
    def get_source_sink_pairs(self) -> list[SourceSink]: return [SourceSink("User input→template compile",["location.search","URLSearchParams","localStorage.getItem"],["_.template()","Handlebars.compile()","ejs.render()","Vue.compile()","template literal ${}"],"high","CWE-1336")]
    def get_semgrep_rulesets(self) -> list[str]: return ["p/javascript"]
    def get_custom_scanners(self) -> list[str]: return ["csti_scanner"]
    def get_payload_templates(self) -> list[PayloadTemplate]: return [PayloadTemplate("csti","Template injection","{{constructor.constructor('alert(1)')()}}",target_context="html")]
    def get_verification_procedure(self,f:dict) -> str: return "Inject template expression → check if evaluated"
    def assess_exploitability(self,f:dict) -> dict: return {"exploitable":True,"difficulty":"medium","preconditions":["Template runtime compilation from user input"]}
    def get_cvss_base(self,f:dict) -> dict: return {"AV":"N","AC":"L","AT":"N","PR":"N","UI":"N","VC":"H","VI":"H","VA":"H","SC":"H","SI":"H","SA":"H"}
