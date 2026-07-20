"""Stored XSS Analyzer."""
from .base import VulnerabilityAnalyzer, SourceSink, PayloadTemplate
class StoredXSSAnalyzer(VulnerabilityAnalyzer):
    @property
    def vuln_class(self) -> str:
        return "stored_xss"
    @property
    def display_name(self) -> str:
        return "Stored Cross-Site Scripting"
    @property
    def default_severity(self) -> str:
        return "critical"
    def get_source_sink_pairs(self) -> list[SourceSink]:
        return [SourceSink("Form→stored→rendered", ["input.value","textarea.value","fetch POST body"], ["innerHTML","document.write","$.html()","dangerouslySetInnerHTML","v-html"],"critical","CWE-79")]
    def get_semgrep_rulesets(self) -> list[str]: return ["p/xss","p/javascript","p/owasp-top-ten"]
    def get_custom_scanners(self) -> list[str]: return ["stored_xss_scanner"]
    def get_payload_templates(self) -> list[PayloadTemplate]: return [PayloadTemplate("sxss","Stored XSS","<img src=x onerror=alert(1)>",target_context="html")]
    def get_verification_procedure(self,f:dict) -> str: return "Submit form with payload → view rendered page → check for execution"
    def assess_exploitability(self,f:dict) -> dict: return {"exploitable":True,"difficulty":"medium","preconditions":["Payload stored and rendered to users"]}
    def get_cvss_base(self,f:dict) -> dict: return {"AV":"N","AC":"L","AT":"N","PR":"L","UI":"R","VC":"H","VI":"H","VA":"N","SC":"H","SI":"H","SA":"N"}
