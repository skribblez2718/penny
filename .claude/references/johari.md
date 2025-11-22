JOHARI TEMPLATE - COGNITIVE DOMAIN ENHANCED

This file contains unique supplementary content not covered in agent-protocol-core.md.

IMPORTANT: For agent execution protocols, agents MUST read:
- .claude/protocols/agent-protocol-core.md (all agents - includes Task-ID, context inheritance, output formatting)
- .claude/protocols/agent-protocol-extended.md (code generation agents - includes TDD + Security)

This template provides Python type definitions, format decision guidance, and anti-pattern examples.

---

FORMAT DECISION MATRIX

| Component | Format | Rationale |
|-----------|--------|-----------|
| Workflow Metadata | JSON Schema | Type validation, phase tracking, cross-entity state synchronization |
| Unknown Registry | JSON Schema | Automated tracking, enum validation, structured resolution lifecycle |
| Downstream Directives | JSON Schema | Reliable parsing, structure compliance, validated field types |
| Phase Overviews | Markdown | Narrative compression, token efficiency, human readability |
| Johari Quadrants | JSON wrapper + Markdown strings | Programmatic extraction + narrative expressiveness, reduced hallucination (21% → 7.5%) |

---

ENHANCED PYTHON TYPE DEFINITIONS FOR COGNITIVE DOMAINS

Use these for type validation when working with memory files:

```python
from typing import Literal, Optional, List, Dict, Any
from pydantic import BaseModel, Field, ConfigDict

# Task domain enumeration
TaskDomain = Literal[
    "technical",
    "personal", 
    "creative",
    "professional",
    "recreational",
    "hybrid"
]

# Cognitive function enumeration
CognitiveFunction = Literal[
    "RESEARCH",
    "ANALYSIS",
    "SYNTHESIS",
    "GENERATION",
    "VALIDATION",
    "CLARIFICATION",
    "COORDINATION"
]

class WorkflowMetadata(BaseModel):
    model_config = ConfigDict(extra='forbid')

    task_id: str = Field(pattern=r'^task-[a-z0-9-]{1,36}$')
    workflow_type: Literal["cognitive-orchestration", "develop-project", "develop-skill", "custom"]
    task_domain: TaskDomain  # Domain classification
    start_date: str  # ISO 8601: YYYY-MM-DDTHH:mm:ssZ
    current_phase: int = Field(ge=1)
    total_phases: int = Field(ge=1)
    critical_constraints: List[str]
    success_criteria: List[str]
    quality_standards: List[str] = Field(default_factory=list)  # Domain-specific standards
    artifact_types: List[str] = Field(default_factory=list)  # Expected output types
    cognitive_sequence: List[CognitiveFunction] = Field(default_factory=list)  # Agent sequence
    blocking_issues: Optional[str] = None

class Unknown(BaseModel):
    model_config = ConfigDict(extra='forbid')

    id: str = Field(pattern=r'^U[0-9]+$')
    phase: int = Field(ge=1)
    category: Literal[
        "Research", "Implementation", "Architecture", "Requirements", "Risk",
        "Scope", "Source", "Interpretation", "Validation", "Depth",
        "Technical", "Security", "Integration", "Performance", "Environment",
        "Personal", "Creative", "Professional", "Recreational",
        "Ethical", "Resource", "Quality"
    ]
    description: str
    resolution_phase: Optional[int] = Field(None, ge=1)
    cognitive_agent: Optional[CognitiveFunction] = None  # NEW: Which agent resolves
    status: Literal["Unresolved", "In Progress", "Resolved", "Deferred"]
    resolution: Optional[str] = None

class UnknownRegistry(BaseModel):
    model_config = ConfigDict(extra='forbid')
    unknowns: List[Unknown]

# Domain-aware Johari Summary
class JohariSummary(BaseModel):
    open: str = Field(min_length=10, max_length=500)
    hidden: str = Field(min_length=10, max_length=500)
    blind: str = Field(min_length=10, max_length=500)
    unknown: str = Field(min_length=5, max_length=500)
    domain_insights: Optional[Dict[str, str]] = None  # NEW: Domain-specific insights

# Cognitive Context for agent invocation
class CognitiveContext(BaseModel):
    task_id: str
    task_domain: TaskDomain
    cognitive_function: CognitiveFunction
    step_number: int
    purpose: str
    gate_entry: List[str]
    gate_exit: List[str]
    quality_standards: List[str]
    predecessor_outputs: List[str]  # File paths to read
```

