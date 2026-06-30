"""Open Redirect Analyzer."""
from .base import VulnerabilityAnalyzer, SourceSink, PayloadTemplate
class OpenRedirectAnalyzer(VulnerabilityAnalyzer):
    @property
    def vuln_class(self) -> str:
        return "open_redirect"
    @property
    def display_name(self) -> str:
        return "Open Redirect"
    @property
    def default_severity(self) -> str:
        return "medium"
    def get_source_sink_pairs(self) -> list[SourceSink]: return [SourceSink("User URL->navigation",["location.search","URLSearchParams","event.data"],["location.href=","location.replace()","location.assign()","window.open()","anchor.href"],"medium","CWE-601")]
    def get_semgrep_rulesets(self) -> list[str]: return ["p/javascript","p/owasp-top-ten"]
    def get_custom_scanners(self) -> list[str]: return []
    def get_analysis_guide(self) -> str: return self._load_prompt("annie-open_redirect.md")
    def get_payload_templates(self) -> list[PayloadTemplate]: return [PayloadTemplate("or","Open redirect","//evil.com",target_context="url")]
    def get_verification_procedure(self,f:dict) -> str: return "Set redirect param to attacker URL -> check navigation"
    def assess_exploitability(self,f:dict) -> dict: return {"exploitable":True,"difficulty":"low","preconditions":["No URL validation"]}
    def get_cvss_base(self,f:dict) -> dict: return {"AV":"N","AC":"L","AT":"N","PR":"N","UI":"R","VC":"N","VI":"L","VA":"N","SC":"L","SI":"L","SA":"N"}
