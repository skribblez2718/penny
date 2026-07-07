"""Secret Disclosure Analyzer."""
from .base import VulnerabilityAnalyzer, SourceSink, PayloadTemplate
class SecretDisclosureAnalyzer(VulnerabilityAnalyzer):
    @property
    def vuln_class(self) -> str:
        return "secret_disclosure"
    @property
    def display_name(self) -> str:
        return "Secret Disclosure"
    @property
    def default_severity(self) -> str:
        return "high"
    def get_source_sink_pairs(self) -> list[SourceSink]: return []  # Pattern-based, not source->sink
    def get_semgrep_rulesets(self) -> list[str]: return ["p/secrets","p/security-audit"]
    def get_custom_scanners(self) -> list[str]: return ["jsluice"]  # jsluice does secret extraction
    def get_analysis_guide(self) -> str: return self._load_prompt("annie-secret_disclosure.md")
    def get_payload_templates(self) -> list[PayloadTemplate]: return []
    def get_verification_procedure(self,f:dict) -> str: return "Validate discovered secrets -> check if production credentials"
    def assess_exploitability(self,f:dict) -> dict: return {"exploitable":True,"difficulty":"low","preconditions":["Secret is valid and not revoked"]}
    def get_cvss_base(self,f:dict) -> dict: return {"AV":"N","AC":"L","AT":"N","PR":"N","UI":"N","VC":"H","VI":"H","VA":"N","SC":"H","SI":"H","SA":"N"}
