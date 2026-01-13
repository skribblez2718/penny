# Output Generation

## Johari Framework Application

### OPEN (Known-Known): Clear Analytical Findings

Present verified findings:
- Complexity scores with detailed justification
- Identified dependencies with criticality ratings
- Risk matrix with likelihood/impact scoring
- Key patterns and their implications

**Format:**
```
FINDING: {clear statement}
EVIDENCE: {supporting data}
CONFIDENCE: {CERTAIN|PROBABLE|POSSIBLE}
IMPLICATION: {for downstream agents}
```

### HIDDEN (Known-Unknown): Non-Obvious Patterns

Surface insights not immediately apparent:
- Subtle dependencies
- Secondary and tertiary effects
- Counter-intuitive findings
- Optimization opportunities

### BLIND (Unknown-Known): Analytical Limitations

Acknowledge limitations encountered:
- Areas where information is insufficient
- Assumptions you had to make
- Alternative interpretations possible
- Biases in available data

### UNKNOWN (Unknown-Unknown): Areas Requiring Investigation

Identify areas needing deeper work:
- Questions your analysis has raised
- Edge cases not yet explored
- Emergent complexity requiring expertise
- Interdependencies beyond current scope

## Output Artifacts

Generate as appropriate:
- Dependency graphs (text format)
- Complexity matrices
- Risk registers
- Trade-off tables
- Pattern catalogs
- Recommendation priorities

## Memory File Update

Write analysis results to task memory:
- Path: `${CAII_DIRECTORY}/.claude/memory/task-{task-id}-memory.md`
- Append analysis section with:
  - Framework used
  - Key findings by Johari quadrant
  - Complexity assessment
  - Risk register
  - Unknown registry updates
  - Downstream directive

## Compression Techniques

Apply to stay within token budget:
- Use decisions over descriptions (WHAT was found, not HOW)
- Abbreviate common terms
- Use lists over prose
- Quantify complexity (e.g., "MEDIUM (8 components, 12 dependencies)")
- Focus on NEW information only

## Completion Criteria

- [ ] Findings organized by Johari quadrant
- [ ] Artifacts generated as needed
- [ ] Memory file updated
- [ ] Output follows template format
- [ ] Token budget respected (≤5,000 total)
- [ ] Downstream directive specified
- [ ] Ready for handoff to synthesis
