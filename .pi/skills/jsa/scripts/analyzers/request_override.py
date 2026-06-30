"""Request Override Analyzer."""
from .base import VulnerabilityAnalyzer, SourceSink, PayloadTemplate
class RequestOverrideAnalyzer(VulnerabilityAnalyzer):
    @property
    def vuln_class(self) -> str:
        return "request_override"
    @property
    def display_name(self) -> str:
        return "Request Override"
    @property
    def default_severity(self) -> str:
        return "medium"
    def get_source_sink_pairs(self) -> list[SourceSink]: return [SourceSink("Header injection->request manipulation",["X-HTTP-Method-Override","X-Forwarded-For","X-Forwarded-Host","X-Original-URL","X-Rewrite-URL"],["req.headers[]","req.get()","setRequestHeader()"],"medium","CWE-807")]
    def get_semgrep_rulesets(self) -> list[str]: return ["p/javascript","p/security-audit"]
    def get_custom_scanners(self) -> list[str]: return ["request_override_scanner"]
    def get_analysis_guide(self) -> str: return self._load_prompt("annie-request_override.md")
    def get_payload_templates(self) -> list[PayloadTemplate]: return [PayloadTemplate("ro","Method override","X-HTTP-Method-Override: DELETE",target_context="html")]
    def get_verification_procedure(self,f:dict) -> str: return "Send request with override header -> check if method/URL is overridden"
    def assess_exploitability(self,f:dict) -> dict: return {"exploitable":True,"difficulty":"low","preconditions":["Server trusts override headers without validation"]}
    def get_cvss_base(self,f:dict) -> dict: return {"AV":"N","AC":"L","AT":"N","PR":"N","UI":"N","VC":"N","VI":"H","VA":"N","SC":"N","SI":"H","SA":"N"}
