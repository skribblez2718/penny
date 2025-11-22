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

2.2 Previous Agent Context Loading 
Agents receive explicit predecessor list in invocation:
```
Read context from:
- .claude/memory/task-{task-id}-memory.md (workflow metadata)
- .claude/memory/task-{task-id}-{predecessor-1}-memory.md
- .claude/memory/task-{task-id}-{predecessor-2}-memory.md
```

Load and parse each file to build complete context.

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

5.2 Token Optimization
```python
def compress_johari_summary(domain: str, content: dict) -> dict:
    """
    Apply domain-specific compression to maintain context within token limits
    """
    compression_rules = {
        "technical": lambda x: focus_on_technical_decisions(x),
        "personal": lambda x: focus_on_personal_insights(x),
        "creative": lambda x: focus_on_creative_elements(x),
        "professional": lambda x: focus_on_business_impact(x),
        "recreational": lambda x: focus_on_fun_factors(x)
    }
    
    return compression_rules[domain](content)
```

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
