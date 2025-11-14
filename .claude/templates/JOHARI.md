JOHARI WINDOW TEMPLATE

Central template for all skills using the Johari linear workflow pattern.

This is the standard Johari Window summary structure used across all skills that follow the linear workflow pattern.

FORMAT STRUCTURE

The system uses a Hybrid format combining JSON Schema (structured components) with Markdown (narratives):

- Workflow Metadata: JSON with Python type validation
- Unknown Registry: JSON array with typed enum statuses
- Downstream Directives: JSON object with string arrays
- Phase Overviews: Markdown work products
- Johari Quadrants: JSON wrapper with markdown string content (Open/Hidden/Blind/Unknown)

FORMAT DECISION MATRIX

| Component | Format | Rationale |
|-----------|--------|-----------|
| Workflow Metadata | JSON Schema | Type validation, phase tracking, cross-entity state synchronization |
| Unknown Registry | JSON Schema | Automated tracking, enum validation, structured resolution lifecycle |
| Downstream Directives | JSON Schema | Reliable parsing, structure compliance, validated field types |
| Phase Overviews | Markdown | Narrative compression, token efficiency, human readability |
| Johari Quadrants | JSON wrapper + Markdown strings | Programmatic extraction + narrative expressiveness, reduced hallucination (21% → 7.5%) |

DYNAMIC MEMORY FILE NAMING

CRITICAL: The system supports concurrent workflows across multiple sessions using task-specific memory files.

MEMORY FILE NAMING: .claude/memory/task-{task-id}-memory.md
- Example: .claude/memory/recipez-memory.md, .claude/memory/fragment-memory.md
- Each workflow uses its own dedicated memory file based on the task identifier

TASK ID FORMAT: lowercase-with-dashes (e.g., recipez, fragment, api-gateway)
- Derived from user request keywords at workflow initialization
- 1-32 characters, alphanumeric + dashes only
- No leading/trailing dashes

WORKFLOW METADATA STRUCTURE

CRITICAL: Every workflow execution must begin with Workflow Metadata section in the task-specific memory file.

FORMAT: JSON Schema with Python type validation

PYTHON TYPE DEFINITIONS
```python
from typing import Literal, Optional, List
from pydantic import BaseModel, Field, ConfigDict

class WorkflowMetadata(BaseModel):
    model_config = ConfigDict(extra='forbid')

    task_id: str = Field(pattern=r'^task-[a-z0-9-]{1,36}$')
    workflow_type: Literal["develop-agent", "develop-skill"]
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
```

WORKFLOW METADATA TEMPLATE (JSON)

```json
{
  "workflowMetadata": {
    "taskId": "task-feature-abc",
    "workflowType": "develop-agent",
    "startDate": "2025-11-06T14:30:00Z",
    "currentPhase": 1,
    "totalPhases": 8,
    "criticalConstraints": [
      "Must follow SCRP - single cognitive responsibility",
      "OAuth 2.0 RFC compliance mandatory"
    ],
    "successCriteria": [
      "Production-ready OAuth2 with Google/GitHub providers",
      "Secure token handling with <500ms response time"
    ],
    "blockingIssues": null
  },
  "unknownRegistry": {
    "unknowns": [
      {
        "id": "U1",
        "phase": 1,
        "category": "Technical",
        "description": "TLS version requirement unclear - 1.2 vs 1.3?",
        "resolutionPhase": 2,
        "status": "Unresolved",
        "resolution": null
      },
      {
        "id": "U2",
        "phase": 2,
        "category": "Scope",
        "description": "Performance target undefined - <500ms or <1s?",
        "resolutionPhase": 2,
        "status": "Resolved",
        "resolution": "User clarified via acceptance criteria: <500ms target"
      }
    ]
  }
}
```

FILE FORMAT: Implementers write JSON block wrapped in markdown code fence at top of task-{task-id}-memory.md:

````markdown
# Workflow Memory

```json
{
  "workflowMetadata": { ... },
  "unknownRegistry": { ... }
}
```

---
````

THREE-SECTION STRUCTURE FOR MEMORY FILE

CRITICAL: Each phase writes THREE sections to .claude/memory/task-{task-id}-memory.md:

1. Phase Overview — The work product/findings (what would have been in a separate docs file)
2. Johari Summary — The context state (Open/Hidden/Blind/Unknown meta-information)
3. Downstream Directives — Explicit guidance for next phase(s)

WORKFLOW METADATA PROTOCOL

AT WORKFLOW INITIALIZATION:
1. Derive task identifier from user request keywords
2. Create .claude/memory/task-{task-id}-memory.md file
3. Write Workflow Metadata JSON section as first entry (see JSON template above)
4. Populate: workflowType, taskId, startDate, currentPhase (1), totalPhases
5. Initialize empty Unknown Registry array
6. Define initial criticalConstraints and successCriteria from user request

