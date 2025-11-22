AGENT PROTOCOL CORE - COGNITIVE DOMAIN ENHANCED VERSION

OVERVIEW
This protocol defines how ALL cognitive domain agents execute within the Penny system. Agents apply consistent cognitive processes while adapting to task-specific contexts.

PROTOCOL STRUCTURE

SECTION 1: TASK-ID EXTRACTION AND DOMAIN CLASSIFICATION

1.1 Task-ID Extraction
Every agent invocation MUST include task-id in the prompt:
```
Task ID: task-{descriptive-keywords}
Step: {step-number}
Step Name: {step-name}
Purpose: {purpose}
```

Extract task-id from invocation prompt using regex: `task-[a-z0-9-]{1,36}`

1.2 Task Domain Classification 
```python
# Task Domain Enumeration
TaskDomain = Literal[
    "technical",      # Software, systems, engineering tasks
    "personal",       # Life decisions, personal growth, health
    "creative",       # Art, writing, design, content creation
    "professional",   # Business, career, workplace tasks
    "recreational",   # Fun, games, entertainment, hobbies
    "hybrid"         # Multi-domain tasks requiring mixed approach
]

# Domain Indicators (parse from context)
DOMAIN_INDICATORS = {
    "technical": ["code", "API", "architecture", "deployment", "debug"],
    "personal": ["life", "health", "goal", "habit", "decision"],
    "creative": ["write", "design", "story", "content", "artistic"],
    "professional": ["business", "market", "strategy", "report", "meeting"],
    "recreational": ["game", "fun", "party", "hobby", "entertainment"],
}
```

SECTION 2: CONTEXT INHERITANCE PROTOCOL

2.1 Load Workflow Context (Enhanced)
```python
# Original workflow metadata
workflow_metadata = load_json(".claude/memory/task-{task-id}-memory.md")

# Extract task domain and adaptation parameters
task_context = {
    "domain": workflow_metadata.get("taskDomain", "technical"),  
    "quality_standards": workflow_metadata.get("qualityStandards", []),
    "artifact_types": workflow_metadata.get("artifactTypes", []),
    "success_criteria": workflow_metadata.get("successCriteria", []),
    "constraints": workflow_metadata.get("constraints", [])
}

# Load domain-specific evaluation criteria
domain_criteria = load_domain_criteria(task_context["domain"])
```

2.2 Previous Agent Context Loading (SCOPED)

Agents receive explicit predecessor list in invocation with scope annotation:
```
Read context from:
- .claude/memory/task-{task-id}-memory.md (workflow metadata) [ALWAYS]
- .claude/memory/task-{task-id}-{predecessor-1}-memory.md [REQUIRED]
- .claude/memory/task-{task-id}-{predecessor-2}-memory.md [OPTIONAL: specific section]
```

Context Scope Levels:
- ALWAYS: Workflow metadata (every agent reads this)
- REQUIRED: Immediate predecessors whose outputs are critical
- OPTIONAL: Referenced for specific information (e.g., constraints, standards)

Token Budget Enforcement:
- Each agent receives max 3,000-4,000 tokens of context
- Workflow metadata: ~500 tokens
- Required predecessor outputs: ~2,500-3,000 tokens
- Optional references: ~500 tokens (specific sections only)

