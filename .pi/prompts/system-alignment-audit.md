Audit the entire "penny" project in this workspace and produce a structured system-alignment report. This is a read-only analysis — do not modify any files.

**Step 1 — Determine the system's goal.** Examine the project holistically and characterize, in your own words, the ultimate purpose the penny system is built to accomplish, based on evidence found in the project files. If the goal is not apparent from the files, or if any material ambiguity remains, stop and ask me targeted questions (no more than 5) rather than guessing. Do not invent a goal.

**Step 2 — Audit every component below.** For each, examine its actual content and classify it as ALIGNED (pulls toward the goal), MISALIGNED (works against the goal), or NEUTRAL/UNKNOWN, with a one-line justification citing the specific file(s) examined:

- Prompt Architecture: SYSTEM.md, .pi/agents/_.md agent definitions, and .pi/skills/<skill>/assets/_.md domain guidance
- AGENTS.md index tree implementation and content
- Knowledge base
- Universal agents in .pi/agents
- Universal skills in .pi/skills
- docs/humans, docs/agents, docs/penny, and README
- Extensions in .pi/extensions
- Hooks
- Observability
- Orchestration
- scripts/\*
- Compliance with Pi standards and how things should be implemented, including configurations

**Step 3 — Deliver a structured report with these sections:**

1. **Stated goal** — the goal determined in Step 1, with the evidence it is based on.
2. **Aligned components** — components pulling toward the goal, each with a one-line justification.
3. **Misaligned components** — components working against the goal, each with a specific, concrete issue and why it conflicts. Do not fabricate issues and do not nitpick trivial items; report only genuine conflicts.
4. **Recommendations** — for each misaligned component, one concrete change that would bring it into alignment.

**Completion criteria:**

- Every component listed above is examined and classified; none are skipped.
- Each classification cites the specific file(s) it is based on.
- If a listed component does not exist, state that explicitly rather than assuming it is aligned.
- If no genuine misalignments exist, state plainly that no issues were found — do not manufacture problems to fill the report.
- Mark any claim you cannot verify from the files as [UNVERIFIED] rather than asserting it.
