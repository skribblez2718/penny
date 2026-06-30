# Ambiguity Categories Reference

The 5 categories of ambiguity to check during the SURFACE step of the Before Responding protocol (RESTATE/IDENTIFY/LIST/SURFACE/FLAG).

When executing SURFACE (assumptions and unknowns), scan for unresolved items in each category:

| Category          | What to Check                                                       | Examples                                                                 |
| ----------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| **Scope**         | Boundaries unclear, scale undefined, priorities unstated            | "Fix the bug" → which bug? what scope? "Improve performance" → how much? |
| **Intent**        | Multiple interpretations possible, success criteria missing         | "Make it better" → better how? "Clean up the code" → refactor or delete? |
| **Context**       | Domain knowledge gaps, audience unclear, environment undefined      | "Update the API" → which consumers? what version?                        |
| **Specification** | Vague terms, undefined parameters, missing edge cases               | "Handle errors gracefully" → which errors? what counts as graceful?      |
| **Assumptions**   | Inferred requirements, technical assumptions, implicit expectations | "Deploy to production" → which environment? what approval needed?        |

## Bypass Phrases to Avoid

These phrases indicate the model is skipping verification:

| Bypass Phrase                            | What It Really Means                | What to Do Instead                      |
| ---------------------------------------- | ----------------------------------- | --------------------------------------- |
| "No critical ambiguities detected"       | "I didn't look hard enough"         | Explicitly list what was checked        |
| "Assuming standard interpretation"       | "I'm guessing"                      | Ask the user to confirm                 |
| "Proceeding with reasonable assumptions" | "I'm filling gaps with probability" | State each assumption explicitly        |
| "No ambiguities detected — proceeding"   | "I skipped the MAP step"            | Scan all 5 categories before proceeding |

## Clarification Protocol

When ambiguity is found:

1. **Identify the category** — which of the 5 areas does it fall in?
2. **Formulate a targeted question** — specific, not open-ended
3. **Explain what's at stake** — what could go wrong if resolved incorrectly
4. **Suggest default if appropriate** — "If unclear, I'll assume X"

This reference is Domain Guidance content — available when needed, not burned into every interaction.