Scoping Strategy by Cognitive Function:
```python
CONTEXT_SCOPE_BY_FUNCTION = {
    "CLARIFICATION": {
        "first_invocation": ["workflow_metadata"],
        "subsequent": ["workflow_metadata", "previous_agent_output"]
    },
    "RESEARCH": {
        "always": ["workflow_metadata"],
        "required": ["most_recent_CLARIFICATION_or_ANALYSIS"]
    },
    "ANALYSIS": {
        "always": ["workflow_metadata"],
        "required": ["most_recent_RESEARCH_or_SYNTHESIS_or_GENERATION"],
        "optional": ["previous_ANALYSIS_for_comparison"]
    },
    "SYNTHESIS": {
        "always": ["workflow_metadata"],
        "required": ["most_recent_RESEARCH"],
        "optional": ["most_recent_ANALYSIS_if_evaluation_phase"]
    },
    "GENERATION": {
        "always": ["workflow_metadata"],
        "required": ["most_recent_SYNTHESIS_architecture_design"],
        "optional": ["most_recent_CLARIFICATION_constraints", "previous_GENERATION_for_iteration"]
    },
    "VALIDATION": {
        "always": ["workflow_metadata"],
        "required": ["target_agent_output_being_validated"],
        "optional": ["quality_standards_from_phase_0"]
    }
}
```

Load outputs from scoped predecessor list only:

```python
# Load previous agent outputs (SCOPED)
predecessor_outputs = []
context_refs = invocation_context.get("context_references", [])

for ref in context_refs:
    scope_level = ref.get("scope", "REQUIRED")
    file_path = ref.get("path")

    if scope_level == "ALWAYS" or scope_level == "REQUIRED":
        # Load full output
        output = load_markdown(file_path)
        predecessor_outputs.append(parse_agent_output(output))
    elif scope_level == "OPTIONAL":
        # Load specific section only
        section = ref.get("section", None)
        output = load_markdown_section(file_path, section)
        if output:
            predecessor_outputs.append(output)

# Extract relevant information from scoped context
previous_findings = extract_findings(predecessor_outputs)
previous_unknowns = extract_unknowns(predecessor_outputs)
previous_decisions = extract_decisions(predecessor_outputs)
```

Context Request Mechanism (If Scope Too Narrow):
```python
# If agent needs additional context not in scope
if critical_context_missing():
    unknown_registry.add({
        "id": "U{N}",
        "type": "CONTEXT_REQUEST",
        "description": "Need {specific_file} to complete {task}",
        "priority": "HIGH",
        "resolution": "Add {file} to context scope and re-invoke"
    })
```

SECTION 3: COGNITIVE FUNCTION ADAPTATION 

3.1 Cognitive Adaptation Framework
Each agent has:
- Universal Process: Consistent method (HOW)
- Domain Adaptation: Context-specific application (WHAT)
- Quality Standards: Domain-appropriate criteria (STANDARDS)

```python
class CognitiveAdaptation:
    def adapt_to_context(self, cognitive_function: str, task_context: dict):
        """
        Adapt universal cognitive function to specific task domain
        """
        # Universal process remains constant
        base_process = self.get_cognitive_process(cognitive_function)
        
        # Adapt evaluation criteria to domain
        adapted_criteria = self.adapt_criteria(
            task_context["domain"],
            task_context["quality_standards"]
        )
        
        # Select domain-appropriate methods
        domain_methods = self.select_methods(
            task_context["domain"],
            task_context["artifact_types"]
        )
        
        return {
            "process": base_process,
            "criteria": adapted_criteria,
            "methods": domain_methods
        }
```

3.2 Domain-Specific Adaptations

Technical Domain:
- Apply TDD, security patterns, SOLID principles
- Use technical vocabulary and specifications
- Generate code, configs, documentation

Personal Domain:
- Apply decision frameworks, goal-setting methods
- Use empathetic, supportive language
- Generate plans, trackers, reflection documents

Creative Domain:
- Apply narrative structure, artistic principles
- Use expressive, engaging language
- Generate content, designs, creative works

Professional Domain:
- Apply business frameworks, strategic thinking
- Use formal, precise language
- Generate reports, analyses, proposals

Recreational Domain:
- Apply fun/engagement principles
- Use casual, enthusiastic language
- Generate activities, games, entertainment plans

SECTION 4: UNKNOWN REGISTRY MANAGEMENT (Enhanced) 🤖

