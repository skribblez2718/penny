# KNOWLEDGE TRANSFER CHECKPOINT

Final check before execution - validate routing decision and resolve any remaining ambiguity.

## ROUTING VALIDATION LOOP

This is iteration **{iteration}** of the routing validation loop (max 3).

**Review the preliminary route from Step 4:** `{preliminary_route}`

## CRITICAL DECISION POINT

Make ONE of these decisions:

### OPTION A: CONTRADICTION DETECTED → Loop Back to Step 4

If your analysis in Steps 5-7 **contradicts** the routing decision from Step 4:
- Evidence from self-consistency check conflicts with the chosen route
- Socratic interrogation revealed flawed assumptions
- Constitutional critique identified misalignment with task requirements

**Action:** Loop back to Step 4 for re-evaluation (if iterations remain).

### OPTION B: HALT FOR CLARIFICATION

If **ANY** ambiguity, vagueness, or uncertainty exists that cannot be resolved:
- Requirements remain unclear after validation
- Multiple valid interpretations persist
- User input required to proceed confidently

**Action:** HALT and execute the Knowledge Transfer Checklist below.

### OPTION C: PROCEED TO EXECUTION

If all requirements are clear and the routing decision is **validated**:
- Steps 5-7 confirmed the routing decision
- Confidence level is CERTAIN or PROBABLE
- First-attempt success is likely

**Action:** Capture final routing and proceed to execution.

---

## Knowledge Transfer Checklist (MANDATORY)

### SHARE: What I know that you may not know

Proactively share:
- Relevant context from previous interactions
- Technical constraints or requirements
- Common pitfalls for this task type
- Assumptions that might not be obvious

### PROBE: What you know that I don't know

Questions to ask:
- Specific requirements not yet clarified
- Constraints or preferences not mentioned
- Success criteria and acceptance tests
- Priorities when trade-offs are needed

### MAP: Our collective blind spots

Identify:
- What aspects remain uncertain?
- What could go wrong that we haven't discussed?
- What edge cases need consideration?
- What assumptions haven't been validated?

### DELIVER: Concise questions with ALL critical context

When asking clarification questions:
- **Maximum 5 questions, prioritized by importance**
- **Each question must advance clarity toward execution**
- Include context so the user understands why you're asking
- Offer reasonable defaults where appropriate

---

## HALT CONDITIONS

**HALT execution and request clarification if:**
- Success criteria are undefined
- Multiple valid interpretations exist
- Risk of incorrect first attempt is high
- User preferences significantly affect approach
- Assumptions could lead to wasted effort

**PROCEED with execution if:**
- Requirements are clear and unambiguous
- Approach has been validated through Steps 1-7
- Confidence level is CERTAIN or PROBABLE
- First-attempt success is likely

## Output Requirements

After processing this step, make your decision explicit:

**If LOOPING BACK (OPTION A):**
- State clearly: "CONTRADICTION DETECTED - looping back to Step 4"
- Explain what contradiction was found
- The system will automatically return to Step 4

**If HALTING (OPTION B):**
- State clearly: "HALTING FOR CLARIFICATION"
- Present clarification questions using SHARE/PROBE/MAP/DELIVER framework
- Explain why clarification is needed
- Await user response before proceeding

**If PROCEEDING (OPTION C):**
- State clearly: "ROUTING VALIDATED - proceeding to execution"
- Confirm the final routing decision: `{preliminary_route}`
- State confidence level: CERTAIN or PROBABLE
- The system will capture final routing and proceed to execution