---

DOMAIN-SPECIFIC JOHARI ADAPTATIONS

The Johari Window structure is universal, but content adapts to domain:

### Technical Domain Example
```json
{
  "open": "OAuth2 with Google provider confirmed. Flask/SQLAlchemy stack. Performance targets: <500ms token endpoint.",
  "hidden": "Chose JWT over opaque tokens for stateless scaling. Implemented refresh token rotation for security.",
  "blind": "Microservice communication patterns not addressed - may need service mesh considerations.",
  "unknown": "Kubernetes deployment specifics. Load balancer configuration requirements.",
  "domain_insights": {
    "architecture": "Event-driven chosen over synchronous for resilience",
    "security": "Zero-trust principles applied throughout"
  }
}
```

### Personal Domain Example
```json
{
  "open": "Career change decision framework established. Values: growth, balance, impact. Timeline: 6 months.",
  "hidden": "Identified unconscious bias toward tech roles. Financial runway calculated: 8 months buffer.",
  "blind": "Partner's career plans may affect relocation options. Industry connections underutilized.",
  "unknown": "Market conditions in 6 months. Skill gaps for target roles.",
  "domain_insights": {
    "values_alignment": "Growth weighted 40%, balance 35%, impact 25%",
    "risk_tolerance": "Moderate - willing to take calculated risks"
  }
}
```

### Creative Domain Example
```json
{
  "open": "Blog series on AI ethics planned. Target audience: tech professionals. Tone: thoughtful, accessible.",
  "hidden": "Drew inspiration from Asimov's laws for framework. Avoiding controversial current events.",
  "blind": "Audience's actual AI knowledge level unclear. Competing content not fully researched.",
  "unknown": "Optimal publishing frequency. Engagement metrics expectations.",
  "domain_insights": {
    "narrative_structure": "Problem-exploration-solution arc for each post",
    "voice": "Authoritative yet approachable, avoiding jargon"
  }
}
```

### Professional Domain Example
```json
{
  "open": "Q3 strategy includes market expansion to APAC. Budget: $2M. Timeline: 90 days to launch.",
  "hidden": "Competitor analysis reveals vulnerability in their enterprise segment. Building partnerships quietly.",
  "blind": "Regulatory requirements in target markets not fully mapped. Cultural adaptation needs unclear.",
  "unknown": "Currency fluctuation impact. Local competitor response strategies.",
  "domain_insights": {
    "strategic_priority": "Market share over immediate profitability",
    "risk_mitigation": "Phased rollout with exit criteria defined"
  }
}
```

### Recreational Domain Example
```json
{
  "open": "Puzzle game concept: physics-based with time manipulation. Platform: mobile. Audience: casual gamers.",
  "hidden": "Inspired by Braid mechanics but simplified for mobile. Monetization through optional hints.",
  "blind": "Mobile hardware limitations for physics simulation. Competitor patent landscape.",
  "unknown": "Optimal tutorial length. Player retention metrics for similar games.",
  "domain_insights": {
    "fun_factor": "Discovery and 'aha' moments prioritized over difficulty",
    "accessibility": "One-handed play required, colorblind modes planned"
  }
}
```

---

COGNITIVE AGENT OUTPUT PATTERNS

Each cognitive agent produces domain-adapted outputs:

### RESEARCH Agent Output Pattern
```json
{
  "open": "[Domain] research findings: [Key discoveries relevant to domain]",
  "hidden": "Sources evaluated: [X academic, Y industry, Z community]. Reliability scores: [High/Medium/Low]",
  "blind": "Research gaps: [What couldn't be found]. Contradictions: [Conflicting information]",
  "unknown": "[Domain-specific unknowns requiring other cognitive functions]"
}
```

### ANALYSIS Agent Output Pattern
```json
{
  "open": "Complexity assessment: [SIMPLE/MEDIUM/COMPLEX]. Key dependencies: [List]. Risks: [Identified]",
  "hidden": "Applied [domain] analysis framework. Trade-offs: [Option A vs B]. Critical path: [Identified]",
  "blind": "Analysis limitations: [What couldn't be analyzed]. Edge cases: [Not fully explored]",
  "unknown": "Needs synthesis to resolve: [Conflicting requirements]. Validation required: [Assumptions]"
}
```