4.1 Unknown Categories Expanded
```python
UnknownCategory = Literal[
    # Original technical categories
    "Research", "Implementation", "Architecture", "Requirements", "Risk",
    "Scope", "Source", "Interpretation", "Validation", "Depth",
    "Technical", "Security", "Integration", "Performance", "Environment",
    
    # Domain-specific unknown categories
    "Personal",      # Personal preference, values, constraints
    "Creative",      # Artistic direction, style, audience
    "Professional",  # Business context, stakeholders, objectives
    "Recreational",  # Fun factors, participant preferences
    "Ethical",       # Moral considerations, impact assessment
    "Resource",      # Time, budget, availability constraints
    "Quality",       # Standards, expectations, success metrics
]
```

4.2 Resolution Strategy by Cognitive Agent
```python
RESOLUTION_MAPPING = {
    "CLARIFICATION": ["Scope", "Requirements", "Personal", "Creative", "Quality"],
    "RESEARCH": ["Source", "Research", "Professional", "Environment"],
    "ANALYSIS": ["Technical", "Risk", "Integration", "Performance", "Resource"],
    "SYNTHESIS": ["Architecture", "Interpretation", "Ethical"],
    "GENERATION": ["Implementation", "Creative"],
    "VALIDATION": ["Validation", "Depth", "Security", "Quality"]
}
```

SECTION 5: JOHARI WINDOW COMPRESSION (Domain-Aware)

5.1 Compression Guidelines
Original guidelines apply, with domain-specific emphasis:

Technical Tasks: Focus on architectural decisions, technical trade-offs
Personal Tasks: Focus on values alignment, emotional considerations
Creative Tasks: Focus on artistic choices, audience impact
Professional Tasks: Focus on strategic implications, stakeholder needs
Recreational Tasks: Focus on enjoyment factors, participant experience

5.2 Token Optimization and Progressive Summarization

JOHARI WINDOW TOKEN LIMITS (STRICT ENFORCEMENT):
```python
JOHARI_TOKEN_LIMITS = {
    "open": 300,      # 200-300 tokens max - core findings only
    "hidden": 300,    # 200-300 tokens max - key insights only
    "blind": 200,     # 150-200 tokens max - limitations only
    "unknown": 200,   # 150-200 tokens max - unknowns for registry
    "domain_insights": 200  # Optional, 150-200 tokens if included
}

TOTAL_MAX_PER_AGENT = 1,200 tokens (strict limit)
```

COMPRESSION TECHNIQUES BY DOMAIN:
```python
def compress_johari_summary(domain: str, content: dict) -> dict:
    """
    Apply domain-specific compression to maintain context within token limits
    """
    compression_rules = {
        "technical": focus_on_decisions_and_architecture,
        "personal": focus_on_values_and_milestones,
        "creative": focus_on_creative_choices_and_impact,
        "professional": focus_on_strategy_and_metrics,
        "recreational": focus_on_experience_and_logistics
    }

    return compression_rules[domain](content)

def focus_on_decisions_and_architecture(content):
    """Technical domain compression - emphasize decisions, not narrative"""
    return {
        "open": extract_technical_decisions(content),      # What was decided
        "hidden": extract_implementation_choices(content), # Why decided
        "blind": extract_technical_gaps(content),          # What's missing
        "unknown": extract_technical_unknowns(content)     # What needs resolution
    }
```

PROGRESSIVE SUMMARIZATION PROTOCOL:

Phase-Level Compression (After Phase Completes):
```python
def compress_phase_outputs(phase_num: int, agent_outputs: List[Dict]) -> Dict:
    """
    After phase completes, compress all agent outputs into phase summary.
    Store in workflow metadata under phaseHistory[N].
    """

    if phase_num == 0:  # Requirements
        return {
            "phaseSummary": "Requirements phase: [1-2 sentence outcome]",
            "criticalDecisions": ["Decision 1", "Decision 2"],  # Max 5
            "keyConstraints": ["Constraint 1", "Constraint 2"],  # Max 5
            "unresolvedUnknowns": ["U1: description"],  # From Unknown Registry
            "essentialContext": {
                "requirements": "Core requirements summary (100 tokens max)",
                "complexity": "SIMPLE|MEDIUM|COMPLEX with justification",
                "risks": "Top 3 risks only"
            }
        }

    elif phase_num == 1:  # Research & Decisions
        return {
            "phaseSummary": "Research and decision phase: [1-2 sentence outcome]",
            "criticalDecisions": ["Library X selected", "Pattern Y chosen"],
            "researchFindings": "Key findings summary (150 tokens max)",
            "unresolvedUnknowns": []
        }

    # ... similar for each phase
```

Workflow Metadata Enhancement:
```json
{
  "task_id": "task-xxx",
  "currentPhase": 3,
  "phaseHistory": [
    {
      "phase": 0,
      "phaseSummary": "Requirements clarified and analyzed",
      "criticalDecisions": ["OAuth2 with Google", "JWT tokens", "Redis cache"],
      "keyConstraints": ["<500ms performance", "OWASP compliant"],
      "unresolvedUnknowns": [],
      "essentialContext": {
        "requirements": "5 core features, 2 constraints, MEDIUM complexity",
        "complexity": "MEDIUM - OAuth2 integration, security focus, 32-40hr timeline",
        "risks": "Push notification debugging (HIGH), Token refresh UX (MEDIUM)"
      }
    },
    {
      "phase": 1,
      "phaseSummary": "Research complete, technology stack decided",
      "criticalDecisions": ["google-auth-library-python", "PostgreSQL for tokens"],
      "researchFindings": "3 libraries evaluated, security patterns identified",
      "unresolvedUnknowns": []
    }
  ],
  "currentContext": {
    "phase": 2,
    "focus": "Architecture design",
    "needsFromPrevious": ["Library choice", "Storage decision", "Security patterns"]
  }
}
```

AGENT OUTPUT COMPRESSION RULES:

Step Overview (Narrative):
- Max 500 words (~750 tokens)
- Focus on WHAT was accomplished, not HOW
- Reference previous findings, don't repeat them
- Use bullet points over paragraphs where possible

Johari Summary (JSON):
- Strict token limits per quadrant
- No repetition of information in workflow metadata
- Focus on NEW discoveries and insights
- Use abbreviations where clear (CRUD, API, TDD, etc.)

Downstream Directives:
- Max 300 tokens
- List format, not prose
- Specific actionable items only

SECTION 6: OUTPUT FORMATTING

6.1 Three-Section Output Structure (Universal)
All agents produce:

```markdown
STEP {N}: {Cognitive Function} Execution

STEP OVERVIEW
[Domain-adapted narrative of work performed]

JOHARI SUMMARY
```json
{
  "open": "[Confirmed knowledge adapted to domain]",
  "hidden": "[Discoveries relevant to domain]",
  "blind": "[Domain-specific gaps identified]",
  "unknown": "[Domain-appropriate unknowns]"
}
```

DOWNSTREAM DIRECTIVES
```json
{
  "primaryFindings": [...],
  "recommendedActions": [...],
  "criticalConstraints": [...],
  "unknownRegistryUpdates": [...]
}
```
```

6.2 Domain-Specific Output Adaptations

**Technical Output**: Include code snippets, architecture diagrams, API specs
**Personal Output**: Include decision matrices, goal alignments, reflection prompts
**Creative Output**: Include creative samples, mood boards, audience profiles
**Professional Output**: Include metrics, KPIs, strategic alignments
**Recreational Output**: Include fun factors, engagement metrics, participant feedback

SECTION 7: QUALITY GATES (Domain-Aware)

7.1 Universal Gate Logic
All agents verify:
- Task requirements addressed
- Unknowns resolved for this phase
- Output quality meets standards
- Context preserved for downstream

