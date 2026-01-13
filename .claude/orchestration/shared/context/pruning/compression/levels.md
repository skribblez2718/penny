# Context Compression Levels

## Progressive Summarization Protocol

After each phase completes, orchestrator MUST compress agent outputs.

### Compression Requirements

- Token limit per phase summary: 500 tokens maximum
- Agents in Phase N+1 read: compressed phaseHistory[0...N-1] + full output from immediate predecessor
- This prevents context bloat (agents don't read all previous agent outputs)

## Phase Compression Templates

### Phase 0: Requirements

```json
{
  "phaseSummary": "Requirements phase: [1-2 sentence outcome]",
  "criticalDecisions": ["key decisions made (max 5)"],
  "keyConstraints": ["important constraints identified (max 5)"],
  "unresolvedUnknowns": ["from Unknown Registry"],
  "essentialContext": {
    "requirements": "Core requirements summary (max 100 tokens)",
    "complexity": "SIMPLE|MEDIUM|COMPLEX with justification",
    "risks": ["top 3 risks only"]
  }
}
```

### Phase 1: Research and Decisions

```json
{
  "phaseSummary": "Research and decision phase: [1-2 sentence outcome]",
  "criticalDecisions": ["Library X selected", "Pattern Y chosen"],
  "researchFindings": "Key findings summary (max 150 tokens)",
  "unresolvedUnknowns": ["outstanding questions"]
}
```

### Phase 2+: Implementation

```json
{
  "phaseSummary": "[Phase name]: [1-2 sentence outcome]",
  "artifactsCreated": ["list of created artifacts"],
  "qualityGates": ["gates passed/failed"],
  "nextPhaseNeeds": ["what next phase requires"]
}
```

## Output Compression Rules

### Step Overview (max 500 words, ~750 tokens)

- **Focus:** WHAT was accomplished, not HOW
- **Reference:** Reference previous findings, don't repeat them
- **Format:** Use bullet points over paragraphs where possible

### Johari Summary (JSON format)

- **Strict token limits:** Per quadrant limits enforced
- **No repetition:** No repetition of information in workflow metadata
- **Focus:** Focus on NEW discoveries and insights
- **Abbreviations:** Use abbreviations where clear (CRUD, API, TDD, etc.)

### Downstream Directives (max 300 tokens)

- **Format:** List format, not prose
- **Content:** Specific actionable items only

## Workflow Metadata Structure

```xml
<task_id>task-xxx</task_id>
<currentPhase>Current phase number</currentPhase>
<phaseHistory>
  <phase>
    <phase_number>Phase number</phase_number>
    <phaseSummary>Summary of phase outcome</phaseSummary>
    <criticalDecisions>List of key decisions</criticalDecisions>
    <keyConstraints>List of constraints</keyConstraints>
    <unresolvedUnknowns>Outstanding unknowns</unresolvedUnknowns>
    <essentialContext>Context needed for future phases</essentialContext>
  </phase>
</phaseHistory>
<currentContext>
  <phase>Current phase number</phase>
  <focus>Current phase focus</focus>
  <needsFromPrevious>What is needed from previous phases</needsFromPrevious>
</currentContext>
```
