# Ambiguity Categories Reference

Common kinds of ambiguity to weigh during the SURFACE step of the on-demand clarification protocol (RESTATE/IDENTIFY/LIST/SURFACE/FLAG — `docs/penny/clarification-protocol.md`, activated via the frame's Ask vs. Act section). These are recurring examples, **not an exhaustive checklist to sweep** — use judgment about which apply.

When executing SURFACE (assumptions and unknowns), look for unresolved items like:

| Category          | What to Check                                                       | Examples                                                                 |
| ----------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| **Scope**         | Boundaries unclear, scale undefined, priorities unstated            | "Fix the bug" → which bug? what scope? "Improve performance" → how much? |
| **Intent**        | Multiple interpretations possible, success criteria missing         | "Make it better" → better how? "Clean up the code" → refactor or delete? |
| **Context**       | Domain knowledge gaps, audience unclear, environment undefined      | "Update the API" → which consumers? what version?                        |
| **Specification** | Vague terms, undefined parameters, missing edge cases               | "Handle errors gracefully" → which errors? what counts as graceful?      |
| **Assumptions**   | Inferred requirements, technical assumptions, implicit expectations | "Deploy to production" → which environment? what approval needed?        |

## What a real clarification pass shows

A clarification pass is judged by evidence, not by phrasing — a banned-phrase list catches nothing, since an evasive skip is trivially paraphrased. Require the outcome instead:

- **State what was checked.** Name the specific inputs and assumptions examined, not "no ambiguities detected."
- **Surface each unresolved assumption explicitly** rather than folding gaps into "reasonable assumptions."
- **Confirm before acting on a guess** when an unresolved item is a BLOCKER or the action is irreversible.

A hand-wavy pass ("assuming standard interpretation", "proceeding with reasonable assumptions") is a skipped pass — the reviewer/verifier treats it as one regardless of wording.

## What a good clarification contains

When ambiguity is found, a good clarification names the specific unresolved item, asks a targeted (not open-ended) question, makes the stakes explicit (what goes wrong if resolved incorrectly), and offers a default where one is reasonable ("if unclear, I'll assume X"). The decision rule is the protocol's: ask when an unresolved item is a BLOCKER or the action is irreversible — otherwise proceed on the stated default.

This reference is Domain Guidance content — available when needed, not burned into every interaction.