### SYNTHESIS Agent Output Pattern
```json
{
  "open": "Integrated design: [Coherent solution combining all inputs]. Framework: [Structured approach]",
  "hidden": "Resolved contradictions: [How conflicts addressed]. Design decisions: [Key choices with rationale]",
  "blind": "Integration challenges: [Remaining seams]. Assumptions: [What synthesis assumes]",
  "unknown": "Implementation details: [Needs generation]. Validation criteria: [Needs definition]"
}
```

### GENERATION Agent Output Pattern
```json
{
  "open": "Generated artifacts: [List of created items]. Quality standards met: [Checklist]",
  "hidden": "Implementation choices: [Technology/approach decisions]. Optimizations: [Performance/quality improvements]",
  "blind": "Edge cases: [Not fully handled]. Limitations: [Known constraints]",
  "unknown": "Testing coverage: [Needs validation]. Integration points: [Needs verification]"
}
```

### VALIDATION Agent Output Pattern
```json
{
  "open": "Validation results: [PASS/FAIL]. Criteria checked: [List]. Issues found: [Specific problems]",
  "hidden": "Test coverage: [X%]. Security scan: [Results]. Performance metrics: [Measurements]",
  "blind": "Validation gaps: [What couldn't be tested]. Assumptions: [What validation assumes]",
  "unknown": "Production behavior: [Needs real-world testing]. Long-term stability: [Needs monitoring]"
}
```

### CLARIFICATION Agent Output Pattern
```json
{
  "open": "Clarified requirements: [Explicit specifications]. Constraints discovered: [Hidden limitations]",
  "hidden": "Questions asked: [Count]. Assumptions invalidated: [Which ones]. Scope refined: [How]",
  "blind": "Remaining ambiguities: [Still unclear]. Implicit assumptions: [Not yet surfaced]",
  "unknown": "Discovered unknowns: [What we didn't know to ask about]"
}
```

---

ANTI-PATTERNS TO AVOID

DOMAIN CONFUSION: Don't mix domains inappropriately
```json
{
  "open": "Built REST API for managing personal goals"  // Mixing technical + personal
}
```
CLEAR DOMAIN SEPARATION: Keep domain context clear
```json
{
  "open": "Technical: Built REST API. Personal context: API manages user's personal goals"
}
```

COGNITIVE FUNCTION CREEP: Don't exceed cognitive boundaries
```json
{
  "open": "RESEARCH agent: Designed architecture based on findings"  // Research shouldn't design
}
```
MAINTAIN COGNITIVE DISCIPLINE: Each agent stays in its lane
```json
{
  "open": "RESEARCH agent: Found 3 architectural patterns applicable to requirements"
}
```

LOST DOMAIN CONTEXT: Don't forget to pass domain forward
```json
{
  "downstream_directives": {
    "next_agent": "ANALYSIS"  // Missing domain context
  }
}
```
PRESERVE DOMAIN CONTEXT: Always pass domain information
```json
{
  "downstream_directives": {
    "next_agent": "ANALYSIS",
    "task_domain": "technical",
    "domain_confidence": "CERTAIN"
  }
}
```

VAGUE STATEMENTS: No concrete information
```json
{
  "hidden": "Made some decisions"
}
```
SPECIFIC DETAILS: Name what was decided
```json
{
  "hidden": "Chose 5-query decomposition strategy. Prioritized peer-reviewed sources. Focused on ML subfield."
}
```

IGNORING GAPS: Not acknowledging unknowns
```json
{
  "unknown": ""  // Empty when work proceeds with unvalidated assumptions
}
```
EXPLICIT UNKNOWNS: Flag missing information
```json
{
  "unknown": "Geographic scope not specified - assumed global. Target expertise unclear - aimed intermediate."
}
```

---

REMEMBER: 
- Johari compression maintains context fidelity while reducing tokens
- Cognitive agents adapt their process to domain while maintaining consistency
- Domain context must flow through entire workflow for successful adaptation

TOKEN SAVINGS: This enhanced reference maintains ~200 lines vs potential 500+ (60% reduction)
For complete execution protocols, read agent-protocol-core.md or agent-protocol-extended.md.
