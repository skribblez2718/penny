"""Insecure Deserialization Analyzer."""
from .base import VulnerabilityAnalyzer, SourceSink, PayloadTemplate
class InsecureDeserializationAnalyzer(VulnerabilityAnalyzer):
    @property
    def vuln_class(self) -> str:
        return "insecure_deserialization"
    @property
    def display_name(self) -> str:
        return "Insecure Deserialization"
    @property
    def default_severity(self) -> str:
        return "high"
    def get_source_sink_pairs(self) -> list[SourceSink]: return [SourceSink("User data->deserialization",["JSON.parse(userInput)","localStorage.getItem","event.data"],["eval('('+data+')')","node-serialize.unserialize()","js-yaml.load()","serialize-javascript.deserialize()"],"high","CWE-502")]
    def get_semgrep_rulesets(self) -> list[str]: return ["p/javascript","p/security-audit"]
    def get_custom_scanners(self) -> list[str]: return []
    def get_payload_templates(self) -> list[PayloadTemplate]: return [PayloadTemplate("id","Deserialization RCE",'{"rce":"_$$ND_FUNC$$_function(){require(\'child_process\').exec(\'id\')}"}',target_context="html")]
    def get_verification_procedure(self,f:dict) -> str: return "Inject serialized payload -> check if deserialized and executed"
    def assess_exploitability(self,f:dict) -> dict: return {"exploitable":True,"difficulty":"medium","preconditions":["Unsafe deserialization of user-controlled data"]}
    def get_cvss_base(self,f:dict) -> dict: return {"AV":"N","AC":"L","AT":"N","PR":"N","UI":"N","VC":"H","VI":"H","VA":"H","SC":"H","SI":"H","SA":"H"}