UPDATING METADATA DURING WORKFLOW:
- Update currentPhase after each phase completion
- Add unknowns to unknownRegistry array as they're discovered
- Update unknown status to "Resolved" when resolved (with resolution text)
- For detailed implementer-side Unknown Registry consumption and resolution procedures, see .claude/protocols/CONTEXT-INHERITANCE.md

COMPLETE STRUCTURE

PHASE OUTPUT FORMAT: Combines JSON-structured components with markdown narratives

```markdown
---
PHASE N: [PHASE NAME] - OVERVIEW

[Detailed but compressed work product - MARKDOWN]
[Structured bullets/numbered lists]
[As succinct as possible without sacrificing required details]

PHASE N: [PHASE NAME] - JOHARI SUMMARY

```json
{
  "open": "[Shared context everyone is aware of - markdown formatting allowed]",
  "hidden": "[New information introduced by this phase - markdown formatting allowed]",
  "blind": "[Potential gaps or considerations not yet mentioned - markdown formatting allowed]",
  "unknown": "[Unresolved questions or ambiguities - markdown formatting allowed]"
}
```

PHASE N: [PHASE NAME] - DOWNSTREAM DIRECTIVES

```json
{
  "phaseGuidance": ["Item 1", "Item 2", "Item 3"],
  "validationRequired": ["Check 1", "Check 2"],
  "blockers": [],
  "priorityUnknowns": ["U1", "U3"]
}
```

---
```

KEY DISTINCTIONS

- Phase Overview = WORK PRODUCT → What the phase produced (findings, decisions, deliverables)
- Johari Summary = CONTEXT STATE → Meta-information about what's known/hidden/blind/unknown
- Downstream Directives = NEXT PHASE GUIDANCE → Explicit instructions and priorities for subsequent phase(s)

EXAMPLE (from a hypothetical clarification phase):
- Phase Overview = The actual requirements, acceptance criteria, assumptions
- Johari Summary = What's now confirmed (Open), what decisions were made (Hidden), what gaps exist (Blind/Unknown)
- Downstream Directives = Specific items Phase 3 must investigate, validate, or prioritize

DOWNSTREAM DIRECTIVES (SECTION 3)

PURPOSE

Downstream Directives provide explicit, actionable guidance from one phase to the next, ensuring critical information, priorities, and blockers are communicated clearly. This prevents information loss and ensures phases build on each other effectively.

STRUCTURE (JSON SCHEMA FORMAT)

FORMAT: JSON object with four typed arrays

FIELDS:
1. phaseGuidance: Array of 3-5 specific actionable items for next phase
2. validationRequired: Array of items next phase should verify
3. blockers: Array of blocking issues (empty array if none)
4. priorityUnknowns: Array of Unknown Registry IDs to prioritize (empty array if none)

TOKEN BUDGET: 30-50 tokens total (JSON structure + content)

GUIDELINES

CONCISENESS: Maximum 50 tokens total
- Use bullet points, not prose
- Be specific and actionable
- Prioritize items (most critical first)

ACTIONABILITY: Each item should be:
- Specific (not vague suggestions)
- Achievable in the next phase
- Clear what success looks like

RELEVANCE: Only include items that:
- Directly impact next phase's work
- Resolve blockers or unknowns
- Prevent rework or errors

EXAMPLE (Downstream Directives):
```json
{
  "phaseGuidance": [
    "Investigate existing implementation patterns",
    "Validate compatibility requirements",
    "Document discovered constraints"
  ],
  "validationRequired": ["Confirm no conflicting implementations exist"],
  "blockers": [],
  "priorityUnknowns": ["U1", "U3"]
}
```

Use empty arrays for blockers/priorityUnknowns when none exist. Keep phaseGuidance to 3-5 items maximum.

TOKEN BUDGET (JSON SCHEMA)

- Target: 30-50 tokens (including JSON structure)
- Maximum: 60 tokens (only if critical blockers exist)
- Minimum: 20 tokens (simple handoffs with minimal guidance)

TOKEN OPTIMIZATION WITH JSON:
- JSON structure overhead: ~15-20 tokens (keys + brackets + quotes)
- Use concise descriptions (req → requirement, auth → authentication)
- Omit empty arrays to save tokens (only blockers and priorityUnknowns can be omitted)
- Reference Unknown Registry IDs (U1, U2) instead of repeating descriptions
- Keep phaseGuidance items to 3-5 maximum

