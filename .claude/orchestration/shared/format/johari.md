# Johari Window Format

## Token Limits

**Strict Limits:**
- **open:** 200-300 tokens max - core findings only
- **hidden:** 200-300 tokens max - key insights only
- **blind:** 150-200 tokens max - limitations only
- **unknown:** 150-200 tokens max - unknowns for registry
- **domain_insights:** 150-200 tokens (optional)
- **TOTAL:** 1200 tokens STRICT LIMIT

## Quadrant Definitions

### Open Quadrant
- **Purpose:** Confirmed knowledge, verified facts
- **Content:** What both agent and downstream consumers know
- **Focus:** Core findings, validated decisions, confirmed requirements

### Hidden Quadrant
- **Purpose:** Discoveries and insights from this execution
- **Content:** What agent discovered that downstream may not yet know
- **Focus:** New patterns, unexpected findings, emerging insights

### Blind Quadrant
- **Purpose:** Known limitations and gaps
- **Content:** What agent recognizes as missing or uncertain
- **Focus:** Acknowledged unknowns, dependency gaps, scope limitations

### Unknown Quadrant
- **Purpose:** Unknown unknowns for registry
- **Content:** Areas where neither agent nor system has visibility
- **Focus:** Questions not yet asked, risks not yet identified

## Domain-Specific Emphasis

- **Technical:** Focus on architectural decisions, technical trade-offs
- **Personal:** Focus on values alignment, emotional considerations
- **Creative:** Focus on artistic choices, audience impact
- **Professional:** Focus on strategic implications, stakeholder needs
- **Recreational:** Focus on enjoyment factors, participant experience

## Compression Techniques

- **Technical:** Focus on decisions and architecture, not narrative
- **Personal:** Focus on values and milestones
- **Creative:** Focus on creative choices and impact
- **Professional:** Focus on strategy and metrics
- **Recreational:** Focus on experience and logistics

## JSON Format

```json
{
  "open": {
    "findings": ["...", "..."],
    "decisions": ["...", "..."],
    "constraints": ["...", "..."]
  },
  "hidden": {
    "discoveries": ["...", "..."],
    "insights": ["...", "..."],
    "patterns": ["...", "..."]
  },
  "blind": {
    "limitations": ["...", "..."],
    "gaps": ["...", "..."],
    "dependencies": ["...", "..."]
  },
  "unknown": {
    "questions": ["...", "..."],
    "risks": ["...", "..."],
    "exploration_areas": ["...", "..."]
  },
  "domain_insights": {
    "domain": "technical|personal|creative|professional|recreational",
    "specific_findings": ["...", "..."]
  }
}
```
