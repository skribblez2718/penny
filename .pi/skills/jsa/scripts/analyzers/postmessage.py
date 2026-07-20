"""postMessage Analyzer."""
from .base import VulnerabilityAnalyzer, SourceSink, PayloadTemplate
class PostMessageAnalyzer(VulnerabilityAnalyzer):
    @property
    def vuln_class(self) -> str:
        return "postmessage"
    @property
    def display_name(self) -> str:
        return "postMessage Vulnerabilities"
    @property
    def default_severity(self) -> str:
        return "high"
    def get_source_sink_pairs(self) -> list[SourceSink]: return [SourceSink("event.data->execution",["event.data","MessageEvent.data"],["innerHTML","eval()","document.write","new Function()"],"high","CWE-20"),SourceSink("Missing origin check",["addEventListener('message')"],["event.data->any sink without origin validation"],"high","CWE-345")]
    def get_semgrep_rulesets(self) -> list[str]: return ["p/javascript"]
    def get_custom_scanners(self) -> list[str]: return ["postmessage_scanner"]
    def get_payload_templates(self) -> list[PayloadTemplate]: return [PayloadTemplate("pm","postMessage XSS","<img src=x onerror=alert(1)>",target_context="html")]
    def get_verification_procedure(self,f:dict) -> str: return "From attacker origin, postMessage payload -> check execution"
    def assess_exploitability(self,f:dict) -> dict: return {"exploitable":True,"difficulty":"low","preconditions":["Attacker can frame target"]}
    def get_cvss_base(self,f:dict) -> dict: return {"AV":"N","AC":"L","AT":"N","PR":"N","UI":"R","VC":"H","VI":"H","VA":"N","SC":"H","SI":"H","SA":"N"}