TOKEN EXAMPLE: The JSON block below uses ~23 tokens (8 structure + 15 content):
{"phaseGuidance": ["Item 1", "Item 2"], "validationRequired": ["Check X"], "blockers": [], "priorityUnknowns": ["U1"]}

JOHARI SUMMARY STRUCTURE (DETAIL)

FORMAT (JSON WRAPPER WITH MARKDOWN CONTENT)

STRUCTURE: JSON object with four keys, each containing markdown-formatted string content

```markdown
---
PHASE N: [PHASE NAME] - JOHARI SUMMARY

```json
{
  "open": "[Shared context everyone is aware of - MARKDOWN FORMATTING ALLOWED]",
  "hidden": "[New information introduced by this phase - MARKDOWN FORMATTING ALLOWED]",
  "blind": "[Potential gaps or considerations not yet mentioned - MARKDOWN FORMATTING ALLOWED]",
  "unknown": "[Unresolved questions or ambiguities - MARKDOWN FORMATTING ALLOWED]"
}
```
---
```

PYTHON TYPE DEFINITION:
```python
from pydantic import BaseModel, Field

class JohariSummary(BaseModel):
    open: str = Field(min_length=10, max_length=500)
    hidden: str = Field(min_length=10, max_length=500)
    blind: str = Field(min_length=10, max_length=500)
    unknown: str = Field(min_length=5, max_length=500)
```

TOKEN BUDGET: 65-110 tokens total (including JSON structure overhead)
- JSON structure overhead: ~8-10 tokens
- Content: 60-100 tokens (distributed across four quadrants)
- Each quadrant: 10-30 tokens depending on information density

KEY FEATURES:
- Preserves markdown formatting within strings (bold, bullets, inline code)
- Enables programmatic parsing and quadrant extraction
- Reduces hallucination risk (21% → 7.5% per research findings)
- Maintains narrative expressiveness while adding structure

THE FOUR QUADRANTS EXPLAINED

OPEN (KNOWN TO ALL)
What everyone clearly knows and agrees on. This is the shared foundation.

CONTAINS:
- High-level goals and requirements
- Confirmed choices and decisions
- Key constraints or non-negotiables
- Previously established decisions from earlier phases

PURPOSE: Provide common ground so all phases work from the same understanding.

---

HIDDEN (TO BE REVEALED)
Information or decisions this phase introduces that weren't known before. This is what becomes visible through this phase's work.

CONTAINS:
- Specific decisions made during this phase
- Implementation details or specific choices
- Discoveries from existing context/resources
- Trade-offs evaluated and resolved
- New insights from research or execution

PURPOSE: Make implicit knowledge explicit. These items become part of "Open" for future phases.

---

BLIND (SUSPECTED GAPS)
Things this phase suspects might be missing or areas where best practices should apply, but weren't explicitly mentioned earlier.

CONTAINS:
- Best practices applied proactively (even if not requested)
- Potential issues or considerations user may not have thought about
- Areas needing validation or future attention
- Recommendations for improvement
- User blind spots the AI can help address

PURPOSE: Surface potential problems early. Turn unknown unknowns into known unknowns.

---

UNKNOWN (TRUE GAPS)
Aspects that remain unresolved — information missing that could affect the work, but isn't available yet.

CONTAINS:
- Missing information that blocks or affects decisions
- Ambiguities that couldn't be resolved in this phase
- External dependencies or data not available
- Assumptions made to work around gaps (explicitly noted)
- Questions requiring user input or future research

PURPOSE: Prevent hallucinations. Make it clear what's uncertain rather than making up answers.

---

EXAMPLE (Complete Johari Summary):
```json
{
  "open": "[High-level goal/requirement confirmed]. [Key technical decisions already made]. [Core constraints established].",
  "hidden": "[Specific approach chosen this phase]. [Implementation details discovered]. [Trade-offs resolved].",
  "blind": "[Best practice applied proactively]. [Potential issue user may not have considered]. [Area needing validation].",
  "unknown": "[Missing information affecting decisions]. [Ambiguity requiring clarification]. [Assumption made explicitly noted]."
}
```

Adapt bracket placeholders to your specific workflow domain and phase context.

---

DOMAIN ADAPTATIONS

The Johari Window structure is universal across all domains — the four quadrants (Open/Hidden/Blind/Unknown) apply to any multi-phase workflow. However, the content of each quadrant adapts to the specific domain.

KEY PRINCIPLE: The framework is universal, the content is domain-specific. Adapt examples and terminology to your workflow's domain, but maintain the four-quadrant structure.

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
REMEMBER: Johari compression is the secret to maintaining context fidelity while dramatically reducing token usage. Use it in every multi-phase workflow.
