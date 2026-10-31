# Ambiguity Categories Reference

Common kinds of ambiguity to weigh under the frame's Work Policy. These are recurring
examples, **not an exhaustive checklist to sweep**. Infer low-risk details when reasonable
and state material assumptions. Clarify unresolved information that could materially change
the result, scope, authorization, or risk. When blocking ambiguity activates the on-demand
clarification protocol, resolve it through the protocol index; this reference does not
activate that procedure by itself.

Relevant unresolved items may include:

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
- **Clarify before acting on a material guess** about result, scope, authorization, or risk.
  Reversibility alone does not authorize an external, costly, credential-related, or
  sensitive-data action; obtain explicit approval unless the exact action/scope is authorized.

A hand-wavy pass ("assuming standard interpretation", "proceeding with reasonable assumptions") is a skipped pass — the reviewer/verifier treats it as one regardless of wording.

## What a good clarification contains

Name the unresolved item, ask a targeted question, and explain the stakes if it is resolved
incorrectly. Offer a default only when the assumption is low-risk and does not decide
authorization or material scope. “Just proceed” does not authorize irreversible guesses.

This reference is Domain Guidance content — available when needed, not burned into every interaction.
