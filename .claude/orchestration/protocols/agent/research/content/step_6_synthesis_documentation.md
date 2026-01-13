# Synthesis and Documentation

## Johari Framework Application

### OPEN (Known-Known): Confirmed Facts

Present verified findings:
- State findings clearly and concisely
- Include confidence level: CERTAIN/PROBABLE/POSSIBLE/UNCERTAIN
- Cite source quality: PRIMARY/SECONDARY/COMMUNITY/ANECDOTAL

**Format:**
```
FINDING: {what was discovered}
CONFIDENCE: {level}
SOURCE: {type and quality}
IMPLICATION: {for the task}
```

### HIDDEN (Known-Unknown to Others): Non-Obvious Insights

Surface insights that aren't immediately apparent:
- Connections between disparate information
- Counterintuitive findings
- Implications that require domain expertise to see
- Patterns across sources

### BLIND (Unknown-Known): Questions Raised

Document new questions that emerged:
- What assumptions need validation?
- What dependencies were discovered?
- What considerations weren't initially apparent?
- What trade-offs became visible?

### UNKNOWN (Unknown-Unknown): Gaps for Other Agents

Identify areas requiring other cognitive functions:
- Mark areas needing ANALYSIS (interpretation, evaluation)
- Mark areas needing SYNTHESIS (integration, design)
- Mark areas needing CLARIFICATION (ambiguity resolution)

## Source Quality Assessment

Document overall source evaluation:
- Most reliable sources identified
- Conflicts between sources noted
- Gaps in available information
- Bias or limitations observed

## Memory File Update

Write research results to task memory:
- Path: `${CAII_DIRECTORY}/.claude/memory/task-{task-id}-memory.md`
- Append research section with:
  - Strategy used
  - Key findings by Johari quadrant
  - Source quality summary
  - Unknown registry updates
  - Downstream directive

## Output Generation

Generate agent output following template:
1. **Section 0:** Context loaded documentation
2. **Section 1:** Research strategy and work performed
3. **Section 2:** Johari summary (JSON format)
4. **Section 3:** Downstream directives

## Compression Techniques

Apply to stay within token budget:
- Use decisions over descriptions (WHAT discovered, not HOW)
- Abbreviate common terms
- Use lists over prose
- Reference previous findings, don't repeat
- Quantify, don't elaborate
- Focus on NEW information only

## Completion Criteria

- [ ] Findings organized by Johari quadrant
- [ ] Source quality assessed
- [ ] Memory file updated
- [ ] Output follows template format
- [ ] Token budget respected (≤5,000 total)
- [ ] Downstream directive specified
- [ ] Ready for handoff to next agent