7.2 Domain-Specific Gate Criteria
```python
DOMAIN_GATES = {
    "technical": ["Tests pass", "Security validated", "Performance acceptable"],
    "personal": ["Values aligned", "Constraints respected", "Wellbeing considered"],
    "creative": ["Audience appropriate", "Creative vision clear", "Quality acceptable"],
    "professional": ["Business case valid", "Stakeholders considered", "ROI positive"],
    "recreational": ["Fun factor high", "Participants accommodated", "Safety ensured"]
}
```

SECTION 8: ERROR HANDLING AND RECOVERY

8.1 Cognitive Function Failures
When agent cannot complete cognitive function:
1. Document specific failure in Johari "blind" section
2. Add to Unknown Registry with resolution_phase
3. Suggest alternative cognitive path
4. Request orchestrator intervention if critical

8.2 Domain Adaptation Failures
When domain unclear or hybrid:
1. Default to most conservative domain
2. Document ambiguity in output
3. Request CLARIFICATION agent intervention
4. Apply multiple domain criteria if needed

SECTION 9: INTER-AGENT COMMUNICATION

9.1 Context Handoff Protocol
Agents explicitly pass:
```json
{
  "taskDomain": "identified domain",
  "domainConfidence": "CERTAIN|PROBABLE|POSSIBLE",
  "keyFindings": ["domain-specific discoveries"],
  "nextAgentContext": {
    "focusAreas": ["what next agent should prioritize"],
    "constraints": ["domain-specific limitations"],
    "standards": ["quality criteria to apply"]
  }
}
```

9.2 Cognitive Function Chaining 
Typical sequences by domain:

Technical: CLARIFICATION → RESEARCH → ANALYSIS → SYNTHESIS → GENERATION → VALIDATION
Personal: CLARIFICATION → RESEARCH → ANALYSIS → SYNTHESIS → GENERATION
Creative: CLARIFICATION → RESEARCH → SYNTHESIS → GENERATION → VALIDATION
Professional: CLARIFICATION → RESEARCH → ANALYSIS → SYNTHESIS → VALIDATION
Recreational: CLARIFICATION → RESEARCH → GENERATION → VALIDATION

SECTION 10: PROTOCOL VALIDATION CHECKLIST

Before completing work, EVERY agent verifies:

- [ ] Task-ID extracted successfully
- [ ] Task domain identified (confidence level documented)
- [ ] Workflow context fully loaded
- [ ] Previous agent outputs integrated
- [ ] Unknown Registry checked and updates proposed
- [ ] Cognitive function adapted to domain
- [ ] Quality standards applied appropriately
- [ ] Johari Summary compressed effectively
- [ ] Downstream Directives complete
- [ ] Output formatted correctly
- [ ] Gate criteria satisfied
- [ ] Context preserved for next agent

CRITICAL SUCCESS FACTORS

1. Domain Identification: Correctly identify task domain early
2. Cognitive Consistency: Apply universal process regardless of domain
3. Context Adaptation: Adjust WHAT not HOW based on domain
4. Quality Maintenance: Apply domain-appropriate standards
5. Token Efficiency: Compress intelligently while preserving critical context
6. Handoff Clarity: Next agent receives sufficient context to adapt

APPENDIX A: QUICK REFERENCE

Agent Invocation Always Includes:
- Task-ID
- Step number and name
- Purpose statement
- Gate entry/exit criteria
- Context files to read
- Previous agent dependencies

Agent Always Produces:
- Step Overview (narrative)
- Johari Summary (JSON)
- Downstream Directives (JSON)
- Unknown Registry updates
- Task domain classification
- Quality validation results

Memory File Locations:
- Workflow metadata: `task-{id}-memory.md`
- Agent outputs: `task-{id}-{agent}-memory.md`
- All in `.claude/memory/` directory

This protocol ensures cognitive domain agents can handle ANY task while maintaining quality and consistency.
