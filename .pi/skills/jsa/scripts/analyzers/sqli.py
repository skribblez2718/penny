"""SQL Injection Analyzer."""
from .base import VulnerabilityAnalyzer, SourceSink, PayloadTemplate
class SQLInjectionAnalyzer(VulnerabilityAnalyzer):
    @property
    def vuln_class(self) -> str:
        return "sqli"
    @property
    def display_name(self) -> str:
        return "SQL Injection"
    @property
    def default_severity(self) -> str:
        return "critical"
    def get_source_sink_pairs(self) -> list[SourceSink]: return [SourceSink("User input->SQL query",["req.query","req.params","req.body","input.value","location.search"],["db.query()","db.execute()","knex.raw()","sequelize.query()",'`SELECT * WHERE ${'] ,"critical","CWE-89")]
    def get_semgrep_rulesets(self) -> list[str]: return ["p/sql-injection","p/javascript","p/owasp-top-ten"]
    def get_custom_scanners(self) -> list[str]: return ["sql_injection_scanner"]
    def get_analysis_guide(self) -> str: return self._load_prompt("annie-sqli.md")
    def get_payload_templates(self) -> list[PayloadTemplate]: return [PayloadTemplate("sqli","SQL injection","' OR '1'='1",target_context="html")]
    def get_verification_procedure(self,f:dict) -> str: return "Inject SQL payload -> check for query manipulation"
    def assess_exploitability(self,f:dict) -> dict: return {"exploitable":True,"difficulty":"medium","preconditions":["Query built with string concatenation from user input"]}
    def get_cvss_base(self,f:dict) -> dict: return {"AV":"N","AC":"L","AT":"N","PR":"N","UI":"N","VC":"H","VI":"H","VA":"H","SC":"H","SI":"H","SA":"H"}
