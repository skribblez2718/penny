"""Prototype Pollution Analyzer."""
from .base import VulnerabilityAnalyzer, SourceSink, PayloadTemplate
class PrototypePollutionAnalyzer(VulnerabilityAnalyzer):
    @property
    def vuln_class(self) -> str:
        return "prototype_pollution"
    @property
    def display_name(self) -> str:
        return "Prototype Pollution"
    @property
    def default_severity(self) -> str:
        return "high"
    def get_source_sink_pairs(self) -> list[SourceSink]:
        return [SourceSink("User input→recursive merge",["location.search","localStorage.getItem","JSON.parse(userInput)","req.body"],["Object.assign","$.extend","_.merge","_.defaultsDeep","for...in without hasOwnProperty"],"high","CWE-1321")]
    def get_semgrep_rulesets(self) -> list[str]: return ["p/javascript","p/owasp-top-ten"]
    def get_custom_scanners(self) -> list[str]: return ["prototype_pollution_scanner"]
    def get_payload_templates(self) -> list[PayloadTemplate]: return [PayloadTemplate("pp","__proto__ pollution",'{"__proto__":{"polluted":true}}',target_context="html")]
    def get_verification_procedure(self,f:dict) -> str: return "Inject pollution payload → check Object.prototype → look for gadget chain"
    def assess_exploitability(self,f:dict) -> dict: return {"exploitable":True,"difficulty":"medium","preconditions":["Merge without hasOwnProperty","Gadget exists"]}
    def get_cvss_base(self,f:dict) -> dict: return {"AV":"N","AC":"L","AT":"N","PR":"N","UI":"N","VC":"H","VI":"H","VA":"H","SC":"H","SI":"H","SA":"H"}
