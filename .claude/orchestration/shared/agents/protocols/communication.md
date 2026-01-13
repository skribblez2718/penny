# Inter-Agent Communication

## Context Handoff Protocol

Agents explicitly pass context to successors using JSON format:

```json
{
  "taskDomain": "{identified domain}",
  "domainConfidence": "CERTAIN|PROBABLE|POSSIBLE",
  "keyFindings": ["{domain-specific discoveries}"],
  "nextAgentContext": {
    "focusAreas": ["{what next agent should prioritize}"],
    "constraints": ["{domain-specific limitations}"],
    "standards": ["{quality criteria to apply}"]
  }
}
```

### Field Definitions

| Field | Description | Required |
|-------|-------------|----------|
| `taskDomain` | technical, personal, creative, professional, recreational, hybrid | YES |
| `domainConfidence` | Certainty level of domain classification | YES |
| `keyFindings` | Critical discoveries from this agent's work | YES |
| `nextAgentContext.focusAreas` | Priority areas for successor | YES |
| `nextAgentContext.constraints` | Limitations successor must observe | NO |
| `nextAgentContext.standards` | Quality criteria for successor | NO |

---

## Cognitive Function Chaining

### Typical Sequences by Domain

| Domain | Sequence |
|--------|----------|
| **Technical** | CLARIFICATION → RESEARCH → ANALYSIS → SYNTHESIS → GENERATION → VALIDATION |
| **Personal** | CLARIFICATION → RESEARCH → ANALYSIS → SYNTHESIS → GENERATION |
| **Creative** | CLARIFICATION → RESEARCH → SYNTHESIS → GENERATION → VALIDATION |
| **Professional** | CLARIFICATION → RESEARCH → ANALYSIS → SYNTHESIS → VALIDATION |
| **Recreational** | CLARIFICATION → RESEARCH → GENERATION → VALIDATION |

### Sequence Selection Guidelines

- **Technical**: Full sequence with analysis for risk/architecture assessment
- **Personal**: Skip validation (self-directed, values-based outcomes)
- **Creative**: Skip analysis (synthesis drives creative integration)
- **Professional**: Skip generation (focus on strategy/recommendations)
- **Recreational**: Streamlined for quick engagement delivery

---

## Handoff Requirements

### Sender Agent Responsibilities

1. **Complete Johari output** with all quadrants populated
2. **Include downstream directives** with specific next-agent guidance
3. **Update unknown registry** for unresolved items
4. **Write memory file** to standard location

### Receiver Agent Responsibilities

1. **Load predecessor memory file** per context loading pattern
2. **Extract nextAgentContext** and apply to work
3. **Reference keyFindings** in own analysis
4. **Inherit domain classification** unless evidence contradicts

---

## Communication Anti-Patterns

| Anti-Pattern | Problem | Solution |
|--------------|---------|----------|
| Empty nextAgentContext | Successor has no guidance | Always populate focusAreas |
| Mismatched domain | Context confusion | Verify domain confidence |
| Missing handoff | Successor starts blind | Verify memory file exists before invocation |
| Over-scoped context | Token budget exceeded | Follow context loading pattern strictly |
