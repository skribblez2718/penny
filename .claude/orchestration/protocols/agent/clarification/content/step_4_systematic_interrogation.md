# Systematic Interrogation

## Execution Approach

**CRITICAL:** As a subagent, you CANNOT use `AskUserQuestion` directly. Instead:

1. **Formulate questions** using the interrogation layers below
2. **Document all questions** in your memory file's Section 4 (User Questions)
3. **Set `clarification_required: true`** if user input is needed
4. **Return your output** - the main orchestrator will present questions to the user

The main orchestrator thread will:
- Parse your `user_questions` JSON from the memory file
- Use `AskUserQuestion` to present them to the user
- Resume the workflow with answers as context

## Interrogation Layers

### Foundation Layer
**Purpose:** Establish intent and context

**Core Questions:**
- What is the fundamental goal/purpose?
- What problem are you solving?
- What does success look like?

**Expected Output:** Clear understanding of WHY this work matters

### Structural Layer
**Purpose:** Define scope and components

**Core Questions:**
- What are the key elements/components?
- What is in scope vs. out of scope?
- What are the relationships between elements?

**Expected Output:** Clear boundaries and component identification

### Specification Layer
**Purpose:** Nail down details

**Core Questions:**
- What are the specific requirements for [component]?
- What are the measurable criteria?
- What are the quality standards?

**Expected Output:** Concrete, measurable specifications

### Boundary Layer
**Purpose:** Explore limits and edge cases

**Core Questions:**
- What happens when [edge case]?
- What are the constraints or limitations?
- What are the failure scenarios?

**Expected Output:** Edge case handling defined

### Validation Layer
**Purpose:** Confirm understanding

**Core Questions:**
- Let me confirm: you're saying that [summary]?
- Is it correct to assume [assumption]?
- Have I missed anything important?

**Expected Output:** Validated understanding, corrections applied

## Adaptive Behavior

- If answers reveal new ambiguities → add to question queue
- If answers contradict earlier information → flag for resolution
- If answers are themselves vague → request clarification
- If user indicates uncertainty → note as UNKNOWN for later

## Documentation During Interrogation

For each Q&A cycle, capture:
- Question asked
- Answer received
- Implications derived
- New questions spawned
- Assumptions validated/invalidated

## Completion Criteria

- [ ] Foundation layer questions addressed
- [ ] Structural layer questions addressed
- [ ] Specification layer questions addressed
- [ ] Boundary layer questions addressed
- [ ] Validation layer questions addressed
- [ ] All P0/P1 gaps resolved or marked UNKNOWN
- [ ] Ready for specification construction

## User Questions Output Format

When you need user input, add this to your memory file as Section 4:

```json
{
  "clarification_required": true,
  "questions": [
    {
      "id": "Q1",
      "priority": "P0",
      "layer": "foundation",
      "question": "What is the primary goal you're trying to achieve?",
      "context": "Understanding the fundamental objective helps guide all subsequent decisions",
      "options": ["Option A description", "Option B description"],
      "default": null,
      "multi_select": false
    }
  ],
  "blocking": true
}
```

**Field Descriptions:**
- `id`: Unique identifier (Q1, Q2, etc.)
- `priority`: P0 (blocking), P1 (important), P2 (nice-to-have)
- `layer`: Which interrogation layer (foundation, structural, specification, boundary, validation)
- `question`: The actual question text
- `context`: Why this question matters (helps user understand)
- `options`: Array of possible answers (optional - for structured choices)
- `default`: Suggested default answer (optional)
- `multi_select`: Whether multiple options can be selected (default: false)
- `blocking`: If true, workflow pauses until answered
