JOHARI TEMPLATE - COMPRESSED REFERENCE

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

PYTHON TYPE DEFINITIONS

Use these for type validation when working with memory files:

```python
from typing import Literal, Optional, List
from pydantic import BaseModel, Field, ConfigDict

class WorkflowMetadata(BaseModel):
    model_config = ConfigDict(extra='forbid')

    task_id: str = Field(pattern=r'^task-[a-z0-9-]{1,36}$')
    workflow_type: Literal["develop-agent", "develop-skill", "develop-project"]
    start_date: str  # ISO 8601: YYYY-MM-DDTHH:mm:ssZ
    current_phase: int = Field(ge=1)
    total_phases: int = Field(ge=1)
    critical_constraints: List[str]
    success_criteria: List[str]
    blocking_issues: Optional[str] = None

class Unknown(BaseModel):
    model_config = ConfigDict(extra='forbid')

    id: str = Field(pattern=r'^U[0-9]+$')
    phase: int = Field(ge=1)
    category: Literal[
        "Research", "Implementation", "Architecture", "Requirements", "Risk",
        "Scope", "Source", "Interpretation", "Validation", "Depth",
        "Technical", "Security", "Integration", "Performance", "Environment"
    ]
    description: str
    resolution_phase: Optional[int] = Field(None, ge=1)
    status: Literal["Unresolved", "In Progress", "Resolved", "Deferred"]
    resolution: Optional[str] = None

class UnknownRegistry(BaseModel):
    model_config = ConfigDict(extra='forbid')
    unknowns: List[Unknown]

class JohariSummary(BaseModel):
    open: str = Field(min_length=10, max_length=500)
    hidden: str = Field(min_length=10, max_length=500)
    blind: str = Field(min_length=10, max_length=500)
    unknown: str = Field(min_length=5, max_length=500)
```

---

DOMAIN ADAPTATIONS

The Johari Window structure is universal across all domains — the four quadrants (Open/Hidden/Blind/Unknown) apply to any multi-phase workflow. However, the content of each quadrant adapts to the specific domain.

KEY PRINCIPLE: The framework is universal, the content is domain-specific. Adapt examples and terminology to your workflow's domain, but maintain the four-quadrant structure.

---

ANTI-PATTERNS TO AVOID

REPEATING FULL CONTEXT: Don't copy everything from previous phases
```json
{
  "open": "[Repeating 200+ tokens of earlier context verbatim...]"
}
```
REFERENCE AND SUMMARIZE: Briefly reference confirmed context
```json
{
  "open": "Research on topic X with Standard depth per earlier phases. Focus on 2020-2025 timeframe."
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
  "hidden": "Chose 5-query decomposition strategy. Prioritized peer-reviewed sources. Focused on ML subfield (not general automation)."
}
```

IGNORING GAPS: Not acknowledging unknowns
```json
{
  "open": "...",
  "hidden": "...",
  "blind": "...",
  "unknown": ""
}
```
(Empty unknown field when work proceeds with unvalidated assumptions)

EXPLICIT UNKNOWNS: Flag missing information
```json
{
  "unknown": "Geographic scope not specified - assumed global. Target audience expertise unclear - aimed at intermediate level."
}
```

OVERWHELMING DETAIL: Dumping everything into summary
```json
{
  "hidden": "[500 tokens of minutiae that don't affect future phases...]"
}
```
HIGH-SIGNAL ONLY: Include decisions/insights that matter to future phases
```json
{
  "hidden": "Decomposed into 5 queries covering current state, mechanisms, trends. Prioritized peer-reviewed sources for credibility."
}
```

---

REMEMBER: Johari compression is the secret to maintaining context fidelity while dramatically reducing token usage. Use it in every multi-phase workflow.

TOKEN SAVINGS: This compressed reference is ~150 lines vs 495 lines (70% reduction).
For complete execution protocols, read agent-protocol-core.md or agent-protocol-extended.md.
