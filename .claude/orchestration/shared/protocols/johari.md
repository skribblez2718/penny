# Johari Window Discovery Protocol

Execute discovery phase to transform unknown unknowns into known knowns.

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

## CRITICAL RULE: Question Documentation for Subagents

**If ANY clarifying questions exist:**

### Subagent Limitation
As a subagent, you **CANNOT** invoke `AskUserQuestion` directly. Instead:

1. **Document all questions** in memory file Section 4 (User Questions)
2. **Set flag:** `clarification_required: true`
3. **Return your output** - the main orchestrator will present questions to user

### Memory File Section 4 Format

```json
{
  "clarification_required": true,
  "questions": [
    {
      "id": "Q1",
      "priority": "P0",
      "question": "Clear question text ending with ?",
      "context": "Why this question matters",
      "options": ["Option A", "Option B"],
      "default": "Option A",
      "multi_select": false
    }
  ],
  "blocking": true
}
```

### Priority Levels
- **P0:** Blocking - cannot proceed without answer
- **P1:** Important - significantly affects approach
- **P2:** Clarifying - refines understanding but can assume default

**DO NOT PROCEED** to next step with unresolved P0 questions. Document them and let the main orchestrator handle user interaction.
