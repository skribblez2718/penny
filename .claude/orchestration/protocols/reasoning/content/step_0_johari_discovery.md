# JOHARI WINDOW DISCOVERY

Execute at the START of every interaction to transform unknown unknowns into known knowns.

---

## SHARE (What I can infer from the prompt)

- **Task type and domain:** Technical / personal / creative / professional / recreational
- **Complexity level:** What reasoning requirements does this task demand?
- **Common pitfalls:** What typically goes wrong with this prompt category?
- **Best practices:** What approaches work well from similar use cases?
- **Critical design decisions:** What choices will significantly affect the outcome?

## ASK (What I need to know - MAX 5 questions, only if critical)

Ask ONLY when essential information is missing:

**Required:**
- Task domain and primary objectives
- Success criteria - how will we know this is done correctly?

**Contextual:**
- Constraints that limit possible approaches
- User expertise level (affects explanation depth)
- Target audience (affects output style)

**Optional:**
- Output format preferences
- Specific examples of desired result

**Format:** ONE consolidated turn with all questions prioritized by importance

## ACKNOWLEDGE (Boundaries and assumptions)

- **Uncertain aspects:** What remains unclear even after analysis?
- **Default assumptions:** What will be assumed if proceeding without answers?
- **Risks of incomplete information:** What could go wrong if assumptions are incorrect?

## EXPLORE (Unknowns to consider)

- **Edge cases:** What unusual inputs could cause failure?
- **Alternative approaches:** What other ways could this be accomplished?
- **Failure modes:** What could go wrong that we haven't discussed?
- **Dependencies:** What external factors might affect success?

---

## CRITICAL RULE: MANDATORY AskUserQuestion INVOCATION

**If ANY clarifying questions exist, you MUST:**

1. **STOP** - Do not proceed to Step 1
2. **INVOKE AskUserQuestion tool** - Not just print questions as markdown
3. **WAIT** for user response before continuing

### AskUserQuestion Tool Format

When questions exist, invoke with this structure:

```
AskUserQuestion tool parameters:
{
  "questions": [
    {
      "question": "Clear, specific question ending with ?",
      "header": "Short label (max 12 chars)",
      "options": [
        {"label": "Option A", "description": "What this means"},
        {"label": "Option B", "description": "What this means"}
      ],
      "multiSelect": false
    }
  ]
}
```

**DO NOT:**
- Print questions as markdown and continue
- Assume answers to unresolved questions
- Proceed with Steps 1-8 until ALL questions are answered

---

## Output Requirements

After processing this step:

### If NO clarification needed:

1. **SHARE summary:** Key inferences about the task (2-4 bullet points)
2. **Assumptions:** What will be assumed during reasoning
3. **Blind spots identified:** Potential unknowns surfaced

State: "No critical ambiguities detected - proceeding to formal reasoning" and continue to Step 1.

### If clarification IS needed:

1. **SHARE summary:** Key inferences about the task (2-4 bullet points)
2. **HALT:** State "HALTING FOR CLARIFICATION"
3. **INVOKE AskUserQuestion tool** with your questions (max 5, prioritized by importance)
4. **WAIT** for user response - do NOT proceed to Step 1
